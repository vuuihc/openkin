package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

// A share link is the one thing this daemon publishes to people who have no
// account on it, so what it renders is pinned here: the conversation, and only
// the conversation.

func shareRequest(t *testing.T, s *Server, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	s.Handler().ServeHTTP(rr, req)
	return rr
}

// shareTestTask seeds a task with the event shapes a real session produces:
// a user prompt, a streamed partial, the final answer, a subagent sidechain,
// a tool call, and a tool echo dressed as a user message.
func shareTestTask(t *testing.T, s *Server, id string) {
	t.Helper()
	if err := s.Store.InsertTask(context.Background(), store.Task{
		ID: id, Title: "Fix the build", Agent: "claude-code", Cwd: "/work/app",
		Prompt: "please fix", Status: "finished", CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	events := []string{
		`{"role":"user","speaker":"user","partial":false,"content":[{"type":"text","text":"fix the build"}]}`,
		`{"role":"assistant","partial":true,"content":[{"type":"text","text":"Look"}]}`,
		`{"role":"assistant","speaker":"claude-code","partial":false,"content":[{"type":"text","text":"Looking at it now."}]}`,
		`{"role":"assistant","sidechain":true,"partial":false,"content":[{"type":"text","text":"subagent chatter"}]}`,
		`{"role":"assistant","partial":false,"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Fixed."}]}`,
		`{"role":"user","speaker":"claude-code","partial":false,"content":[{"content":"tool echo with file contents"}]}`,
		// The shapes that carry a worker's work: stamped task-only, or old
		// enough to predate the field and identifiable only by its speaker.
		`{"role":"assistant","speaker":"grok","partial":false,"visibility":{"user":false,"task":true},"content":[{"type":"text","text":"worker output"}]}`,
		`{"role":"assistant","speaker":"grok","partial":false,"visibility":{"task":true},"content":[{"type":"text","text":"half-written visibility"}]}`,
		`{"role":"assistant","speaker":"grok","partial":false,"content":[{"type":"text","text":"legacy worker output"}]}`,
		// A worker the console does show keeps its own name.
		`{"role":"assistant","speaker":"grok","partial":false,"visibility":{"user":true,"task":true},"content":[{"type":"text","text":"worker speaking to the room"}]}`,
	}
	for _, payload := range events {
		if _, err := s.Store.AppendEvent(context.Background(), id, "message", json.RawMessage(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Store.AppendEvent(context.Background(), id, "tool_use", json.RawMessage(`{"name":"Bash"}`)); err != nil {
		t.Fatal(err)
	}
}

func createShare(t *testing.T, s *Server, taskID, token string) string {
	t.Helper()
	rr := shareRequest(t, s, http.MethodPost, "/api/tasks/"+taskID+"/share", token)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create share: %d %s", rr.Code, rr.Body.String())
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Token) < 32 {
		t.Fatalf("token %q is too short to be unguessable", body.Token)
	}
	return body.Token
}

func TestShareLinkPublishesOnlyTheConversation(t *testing.T) {
	s, token := newTestServer(t)
	shareTestTask(t, s, "task-share")
	link := createShare(t, s, "task-share", token)

	rr := shareRequest(t, s, http.MethodGet, "/api/public/shares/"+link, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("public share: %d %s", rr.Code, rr.Body.String())
	}
	var view shareView
	if err := json.Unmarshal(rr.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	want := []shareMessage{
		{Role: "user", Text: "fix the build"},
		{Role: "assistant", Text: "Looking at it now."},
		{Role: "assistant", Text: "Fixed."},
		{Role: "assistant", Text: "worker speaking to the room", Speaker: "grok"},
	}
	if len(view.Messages) != len(want) {
		t.Fatalf("messages = %+v, want %d", view.Messages, len(want))
	}
	for i, m := range want {
		if view.Messages[i].Role != m.Role || view.Messages[i].Text != m.Text {
			t.Fatalf("message %d = %+v, want %+v", i, view.Messages[i], m)
		}
	}
	if view.Title != "Fix the build" || view.Agent != "claude-code" {
		t.Fatalf("view = %+v", view)
	}

	// The same content as a page anyone can open, with no login and no script.
	page := shareRequest(t, s, http.MethodGet, "/s/"+link, "")
	if page.Code != http.StatusOK {
		t.Fatalf("public page: %d", page.Code)
	}
	html := page.Body.String()
	for _, want := range []string{"Fix the build", "Looking at it now.", "Fixed."} {
		if !strings.Contains(html, want) {
			t.Fatalf("page is missing %q", want)
		}
	}
	for _, unwanted := range []string{
		"subagent chatter", "tool echo", "Bash",
		"worker output", "half-written visibility", "legacy worker output",
	} {
		if strings.Contains(html, unwanted) {
			t.Fatalf("page leaked %q", unwanted)
		}
	}
	// A worker the console does show is named as itself, not as the main agent.
	if !strings.Contains(html, ">grok<") {
		t.Fatal("the visible worker's name is missing from the page")
	}
}

func TestSharePageEscapesMessageText(t *testing.T) {
	s, token := newTestServer(t)
	if err := s.Store.InsertTask(context.Background(), store.Task{
		ID: "task-xss", Title: "<b>bold</b>", Agent: "kin", Cwd: "/tmp",
		Prompt: "p", Status: "finished", CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.AppendEvent(context.Background(), "task-xss", "message",
		json.RawMessage(`{"role":"assistant","partial":false,"content":[{"type":"text","text":"<script>alert(1)</script>"}]}`),
	); err != nil {
		t.Fatal(err)
	}
	link := createShare(t, s, "task-xss", token)

	page := shareRequest(t, s, http.MethodGet, "/s/"+link, "")
	html := page.Body.String()
	if strings.Contains(html, "<script>alert(1)</script>") {
		t.Fatal("message text was rendered as markup")
	}
	if !strings.Contains(html, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Fatalf("escaped text missing from page: %s", html)
	}
}

// A shared link is read by a person, not parsed. An answer written in markdown
// has to arrive as an answer — bold, code, lists — while the agent's own HTML
// arrives as the characters it typed: visible, never executed, never silently
// dropped.
func TestSharePageRendersMarkdownButNeverMarkup(t *testing.T) {
	s, token := newTestServer(t)
	if err := s.Store.InsertTask(context.Background(), store.Task{
		ID: "task-md", Title: "md", Agent: "kin", Cwd: "/tmp",
		Prompt: "p", Status: "finished", CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	messages := []string{
		"**done**\n\n```go\nfmt.Println(\"hi\")\n```\n\n- one\n- two",
		`inline <script>alert(1)</script> and <img src=x onerror=alert(2)>`,
		`[click](javascript:alert(3)) and [docs](https://kin.example.com/docs)`,
		// A single newline is a line break, GFM tables work, and an image stays
		// the markdown that asked for it rather than a request the reader's
		// browser makes to a host the agent chose.
		"first line\nsecond line",
		"| case | result |\n| --- | --- |\n| one | pass |",
		"![shot](https://attacker.example/p.gif)",
		// The literal is rebuilt from parsed parts, so the escaping is the only
		// thing keeping markup in an alt text or a destination inert.
		"![<b>x</b>](a<script>alert(5)</script>)",
		// Case is not a bypass: an upper-case scheme is still refused.
		"[loud](JaVaScRiPt:alert(4))",
	}
	for _, text := range messages {
		payload, err := json.Marshal(map[string]any{
			"role": "assistant", "partial": false,
			"content": []map[string]string{{"type": "text", "text": text}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.AppendEvent(context.Background(), "task-md", "message", payload); err != nil {
			t.Fatal(err)
		}
	}
	link := createShare(t, s, "task-md", token)

	page := shareRequest(t, s, http.MethodGet, "/s/"+link, "")
	if page.Code != http.StatusOK {
		t.Fatalf("public page: %d", page.Code)
	}
	if csp := page.Header().Get("Content-Security-Policy"); csp !=
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" {
		// The whole policy, not just its first word: `style-src 'unsafe-inline'`
		// is what lets the page's own <style> through, and `img-src 'none'` is
		// the second lock on the image boundary.
		t.Fatalf("unexpected CSP: %q", csp)
	}
	html := page.Body.String()
	for _, want := range []string{
		"<strong>done</strong>",
		"<pre><code",
		"<li>one</li>",
		"first line<br>",
		"<table>",
		"![shot](https://attacker.example/p.gif)",
		"![&lt;b&gt;x&lt;/b&gt;](a&lt;script&gt;alert(5)&lt;/script&gt;)",
		// Raw HTML stays readable rather than vanishing behind a comment.
		"&lt;script&gt;alert(1)&lt;/script&gt;",
		"&lt;img src=x onerror=alert(2)&gt;",
		`href="https://kin.example.com/docs"`,
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("page is missing %q", want)
		}
	}
	for _, unwanted := range []string{
		"<script",
		"<img",
		"**done**",
	} {
		if strings.Contains(html, unwanted) {
			t.Fatalf("page published %q", unwanted)
		}
	}
	// No anchor may carry a script scheme, in any casing.
	if strings.Contains(strings.ToLower(html), `href="javascript:`) {
		t.Fatalf("page published a javascript: link: %s", html)
	}

	// The JSON endpoint stays a source feed: a caller that wants to render the
	// conversation itself should not receive pre-rendered HTML. Asserted on the
	// wire shape, not on the struct — a new field with a tag would otherwise
	// slip past, and the struct this package decodes into drops it silently.
	rr := shareRequest(t, s, http.MethodGet, "/api/public/shares/"+link, "")
	var wire struct {
		Messages []map[string]json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire.Messages) != len(messages) {
		t.Fatalf("JSON messages = %d, want %d", len(wire.Messages), len(messages))
	}
	allowed := map[string]bool{"role": true, "text": true, "ts": true, "speaker": true}
	for _, m := range wire.Messages {
		for key := range m {
			if !allowed[key] {
				t.Fatalf("JSON message carries an unexpected field %q", key)
			}
		}
	}
	var first struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(wire.Messages[0]["text"], &first.Text); err != nil {
		t.Fatal(err)
	}
	if first.Text != messages[0] {
		t.Fatalf("JSON text = %q, want the source", first.Text)
	}
}

// Markdown can expand far past its source — nesting most of all — and this
// page is rendered for whoever holds the link. A message that would render
// huge is shown as its source instead.
func TestShareShowsTheSourceWhenOneMessageRendersHuge(t *testing.T) {
	s, token := newTestServer(t)
	if err := s.Store.InsertTask(context.Background(), store.Task{
		ID: "task-deep", Title: "deep", Agent: "kin", Cwd: "/tmp",
		Prompt: "p", Status: "finished", CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	// Paragraph breaks, not just newlines: each one closes its own chain of
	// blockquotes, which is what makes the rendering expand.
	text := strings.Repeat(strings.Repeat("> ", 900)+"deep\n\n", 8)
	payload, err := json.Marshal(map[string]any{
		"role": "assistant", "partial": false,
		"content": []map[string]string{{"type": "text", "text": text}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.AppendEvent(context.Background(), "task-deep", "message", payload); err != nil {
		t.Fatal(err)
	}
	link := createShare(t, s, "task-deep", token)

	page := shareRequest(t, s, http.MethodGet, "/s/"+link, "")
	if page.Code != http.StatusOK {
		t.Fatalf("public page: %d", page.Code)
	}
	html := page.Body.String()
	if strings.Contains(html, "<blockquote") {
		t.Fatalf("page rendered the expansion anyway (%d bytes)", len(html))
	}
	if !strings.Contains(html, "&gt; &gt; ") {
		t.Fatal("the reader lost the message")
	}
}

// A task with no message events falls back to its prompt, and a prompt is
// unbounded on the create path: it has to meet the same line clamp and the
// same budget as any other line.
func TestShareClampsALegacyPromptThatIsTheWholeConversation(t *testing.T) {
	s, token := newTestServer(t)
	if err := s.Store.InsertTask(context.Background(), store.Task{
		ID: "task-prompt", Title: "p", Agent: "kin", Cwd: "/tmp",
		Prompt: strings.Repeat("y", 4*shareMessageBytes), Status: "queued", CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	link := createShare(t, s, "task-prompt", token)

	rr := shareRequest(t, s, http.MethodGet, "/api/public/shares/"+link, "")
	var view shareView
	if err := json.Unmarshal(rr.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if len(view.Messages) != 1 {
		t.Fatalf("messages = %d, want the prompt alone", len(view.Messages))
	}
	if n := len(view.Messages[0].Text); n > shareMessageBytes {
		t.Fatalf("prompt fallback is %d bytes, cap is %d", n, shareMessageBytes)
	}
}

// The third cap: a page costs CPU in proportion to the text it renders, and
// this route answers anyone holding the link. The newest turns are the ones a
// reader came for, so the budget is spent from the end.
func TestShareKeepsTheNewestWithinItsByteBudget(t *testing.T) {
	s, token := newTestServer(t)
	if err := s.Store.InsertTask(context.Background(), store.Task{
		ID: "task-big", Title: "big", Agent: "kin", Cwd: "/tmp",
		Prompt: "p", Status: "finished", CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	// Each line is clamped to shareMessageBytes, so filling the budget takes a
	// few dozen of them.
	line := strings.Repeat("x", shareMessageBytes-1)
	const count = 80
	for i := 0; i < count; i++ {
		payload, err := json.Marshal(map[string]any{
			"role": "assistant", "partial": false,
			"content": []map[string]string{{"type": "text", "text": line + strconv.Itoa(i%10)}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.AppendEvent(context.Background(), "task-big", "message", payload); err != nil {
			t.Fatal(err)
		}
	}
	link := createShare(t, s, "task-big", token)

	rr := shareRequest(t, s, http.MethodGet, "/api/public/shares/"+link, "")
	var view shareView
	if err := json.Unmarshal(rr.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if len(view.Messages) >= count {
		t.Fatalf("page kept %d messages, the budget bounded nothing", len(view.Messages))
	}
	if !view.Truncated {
		t.Fatal("a cut transcript must say it was cut")
	}
	total := 0
	for _, m := range view.Messages {
		total += len(m.Text)
	}
	if total > shareTotalBytes+shareMessageBytes {
		t.Fatalf("kept %d bytes, budget is %d", total, shareTotalBytes)
	}
	// The newest message survives; it is the one the link was shared for.
	if !strings.HasSuffix(view.Messages[len(view.Messages)-1].Text, strconv.Itoa((count-1)%10)) {
		t.Fatal("the newest message was dropped")
	}
}

func TestRevokingAShareClosesTheLink(t *testing.T) {
	s, token := newTestServer(t)
	shareTestTask(t, s, "task-rev")
	link := createShare(t, s, "task-rev", token)

	rr := shareRequest(t, s, http.MethodDelete, "/api/tasks/task-rev/share", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rr.Code, rr.Body.String())
	}
	if got := shareRequest(t, s, http.MethodGet, "/api/public/shares/"+link, ""); got.Code != http.StatusNotFound {
		t.Fatalf("revoked link answered %d", got.Code)
	}
	page := shareRequest(t, s, http.MethodGet, "/s/"+link, "")
	if page.Code != http.StatusNotFound || !strings.Contains(page.Body.String(), "no longer available") {
		t.Fatalf("revoked page = %d %s", page.Code, page.Body.String())
	}

	// The state endpoint is how the console knows the link is gone.
	state := shareRequest(t, s, http.MethodGet, "/api/tasks/task-rev/share", token)
	var body shareState
	if err := json.Unmarshal(state.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Active {
		t.Fatalf("state after revoke = %+v", body)
	}
}

// Minting a second link is how an owner replaces one they have lost, so the
// first must stop working in the same step.
func TestCreatingAShareAgainClosesTheOldLink(t *testing.T) {
	s, token := newTestServer(t)
	shareTestTask(t, s, "task-2x")
	first := createShare(t, s, "task-2x", token)
	second := createShare(t, s, "task-2x", token)
	if first == second {
		t.Fatal("the second link reuses the first token")
	}
	if got := shareRequest(t, s, http.MethodGet, "/api/public/shares/"+first, ""); got.Code != http.StatusNotFound {
		t.Fatalf("old link still answers %d", got.Code)
	}
	if got := shareRequest(t, s, http.MethodGet, "/api/public/shares/"+second, ""); got.Code != http.StatusOK {
		t.Fatalf("new link answers %d", got.Code)
	}
}

// The token is the credential. It is returned once, at creation, and the state
// endpoint the console polls must never repeat it.
func TestShareStateCarriesNoToken(t *testing.T) {
	s, token := newTestServer(t)
	shareTestTask(t, s, "task-state")
	link := createShare(t, s, "task-state", token)

	state := shareRequest(t, s, http.MethodGet, "/api/tasks/task-state/share", token)
	if state.Code != http.StatusOK {
		t.Fatalf("state: %d", state.Code)
	}
	if strings.Contains(state.Body.String(), link) {
		t.Fatalf("state response repeats the token: %s", state.Body.String())
	}
	var body shareState
	if err := json.Unmarshal(state.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Active || body.CreatedAt <= 0 {
		t.Fatalf("state = %+v", body)
	}
}

func TestShareRefusesUnknownTaskAndAnonymousCreate(t *testing.T) {
	s, token := newTestServer(t)
	// All three owner routes answer 404 for a task that is not there: a typo in
	// the URL and "this task has no link" are different answers, and the console
	// draws a different sentence for each.
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		if rr := shareRequest(t, s, method, "/api/tasks/nope/share", token); rr.Code != http.StatusNotFound {
			t.Fatalf("%s unknown task = %d", method, rr.Code)
		}
	}
	shareTestTask(t, s, "task-anon")
	if rr := shareRequest(t, s, http.MethodPost, "/api/tasks/task-anon/share", ""); rr.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous create = %d", rr.Code)
	}
}

// The page's own chrome follows the reader; the conversation does not.
func TestSharePageSpeaksTheReadersLanguage(t *testing.T) {
	s, token := newTestServer(t)
	shareTestTask(t, s, "task-lang")
	link := createShare(t, s, "task-lang", token)

	request := func(accept string) string {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/s/"+link, nil)
		if accept != "" {
			req.Header.Set("Accept-Language", accept)
		}
		rr := httptest.NewRecorder()
		s.Handler().ServeHTTP(rr, req)
		return rr.Body.String()
	}

	zh := request("zh-CN,zh;q=0.9,en;q=0.8")
	if !strings.Contains(zh, `lang="zh-Hans"`) || !strings.Contains(zh, "只读") || !strings.Contains(zh, "你") {
		t.Fatalf("chinese reader got an english page: %.400s", zh)
	}
	// The conversation itself is published as written, in either language.
	if !strings.Contains(zh, "Looking at it now.") {
		t.Fatal("chinese page lost the english conversation")
	}
	en := request("en-US,en;q=0.9")
	if !strings.Contains(en, `lang="en"`) || !strings.Contains(en, "read-only") {
		t.Fatalf("english reader did not get the english page")
	}
	// `q=0` is a refusal, not a preference — the next entry decides.
	refused := request("zh;q=0,en;q=0.9")
	if !strings.Contains(refused, "read-only") {
		t.Fatal("q=0 did not remove chinese from the ranking")
	}
}

// A share of a very long session keeps the end of it, and says it did.
func TestShareTranscriptKeepsTheNewestPastTheCap(t *testing.T) {
	events := make([]store.Event, 0, shareMessageLimit+5)
	for i := 0; i < shareMessageLimit+5; i++ {
		events = append(events, store.Event{
			Seq:     i + 1,
			Type:    "message",
			Payload: json.RawMessage(`{"role":"user","content":[{"type":"text","text":"m` + strconv.Itoa(i) + `"}]}`),
		})
	}
	messages, truncated := shareTranscript(events, "kin")
	if !truncated {
		t.Fatal("a transcript past the cap did not report truncation")
	}
	if len(messages) != shareMessageLimit {
		t.Fatalf("kept %d messages, want %d", len(messages), shareMessageLimit)
	}
	if want := "m" + strconv.Itoa(len(events)-1); messages[len(messages)-1].Text != want {
		t.Fatalf("last kept message = %q, want %q", messages[len(messages)-1].Text, want)
	}
	if want := "m5"; messages[0].Text != want {
		t.Fatalf("first kept message = %q, want %q (the front should be the part dropped)", messages[0].Text, want)
	}
}

// The window is what makes "truncated" honest: a session long enough to fill the
// read window must not claim to be complete just because no message cap was hit.
func TestShareWindowReportsACutFront(t *testing.T) {
	events := make([]store.Event, shareEventLimit+1)
	for i := range events {
		events[i] = store.Event{Seq: i + 1, Type: "message"}
	}
	kept, cut := shareWindow(events)
	if !cut {
		t.Fatal("a full window did not report being cut")
	}
	if len(kept) != shareEventLimit || kept[0].Seq != 2 || kept[len(kept)-1].Seq != shareEventLimit+1 {
		t.Fatalf("window = %d rows, first %d, last %d", len(kept), kept[0].Seq, kept[len(kept)-1].Seq)
	}
	if _, cut := shareWindow(events[:shareEventLimit]); cut {
		t.Fatal("a window that fits reported a cut")
	}
}

func TestShareClampsOneHugeMessage(t *testing.T) {
	huge := strings.Repeat("字", shareMessageBytes)
	clamped := clampShareText(huge)
	if len(clamped) > shareMessageBytes+len("…") {
		t.Fatalf("clamped length %d exceeds the cap", len(clamped))
	}
	if !strings.HasSuffix(clamped, "…") {
		t.Fatal("a clamped message does not say it was cut")
	}
	if got := clampShareText("short"); got != "short" {
		t.Fatalf("short text = %q", got)
	}
}

// Older rows and some adapters put the message text in `content` as a string
// rather than a blocks array.
func TestShareReadsStringContent(t *testing.T) {
	events := []store.Event{{
		Seq: 1, Type: "message",
		Payload: json.RawMessage(`{"role":"assistant","speaker":"claude-code","content":"plain string content"}`),
	}}
	messages, _ := shareTranscript(events, "claude-code")
	if len(messages) != 1 || messages[0].Text != "plain string content" {
		t.Fatalf("messages = %+v", messages)
	}
}

// A failed insert must not leave the owner without the link they already had.
func TestReplacingAShareIsAtomic(t *testing.T) {
	s, token := newTestServer(t)
	shareTestTask(t, s, "task-atomic")
	first := createShare(t, s, "task-atomic", token)

	// A duplicate primary key is the cheapest way to make the insert fail after
	// the revoke has already run inside the transaction.
	var id string
	live, ok, err := s.Store.ActiveSessionShare(context.Background(), "task-atomic", store.NowMilli())
	if err != nil || !ok {
		t.Fatalf("active share: %v %v", ok, err)
	}
	id = live.ID
	if err := s.Store.ReplaceSessionShare(context.Background(), store.SessionShare{
		ID: id, TaskID: "task-atomic", TokenHash: "hash-other", CreatedAt: store.NowMilli(),
	}); err == nil {
		t.Fatal("replace with a duplicate id succeeded")
	}
	if got := shareRequest(t, s, http.MethodGet, "/api/public/shares/"+first, ""); got.Code != http.StatusOK {
		t.Fatalf("the old link died with the failed replace: %d", got.Code)
	}
}
