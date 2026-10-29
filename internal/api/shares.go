package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer"
	gmhtml "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/util"
)

// A share link is a public, revocable, read-only view of one conversation.
//
// The shape is deliberately small. The owner mints one link per task (minting
// again replaces it), hands the URL to whoever should read the thread, and can
// take it back at any moment. Nothing else about the daemon becomes public: the
// link resolves to one task's messages and nothing else in the database is
// reachable through it.
const (
	// shareMessageLimit bounds how much of a conversation one link renders. A
	// public page is not a mirror of the database, and an unbounded page is a
	// page a stranger can make expensive.
	shareMessageLimit = 800
	// shareEventLimit bounds the rows read to build that page: message events
	// only, but a very long session still has many of them. Reading one more
	// than the page can use is how the page knows its window was cut.
	shareEventLimit = 2000
	// shareMessageBytes bounds one line. A session that pipes a file through the
	// agent can produce a single message of any size, and the cap above counts
	// messages, not bytes.
	shareMessageBytes = 12 * 1024
	// shareTotalBytes bounds the whole page. The two caps above bound the count
	// and each line, so 800 messages of 12KB can still mean 9.6MB — enough for
	// an unauthenticated route to spend hundreds of milliseconds of CPU per
	// request rendering a conversation nobody reads to the end. A reader who
	// follows a link wants the recent turns: the budget is spent from the
	// newest message backwards.
	shareTotalBytes = 512 * 1024
	// shareRenderBytes bounds what one message may render to. Markdown grows —
	// tables, list markers and escaped HTML all add bytes — and nesting adds a
	// lot more: measured on this renderer, 500KB of nested blockquotes becomes
	// 6.8MB and a second of CPU. Past this the message is shown as its escaped
	// source instead, which also stops the conversion at the writer.
	shareRenderBytes = 64 * 1024
)

// shareVisibility is the audience metadata the daemon stamps on an event: which
// columns it was meant for. A message that is task-only is the machine talking
// to itself.
type shareVisibility struct {
	User *bool `json:"user"`
	Task *bool `json:"task"`
}

// shareMessage is one line of a shared transcript.
type shareMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
	TS   int64  `json:"ts,omitempty"`
	// Speaker names who answered, when it was not the task's own agent — a
	// worker in a team session. Empty means the agent named in the header.
	Speaker string `json:"speaker,omitempty"`
	// HTML is Text rendered for the page, filled by the page handler only — the
	// JSON endpoint publishes the source a caller can render however it likes.
	// It is trusted markup in the template sense: goldmark renders recognised
	// markdown, and everything else — raw HTML, images, destinations it refuses
	// — is written back as text by the renderers below.
	HTML template.HTML `json:"-"`
}

// shareView is what a link renders: the conversation, and just enough about the
// task to say what it is.
type shareView struct {
	Title     string         `json:"title"`
	Agent     string         `json:"agent"`
	Status    string         `json:"status"`
	CreatedAt int64          `json:"created_at"`
	Messages  []shareMessage `json:"messages"`
	Truncated bool           `json:"truncated,omitempty"`
}

// shareState is what the owner's console sees: whether a link exists, never the
// link itself. The token is returned once, when it is minted, and only its
// digest is kept — so a page reload cannot show the URL again.
type shareState struct {
	Active    bool  `json:"active"`
	CreatedAt int64 `json:"created_at,omitempty"`
	ExpiresAt int64 `json:"expires_at,omitempty"`
}

// shareTaskExists reports whether the task a share route names is real, writing
// the 404 itself when it is not. An unknown task and a task with no link are
// different answers: the first is a mistake in the URL, the second is a normal
// state.
func (s *Server) shareTaskExists(w http.ResponseWriter, r *http.Request, id string) bool {
	if _, err := s.Store.GetTask(r.Context(), id); errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return false
	} else if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return false
	}
	return true
}

// handleGetSessionShare reports whether this task currently has a live link.
func (s *Server) handleGetSessionShare(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !s.shareTaskExists(w, r, id) {
		return
	}
	share, ok, err := s.Store.ActiveSessionShare(r.Context(), id, time.Now().UnixMilli())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, http.StatusOK, shareState{})
		return
	}
	writeJSON(w, http.StatusOK, shareState{
		Active:    true,
		CreatedAt: share.CreatedAt,
		ExpiresAt: share.ExpiresAt,
	})
}

// handleCreateSessionShare mints a link and returns its token exactly once.
func (s *Server) handleCreateSessionShare(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !s.shareTaskExists(w, r, id) {
		return
	}

	// One live link per task, and replacing it is a single transaction: if the
	// insert fails, the link the owner still has keeps working.
	now := time.Now().UnixMilli()
	token, err := remote.NewSecret()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "generate share token"})
		return
	}
	hash := remote.HashToken(token)
	if err := s.Store.ReplaceSessionShare(r.Context(), store.SessionShare{
		ID:        "share-" + hash[:16],
		TaskID:    id,
		TokenHash: hash,
		CreatedAt: now,
	}); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"token":      token,
		"created_at": now,
		"expires_at": 0,
	})
}

// handleRevokeSessionShare takes the link back. Revoking when nothing is live is
// not an error: the caller wanted the link gone and it is gone.
func (s *Server) handleRevokeSessionShare(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !s.shareTaskExists(w, r, id) {
		return
	}
	revoked, err := s.Store.RevokeSessionShares(r.Context(), id, time.Now().UnixMilli())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": revoked})
}

// resolveShare maps a presented token to its live link.
func (s *Server) resolveShare(ctx context.Context, token string) (store.SessionShare, bool) {
	token = strings.TrimSpace(token)
	if token == "" {
		return store.SessionShare{}, false
	}
	share, ok, err := s.Store.SessionShareByTokenHash(ctx, remote.HashToken(token), time.Now().UnixMilli())
	if err != nil || !ok {
		return store.SessionShare{}, false
	}
	return share, true
}

// buildShareView assembles the transcript a link renders.
func (s *Server) buildShareView(ctx context.Context, taskID string) (shareView, error) {
	task, err := s.Store.GetTask(ctx, taskID)
	if err != nil {
		return shareView{}, err
	}
	events, err := s.Store.ListMessageEvents(ctx, taskID, shareEventLimit+1)
	if err != nil {
		return shareView{}, err
	}
	events, windowCut := shareWindow(events)
	messages, truncated := shareTranscript(events, task.Agent)
	if windowCut {
		// Turns are missing from the front even when the message cap was not
		// reached: a long session streams far more partials than messages.
		truncated = true
	}
	if len(messages) == 0 && strings.TrimSpace(task.Prompt) != "" {
		// Sessions written before message events were recorded still have the
		// prompt that created them, and a link that renders an empty page says
		// nothing at all. A prompt is unbounded — nothing on the create path
		// caps it — so it passes the same line clamp as a message, and it goes
		// through the budget below like any other line.
		messages = []shareMessage{{Role: "user", Text: clampShareText(strings.TrimSpace(task.Prompt))}}
	}
	messages, budgetCut := shareBudget(messages)
	if budgetCut {
		truncated = true
	}
	title := strings.TrimSpace(task.Title)
	if title == "" {
		title = firstLine(messages)
	}
	return shareView{
		Title:     title,
		Agent:     task.Agent,
		Status:    task.Status,
		CreatedAt: task.CreatedAt,
		Messages:  messages,
		Truncated: truncated,
	}, nil
}

// shareWindow trims a read of `shareEventLimit+1` rows back to the window, and
// reports whether the window was cut.
//
// One row over the limit is how the page knows it is missing the front of the
// conversation: without it, a long session would render its newest turns and
// claim to be complete. The extra row is dropped here so nothing older than the
// window is ever rendered.
func shareWindow(events []store.Event) ([]store.Event, bool) {
	if len(events) <= shareEventLimit {
		return events, false
	}
	return events[len(events)-shareEventLimit:], true
}

// shareBudget keeps the newest messages that fit in shareTotalBytes.
//
// It is the third side of the same box as the message and line caps: without
// it, a long session is a long page, and this page is rendered for whoever
// holds the link. The newest message is always kept, even if it alone is over
// budget — an empty page would answer the reader with nothing.
func shareBudget(messages []shareMessage) ([]shareMessage, bool) {
	total := 0
	keep := len(messages)
	for keep > 0 {
		next := len(messages[keep-1].Text)
		if total+next > shareTotalBytes && keep < len(messages) {
			break
		}
		total += next
		keep--
	}
	if keep == 0 {
		return messages, false
	}
	return messages[keep:], true
}

// shareTranscript reduces raw events to what a reader came for: what the person
// said, and what the agent answered.
//
// The audience rule is the console's own, and it is the reason this function is
// not simply "everything with text": a task log also carries the work of
// subagents and workers, which the console keeps out of the conversation (see
// `isUserFacingEvent` in ui/src/components/chat/transcriptProjection.ts).
// Publishing that would show a reader the inside of the machine, and show it
// under the main agent's name. Streamed partials are skipped because they
// repeat the final text, and only text blocks are kept, which is what drops the
// tool calls and tool results that travel on the same channel. Anything not
// recognised is left out rather than guessed at: publishing less than the owner
// sees is the safe direction for a page anyone with the URL can open.
func shareTranscript(events []store.Event, hostAgent string) ([]shareMessage, bool) {
	out := make([]shareMessage, 0, len(events))
	for _, ev := range events {
		if msg, ok := shareMessageOf(ev, hostAgent); ok {
			out = append(out, msg)
		}
	}
	// Over the cap, the oldest turns go: the tail of a conversation is what a
	// link was shared for, and the caller is told the front is missing.
	if len(out) > shareMessageLimit {
		return out[len(out)-shareMessageLimit:], true
	}
	return out, false
}

// shareMessageOf is one event's contribution to a shared transcript, or nothing
// when the console would not have shown it either.
func shareMessageOf(ev store.Event, hostAgent string) (shareMessage, bool) {
	var p struct {
		Role       string           `json:"role"`
		Speaker    string           `json:"speaker"`
		Agent      string           `json:"agent"`
		Source     string           `json:"source"`
		Partial    bool             `json:"partial"`
		Sidechain  bool             `json:"sidechain"`
		Text       string           `json:"text"`
		Content    json.RawMessage  `json:"content"`
		Visibility *shareVisibility `json:"visibility"`
	}
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		return shareMessage{}, false
	}
	if p.Partial || p.Sidechain {
		return shareMessage{}, false
	}
	speaker := shareSpeaker(p.Speaker, p.Agent, p.Source, p.Role, hostAgent)
	if !shareUserFacing(p.Source, p.Visibility, speaker, hostAgent) {
		return shareMessage{}, false
	}
	text := shareBlockText(p.Content)
	if text == "" {
		text = strings.TrimSpace(p.Text)
	}
	if text == "" {
		return shareMessage{}, false
	}
	msg := shareMessage{Role: "assistant", Text: clampShareText(text), TS: ev.TS}
	if speaker == "user" {
		msg.Role = "user"
	} else if !isHostSpeaker(speaker, hostAgent) && speaker != "assistant" {
		// A worker's line keeps its own name; the header names the main agent.
		msg.Speaker = speaker
	}
	return msg, true
}

// shareSpeaker resolves who said a message, in the console's order: an explicit
// speaker or agent, then the role, then a `source` that is not a control-plane
// label. The last fallback is the host agent, because an unlabelled message in
// a task is the host's.
func shareSpeaker(speaker, agent, source, role, hostAgent string) string {
	for _, raw := range []string{speaker, agent} {
		if s := strings.TrimSpace(raw); s != "" {
			return s
		}
	}
	if role == "user" {
		return "user"
	}
	if s := strings.TrimSpace(source); s != "" && !controlSourceLabels[s] {
		return s
	}
	if hostAgent != "" {
		return hostAgent
	}
	return "assistant"
}

// shareUserFacing is the console's audience decision, in its order: the
// orchestrator's own words are always for the reader; then an explicit
// `visibility.user` decides; then the speaker does, with historical worker rows
// (a speaker that is neither the person, the host, nor the generic "assistant")
// treated as task-only.
func shareUserFacing(source string, visibility *shareVisibility, speaker, hostAgent string) bool {
	switch source {
	case "orchestrator", "delegate":
		return true
	}
	if visibility != nil && (visibility.User != nil || visibility.Task != nil) {
		// A half-written object is read the console's way: a missing `user` is
		// false, so `{"task": true}` alone is task-only.
		return visibility.User != nil && *visibility.User
	}
	if speaker == "user" || isHostSpeaker(speaker, hostAgent) {
		return true
	}
	return speaker == "" || speaker == "assistant"
}

// isHostSpeaker reports whether a speaker is the host column's own voice: the
// product name (legacy rows), the host agent, or the orchestrator speaking for
// it. The console's `isHostVoice`.
func isHostSpeaker(speaker, hostAgent string) bool {
	return speaker == "kin" || (hostAgent != "" && speaker == hostAgent) || speaker == "orchestrator"
}

// controlSourceLabels are transport labels that must never become a speaker —
// the console's CONTROL_SOURCE_LABELS.
var controlSourceLabels = map[string]bool{
	"follow_up":    true,
	"create":       true,
	"orchestrator": true,
	"delegate":     true,
	"host":         true,
	"user":         true,
	"system":       true,
	"assistant":    true,
}

// clampShareText bounds one line so a session that piped a file through the
// agent cannot make an anonymous page arbitrarily large.
func clampShareText(text string) string {
	if len(text) <= shareMessageBytes {
		return text
	}
	// The ellipsis is part of the bound, not an addition to it: a cap that can
	// be exceeded by three bytes is not a cap.
	const ellipsis = "…"
	limit := shareMessageBytes - len(ellipsis)
	// Runes, not bytes: cutting in the middle of a character would be the one
	// thing this page renders badly.
	var b strings.Builder
	for _, r := range text {
		if b.Len()+utf8.RuneLen(r) > limit {
			break
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String()) + ellipsis
}

// shareBlockText joins the text blocks of one message. Blocks of any other kind
// are dropped: a tool call has no text, and a tool echo carries its payload in
// `content`, not `text`.
func shareBlockText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	// `content` is normally a blocks array, but a string is a shape older rows
	// and some adapters use.
	var flat string
	if err := json.Unmarshal(raw, &flat); err == nil {
		return strings.TrimSpace(flat)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var b strings.Builder
	for _, blk := range blocks {
		if blk.Type != "" && blk.Type != "text" {
			continue
		}
		if strings.TrimSpace(blk.Text) == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString(blk.Text)
	}
	return strings.TrimSpace(b.String())
}

func firstLine(messages []shareMessage) string {
	for _, m := range messages {
		if m.Role != "user" {
			continue
		}
		line := strings.TrimSpace(strings.SplitN(m.Text, "\n", 2)[0])
		if line != "" {
			return truncateRunes(line, 80)
		}
	}
	return ""
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return strings.TrimSpace(string(runes[:max])) + "…"
}

// handlePublicShareJSON serves the transcript to whoever holds the link.
func (s *Server) handlePublicShareJSON(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	share, ok := s.resolveShare(r.Context(), chi.URLParam(r, "token"))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	view, err := s.buildShareView(r.Context(), share.TaskID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "share unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// handlePublicSharePage renders the same transcript as a plain page, so the
// link opens in any browser without the console, a login, or JavaScript.
func (s *Server) handlePublicSharePage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	// The page is one inline stylesheet and nothing else. `default-src 'none'`
	// says so out loud: whatever an agent managed to write into a message, the
	// document cannot fetch, frame, submit or execute anything.
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	share, ok := s.resolveShare(r.Context(), chi.URLParam(r, "token"))
	var view shareView
	if ok {
		var err error
		view, err = s.buildShareView(r.Context(), share.TaskID)
		if errors.Is(err, store.ErrNotFound) {
			ok = false
		} else if err != nil {
			http.Error(w, "share unavailable", http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	words := shareStringsFor(r.Header.Get("Accept-Language"))
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		_ = sharePageTemplate.Execute(w, sharePageData{S: words, Missing: true})
		return
	}
	for i := range view.Messages {
		view.Messages[i].HTML = shareHTML(view.Messages[i].Text)
	}
	_ = sharePageTemplate.Execute(w, sharePageData{S: words, View: view, When: shareWhen(view.CreatedAt)})
}

// shareMarkdown renders a message the way the console showed it. Without it a
// shared link reads as source: `**done**`, a wall of triple backticks, and
// tables as pipe characters — the reader sees the markup, not the answer.
var shareMarkdown = goldmark.New(
	goldmark.WithExtensions(extension.GFM, shareRawHTML{}),
	// A shared transcript is prose someone typed, not a document: one newline
	// is a line break. This matches the console, whose paragraphs keep their
	// newlines, so the link reads the way the conversation did.
	goldmark.WithRendererOptions(gmhtml.WithHardWraps()),
)

// shareRawHTML shows raw HTML as text instead of dropping it.
//
// goldmark's default is to leave a `<!-- raw HTML omitted -->` comment, which
// is safe but silently eats content — and a coding agent writes `<div>` and
// `<script>` for a living, so the reader would see a sentence with a hole in
// it. The console escapes these too: what the agent wrote is what the reader
// reads, drawn as characters and never as markup.
type shareRawHTML struct{}

func (shareRawHTML) Extend(m goldmark.Markdown) {
	m.Renderer().AddOptions(renderer.WithNodeRenderers(
		util.Prioritized(shareRawHTML{}, 100),
	))
}

func (shareRawHTML) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(ast.KindHTMLBlock, shareEscapeRawHTML)
	reg.Register(ast.KindRawHTML, shareEscapeRawHTML)
	reg.Register(ast.KindImage, shareLiteralImage)
}

// shareLiteralImage shows an image as the markdown that asked for it.
//
// The console renders no images — an `![…](…)` in a message stays text there —
// and a page that fetched every image an agent printed would make each reader's
// browser call a host the agent chose: a read receipt at worst, a blind GET
// into the reader's own network at best. The alt text and the URL stay
// readable; nothing is requested.
func shareLiteralImage(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if entering {
		n := node.(*ast.Image)
		_, _ = w.WriteString("![")
		_, _ = w.Write(util.EscapeHTML(n.Text(source)))
		_, _ = w.WriteString("](")
		_, _ = w.Write(util.EscapeHTML(n.Destination))
		_, _ = w.WriteString(")")
	}
	return ast.WalkSkipChildren, nil
}

func shareEscapeRawHTML(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	write := func(b []byte) {
		_, _ = w.WriteString(template.HTMLEscapeString(string(b)))
	}
	switch n := node.(type) {
	case *ast.HTMLBlock:
		for i := 0; i < n.Lines().Len(); i++ {
			seg := n.Lines().At(i)
			write(seg.Value(source))
		}
		if n.HasClosure() {
			seg := n.ClosureLine
			write(seg.Value(source))
		}
	case *ast.RawHTML:
		for i := 0; i < n.Segments.Len(); i++ {
			seg := n.Segments.At(i)
			write(seg.Value(source))
		}
	}
	return ast.WalkContinue, nil
}

// shareRenderLimit is a writer that refuses to grow past its limit.
//
// Refusing, rather than truncating, is the point: goldmark stops converting as
// soon as the writer returns an error, so a message built to expand costs the
// parse of its own bytes and nothing more.
type shareRenderLimit struct {
	buf   bytes.Buffer
	limit int
}

var errShareRenderLimit = errors.New("share render limit")

func (w *shareRenderLimit) Write(p []byte) (int, error) {
	if w.buf.Len()+len(p) > w.limit {
		return 0, errShareRenderLimit
	}
	return w.buf.Write(p)
}

// shareHTML renders one message for the public page.
//
// The trust boundary is goldmark's parser plus the renderers above: every byte
// of agent output either becomes recognised markdown, gets written back as
// text, or is a destination goldmark refuses to link. Nothing a message
// contains can make the page fetch, frame or execute anything — the renderers
// remove the fetches, and the page's own CSP says the rest.
func shareHTML(text string) template.HTML {
	w := &shareRenderLimit{limit: shareRenderBytes}
	if err := shareMarkdown.Convert([]byte(text), w); err != nil || w.buf.Len() == 0 {
		// Rendering is best-effort: an empty, oversized or failed conversion
		// must not eat the message the owner meant to publish, so the reader
		// gets the text the renderer would have started from.
		return template.HTML(template.HTMLEscapeString(text))
	}
	return template.HTML(w.buf.String())
}

// shareStrings are the words around a shared conversation. The conversation is
// published as written; only the page's own chrome follows the reader's
// language, guessed from `Accept-Language` because a reader who follows a link
// has no other way to say who they are.
type shareStrings struct {
	Lang         string
	You          string
	ReadOnly     string
	Truncated    string
	Footer       string
	MissingTitle string
	MissingBody  string
	DocMissing   string
}

var (
	shareStringsEN = shareStrings{
		Lang:         "en",
		You:          "You",
		ReadOnly:     "read-only",
		Truncated:    "This transcript was truncated for sharing.",
		Footer:       "Shared from Kin. Anyone with this link can read this conversation.",
		MissingTitle: "This link is no longer available",
		MissingBody:  "The person who shared it has revoked it, or it has expired.",
		DocMissing:   "Link unavailable",
	}
	shareStringsZH = shareStrings{
		Lang:         "zh-Hans",
		You:          "你",
		ReadOnly:     "只读",
		Truncated:    "分享的对话已截断。",
		Footer:       "由 Kin 分享。任何拿到此链接的人都能阅读这段对话。",
		MissingTitle: "此链接已失效",
		MissingBody:  "分享者已撤销该链接，或链接已过期。",
		DocMissing:   "链接不可用",
	}
)

// shareStringsFor picks the page's language from one `Accept-Language` header.
// Only the first usability-ranked entry decides: the page is one language, and
// a half-translated page is worse than a page in the wrong language.
func shareStringsFor(header string) shareStrings {
	for _, part := range strings.Split(header, ",") {
		tag := strings.TrimSpace(part)
		if tag == "" {
			continue
		}
		if i := strings.IndexByte(tag, ';'); i >= 0 {
			params := tag[i+1:]
			tag = strings.TrimSpace(tag[:i])
			// `q=0` means "not acceptable", not "least preferred".
			if q, ok := strings.CutPrefix(strings.TrimSpace(params), "q="); ok {
				if v, err := strconv.ParseFloat(strings.TrimSpace(q), 64); err == nil && v == 0 {
					continue
				}
			}
		}
		if tag == "*" {
			break
		}
		if strings.HasPrefix(strings.ToLower(tag), "zh") {
			return shareStringsZH
		}
		return shareStringsEN
	}
	return shareStringsEN
}

type sharePageData struct {
	S       shareStrings
	View    shareView
	When    string
	Missing bool
}

func shareWhen(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02 15:04 UTC")
}

// sharePageTemplate is deliberately standalone: no bundle, no fonts to fetch,
// no script. A shared link should read the same in five years.
var sharePageTemplate = template.Must(template.New("share").Parse(`<!doctype html>
<html lang="{{.S.Lang}}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<title>{{if .Missing}}{{.S.DocMissing}}{{else}}{{.View.Title}}{{end}} · Kin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d0f12; color: #e6e8eb;
         font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 32px 20px 64px; }
  header { border-bottom: 1px solid #24282e; padding-bottom: 16px; margin-bottom: 28px; }
  h1 { font-size: 20px; line-height: 1.35; margin: 0 0 6px; font-weight: 600; }
  .meta { color: #8a919b; font-size: 13px; }
  .turn { margin: 0 0 22px; }
  .who { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: #8a919b; margin-bottom: 4px; }
  .turn.user .who { color: #7aa2f7; }
  .body { overflow-wrap: anywhere; }
  .body > :first-child { margin-top: 0; }
  .body > :last-child { margin-bottom: 0; }
  .body p { margin: 0 0 10px; }
  .body h1, .body h2, .body h3, .body h4 { font-size: 16px; margin: 16px 0 8px; font-weight: 600; }
  .body ul, .body ol { margin: 8px 0; padding-left: 22px; }
  .body li { margin: 2px 0; }
  .body blockquote { margin: 10px 0; padding-left: 12px; border-left: 2px solid #2f3540; color: #b6bcc5; }
  .body code { background: #11151b; border-radius: 4px; padding: 1px 5px;
               font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .body pre { background: #11151b; border: 1px solid #24282e; border-radius: 8px;
              padding: 10px 12px; margin: 10px 0; overflow-x: auto; }
  .body pre code { background: none; padding: 0; }
  .body a { color: #7aa2f7; }
  .body hr { border: 0; border-top: 1px solid #24282e; margin: 14px 0; }
  .body table { display: block; overflow-x: auto; border-collapse: collapse; margin: 10px 0; }
  .body th, .body td { border: 1px solid #24282e; padding: 5px 8px; text-align: left; }
  .turn.user .body { padding: 10px 14px; border-radius: 10px; background: #161a20; }
  footer { margin-top: 40px; color: #6b727c; font-size: 12px; border-top: 1px solid #24282e; padding-top: 16px; }
  .empty { color: #8a919b; }
</style>
</head>
<body>
<main>
{{if .Missing}}
  <h1>{{.S.MissingTitle}}</h1>
  <p class="empty">{{.S.MissingBody}}</p>
{{else}}
  <header>
    <h1>{{.View.Title}}</h1>
    <div class="meta">{{.View.Agent}}{{if .When}} · {{.When}}{{end}} · {{.S.ReadOnly}}</div>
  </header>
  {{range .View.Messages}}
  <div class="turn {{.Role}}">
    <div class="who">{{if eq .Role "user"}}{{$.S.You}}{{else}}{{if .Speaker}}{{.Speaker}}{{else}}{{$.View.Agent}}{{end}}{{end}}</div>
    <div class="body">{{.HTML}}</div>
  </div>
  {{end}}
  {{if .View.Truncated}}<p class="empty">{{.S.Truncated}}</p>{{end}}
  <footer>{{.S.Footer}}</footer>
{{end}}
</main>
</body>
</html>
`))
