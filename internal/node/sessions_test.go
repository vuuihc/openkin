package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// The session questions are the only ones whose answers are about *things a
// person wrote*: a session's title comes from a prompt, and a history item is a
// message. So these tests are mostly about the two ways that goes wrong — an
// answer too large to send, and a message cut in the middle of a character.

// fakeCatalog is a machine's session catalog with nothing underneath it.
type fakeCatalog struct {
	ids      []string
	sessions map[string][]agent.SessionInfo
	failWith map[string]error
	page     agent.HistoryPage
	pageErr  error
	// asked records the last history query, so a test can assert what the
	// machine was asked rather than only what it answered.
	asked agent.HistoryQuery
}

func (c *fakeCatalog) IDs() []string { return c.ids }

func (c *fakeCatalog) ListSessions(_ context.Context, agentID string, _ agent.SessionQuery) ([]agent.SessionInfo, error) {
	if err := c.failWith[agentID]; err != nil {
		return nil, err
	}
	sessions, ok := c.sessions[agentID]
	if !ok {
		return nil, errors.New("no such provider")
	}
	return sessions, nil
}

func (c *fakeCatalog) ReadSessionHistory(_ context.Context, agentID, ref string, q agent.HistoryQuery) (agent.HistoryPage, error) {
	c.asked = q
	if c.pageErr != nil {
		return agent.HistoryPage{}, c.pageErr
	}
	if agentID == "" || ref == "" {
		return agent.HistoryPage{}, errors.New("which session?")
	}
	return c.page, nil
}

func session(ref, title string, at time.Time) agent.SessionInfo {
	return agent.SessionInfo{
		AgentID:      "claude-code",
		ExternalRef:  ref,
		Title:        title,
		Cwd:          "/Users/someone/project",
		Status:       "idle",
		Capabilities: []agent.Capability{agent.CapabilitySessionList, agent.CapabilitySessionAttach},
		CreatedAt:    at,
		UpdatedAt:    at.Add(time.Minute),
	}
}

// TestAProviderWithNoCatalogIsPassedOverNotReported is the difference between a
// session list and a list of failures.
//
// IDs() is every agent this machine knows, and almost none of them keeps a
// history — a registered agent is usually a thing that runs tasks. Walking that
// list is how the answer is built, so a provider with no catalog has to read as
// "nothing here" rather than as an error, or every sync on every phone would
// report four failures that are not failures.
//
// A *named* provider is the opposite case and is asserted beside it: asking
// about one provider by name and hearing nothing back is a gap the person needs
// told about, because they asked a question with an answer.
func TestAProviderWithNoCatalogIsPassedOverNotReported(t *testing.T) {
	now := time.Now()
	catalog := &fakeCatalog{
		ids: []string{"claude-code", "codex", "some-task-runner"},
		sessions: map[string][]agent.SessionInfo{
			"claude-code": {session("ref-1", "one", now)},
			"codex":       {session("ref-2", "two", now)},
		},
		failWith: map[string]error{
			"some-task-runner":    agent.ErrSessionCatalogUnavailable,
			"an-agent-nobody-has": errors.New("this machine has no such agent"),
		},
	}
	r := &Responder{Sessions: catalog}

	all, err := r.sessions(context.Background(), worker.AgentSessionsParams{})
	if err != nil {
		t.Fatalf("list every session: %v", err)
	}
	if len(all.Sessions) != 2 {
		t.Fatalf("got %d sessions, want 2 (%+v)", len(all.Sessions), all.Sessions)
	}
	if len(all.Errors) != 0 {
		t.Fatalf("a provider with no catalog was reported as a failure: %v", all.Errors)
	}
	if all.Truncated {
		t.Fatal("a two-session answer says it was cut")
	}

	named, err := r.sessions(context.Background(), worker.AgentSessionsParams{Agent: "some-task-runner"})
	if err != nil {
		t.Fatalf("name one provider: %v", err)
	}
	if named.Errors["some-task-runner"] == "" {
		t.Fatalf("naming a provider with no catalog answered with nothing to say: %+v", named)
	}
	if len(named.Sessions) != 0 {
		t.Fatalf("a named provider that failed answered with sessions: %+v", named.Sessions)
	}
}

// TestAMachineWithNoSessionCatalogSaysSo covers the other empty answer: not
// "none of my providers has one" but "I have no providers at all". It is a
// refusal rather than an empty list because the two mean different things to a
// person looking at a phone — one is a machine with no sessions, the other is a
// machine that cannot be asked.
func TestAMachineWithNoSessionCatalogSaysSo(t *testing.T) {
	r := &Responder{}
	result := r.answer(context.Background(), "q1", worker.QueryAgentSessions, nil)
	if result.Error == "" {
		t.Fatalf("a machine with no catalog answered a listing: %+v", result)
	}
	if !strings.Contains(result.Error, "does not list") {
		t.Fatalf("the refusal does not say what is missing: %q", result.Error)
	}
	history := r.answer(context.Background(), "q2", worker.QueryAgentHistory,
		json.RawMessage(`{"agent":"claude-code","ref":"ref-1"}`))
	if history.Error == "" {
		t.Fatalf("a machine with no catalog answered a history read: %+v", history)
	}
}

// TestASessionListingStopsBeforeTheFrameDoes is the bound that keeps a listing
// sendable.
//
// A machine with a thousand sessions, each with a long path and a long title,
// is a machine whose answer does not fit in a frame — and a frame that cannot be
// built is not an error the Hub can read, it is silence until the question times
// out. What is asserted here is the whole envelope, encoded, because that is
// what ships.
func TestASessionListingStopsBeforeTheFrameDoes(t *testing.T) {
	now := time.Now()
	long := strings.Repeat("深", 400) + "/" + strings.Repeat("x", 2000)
	sessions := make([]agent.SessionInfo, 0, 800)
	for i := 0; i < 800; i++ {
		one := session("ref-"+strings.Repeat("r", 400), long, now)
		one.Cwd = long
		sessions = append(sessions, one)
	}
	r := &Responder{Sessions: &fakeCatalog{ids: []string{"claude-code"}, sessions: map[string][]agent.SessionInfo{"claude-code": sessions}}}

	answer, err := r.sessions(context.Background(), worker.AgentSessionsParams{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !answer.Truncated {
		t.Fatal("an answer that dropped sessions does not say it dropped them")
	}
	// The answer as it will actually travel: the same marshal, through the same
	// result envelope the connection builds.
	result, err := worker.Answer("q1", answer)
	if err != nil {
		t.Fatalf("build the answer: %v", err)
	}
	frame, err := worker.NewFrame("query.result", result)
	if err != nil {
		t.Fatalf("the listing does not fit in a frame: %v", err)
	}
	if len(frame.Data) == 0 {
		t.Fatal("the frame carries no payload")
	}
	if len(answer.Sessions) == 0 {
		t.Fatal("the budget refused every session, including the first")
	}
}

// TestAHistoryMessageIsCutWhereTheProviderWouldHaveCutIt is the one thing that
// is easy to get wrong and impossible to see: a cut that depends on what the
// message is made of.
//
// The provider caps a message in runes, so this machine has to as well. Counting
// bytes instead would keep a third of a Chinese message — and would keep it
// silently, because the provider's own cap had not been reached, so nothing
// downstream would have a reason to say a limit was met. The flag is the other
// half: a person reading a transcript is entitled to know that the message they
// are reading is not the whole message.
func TestAHistoryMessageIsCutWhereTheProviderWouldHaveCutIt(t *testing.T) {
	// Three bytes per character, and more characters than the bound allows, so a
	// byte-counting cut and a rune-counting cut cannot land in the same place.
	text := strings.Repeat("深", worker.MaxAgentHistoryText+100)
	page := agent.HistoryPage{
		Items: []agent.HistoryItem{{
			AgentID: "claude-code", ExternalRef: "ref-1", MessageID: "m1",
			Role: "assistant", Text: text, OccurredAt: time.Now(),
		}},
		NextCursor: "next",
		SourceRev:  "rev-1",
	}
	r := &Responder{Sessions: &fakeCatalog{page: page}}

	result, err := r.sessionHistory(context.Background(), worker.AgentHistoryParams{Agent: "claude-code", Ref: "ref-1"})
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if len(result.Items) != 1 {
		t.Fatalf("got %d items, want 1", len(result.Items))
	}
	item := result.Items[0]
	if !item.Truncated {
		t.Fatal("a message longer than the bound does not say it was cut")
	}
	// The bound is characters, so the byte length is legitimately larger — and
	// this is what a byte-counting cut would have got wrong.
	if got := utf8.RuneCountInString(item.Text); got != worker.MaxAgentHistoryText {
		t.Fatalf("the cut kept %d characters, want exactly %d", got, worker.MaxAgentHistoryText)
	}
	if !utf8.ValidString(item.Text) {
		t.Fatalf("the cut left half a character: %q", item.Text)
	}
	// The real assertion: what came back is still the string it was cut from,
	// and not a repaired version of it.
	if !strings.HasPrefix(text, item.Text) {
		t.Fatalf("the cut text is not a prefix of the message: %q", item.Text)
	}
	// A page the provider ended is the provider's page: its cursor is how the
	// rest of it is read, and it must survive the trip.
	if result.NextCursor != "next" {
		t.Fatalf("the page lost its cursor: %q", result.NextCursor)
	}
	if result.SourceRev != "rev-1" {
		t.Fatalf("the page lost its revision: %q", result.SourceRev)
	}
	// A message that was cut is not a page that was cut: this page carries
	// everything the provider sent, so it must not read as truncated — the flag
	// means "there is more you cannot have", and there is not.
	if result.Truncated {
		t.Fatal("a page that carries every message the provider sent says it was cut")
	}
}

// TestAHistoryMessageWithNoRoomIsCutToNothing is the degenerate bound: a limit
// of zero keeps nothing and says so, rather than keeping a byte of a character.
func TestAHistoryMessageWithNoRoomIsCutToNothing(t *testing.T) {
	if text, cut := clipText("深", 0); text != "" || !cut {
		t.Fatalf("clipText(%q, 0) = %q, %v; want empty and cut", "深", text, cut)
	}
}

// TestTheWorstHistoryPageFitsInOneFrame is the bound that keeps a page
// sendable, and the reason it is measured rather than reasoned about.
//
// A page is up to a hundred whole messages, and one message may be 64 KiB —
// before encoding/json's six-bytes-per-byte for the characters it escapes. So
// the worst page this machine can be asked for is tens of megabytes, and what
// stops it at a frame is counting what it actually built. A page that could not
// be built into a frame is not an error the Hub can read: it is silence until
// the question times out, and a phone that asked for a transcript gets a machine
// that looks offline.
//
// The two things asserted together are the whole mechanism: the answer fits a
// frame, and the messages it could not carry are visible as a page with no
// cursor rather than as a page that skipped them.
func TestTheWorstHistoryPageFitsInOneFrame(t *testing.T) {
	// The byte that costs the most to encode, so this is the worst case and not
	// a large one: encoding/json escapes <, > and & to six bytes each.
	const worst = "<"
	items := make([]agent.HistoryItem, 0, worker.MaxAgentHistoryItems)
	for i := 0; i < worker.MaxAgentHistoryItems; i++ {
		items = append(items, agent.HistoryItem{
			AgentID:    "claude-code",
			MessageID:  strings.Repeat(worst, maxMessageID),
			Kind:       strings.Repeat(worst, maxKind),
			Role:       strings.Repeat(worst, maxRole),
			ToolName:   strings.Repeat(worst, maxToolName),
			Text:       strings.Repeat(worst, worker.MaxAgentHistoryText),
			SourceRev:  strings.Repeat(worst, maxSourceRev),
			OccurredAt: time.Now(),
		})
	}
	r := &Responder{Sessions: &fakeCatalog{page: agent.HistoryPage{
		Items: items,
		// The two values that travel outside the item loop are at their bounds
		// too: a bound that is not part of this test is a bound that can drift.
		NextCursor: strings.Repeat(worst, worker.MaxAgentHistoryCursor),
		SourceRev:  strings.Repeat(worst, maxSourceRev),
	}}}

	result, err := r.sessionHistory(context.Background(), worker.AgentHistoryParams{
		Agent: "claude-code", Ref: "ref-1", Limit: worker.MaxAgentHistoryItems,
	})
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if len(result.Items) == 0 {
		t.Fatal("the budget refused every message, including the first")
	}
	if len(result.Items) >= worker.MaxAgentHistoryItems {
		t.Fatalf("a page of %d messages of %d bytes each fitted a frame, so this test is not the worst case",
			len(result.Items), worker.MaxAgentHistoryText)
	}
	if result.NextCursor != "" {
		t.Fatalf("a page this machine cut kept the provider's cursor, so the messages it dropped are skipped silently: %q", result.NextCursor)
	}
	// And the cut is said out loud: an empty cursor is also what the end of a
	// transcript looks like, so a page that dropped messages has to be
	// distinguishable from a page that reached the end.
	if !result.Truncated {
		t.Fatal("a page this machine cut does not say so, so a short transcript reads as the whole one")
	}
	answer, err := worker.Answer(strings.Repeat("q", worker.MaxQueryID), result)
	if err != nil {
		t.Fatalf("build the answer: %v", err)
	}
	frame, err := worker.NewFrame("query.result", answer)
	if err != nil {
		t.Fatalf("the worst history page does not fit in a frame: %v", err)
	}
	if len(frame.Data) > worker.MaxFrameBytes {
		t.Fatalf("the worst history page encodes to %d bytes, past the frame's %d",
			len(frame.Data), worker.MaxFrameBytes)
	}
}

// TestAHistoryPageCutByThisMachineLosesItsCursor is the honest half of dropping
// messages.
//
// A provider's cursor names the position after the whole page it returned. If
// this machine sends part of that page and passes the cursor on, the next read
// starts after the messages that were dropped — so they are not delayed, they are
// gone, and nothing says so. An empty cursor ends the reading instead, which
// loses the same messages *visibly*, and visible is the only one of the two a
// person can act on.
//
// The provider here hands back more than it was asked for, which is the reachable
// way this happens: the limit travels as a request, so the page that comes back
// is the provider's to decide, and a machine that trusted it would be trusting
// the size of its own answer to a CLI.
func TestAHistoryPageCutByThisMachineLosesItsCursor(t *testing.T) {
	items := make([]agent.HistoryItem, 0, worker.MaxAgentHistoryItems+5)
	for i := 0; i < worker.MaxAgentHistoryItems+5; i++ {
		items = append(items, agent.HistoryItem{
			AgentID: "claude-code", ExternalRef: "ref-1",
			MessageID: fmt.Sprintf("m%d", i), Role: "user", Text: "short",
			OccurredAt: time.Now(),
		})
	}
	r := &Responder{Sessions: &fakeCatalog{page: agent.HistoryPage{Items: items, NextCursor: "next"}}}

	result, err := r.sessionHistory(context.Background(), worker.AgentHistoryParams{Agent: "claude-code", Ref: "ref-1"})
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if len(result.Items) >= len(items) {
		t.Fatalf("the bound did not bite: %d of %d items", len(result.Items), len(items))
	}
	if result.NextCursor != "" {
		t.Fatalf("a page this machine cut kept the provider's cursor, so the dropped messages are skipped silently: %q", result.NextCursor)
	}
}

// TestAHistoryReadIsAskedForWhatTheCallerAsked documents the limit that travels:
// a Hub's page size reaches the catalog, rather than the machine answering with
// a size of its own choosing.
func TestAHistoryReadIsAskedForWhatTheCallerAsked(t *testing.T) {
	catalog := &fakeCatalog{page: agent.HistoryPage{Items: []agent.HistoryItem{}}}
	r := &Responder{Sessions: catalog}
	if _, err := r.sessionHistory(context.Background(), worker.AgentHistoryParams{
		Agent: "claude-code", Ref: "ref-1", Cursor: "c1", Limit: 7,
	}); err != nil {
		t.Fatalf("read history: %v", err)
	}
	if catalog.asked.Limit != 7 || catalog.asked.Cursor != "c1" {
		t.Fatalf("the catalog was asked %+v, want limit 7 cursor c1", catalog.asked)
	}
	// And an unset limit is this machine's own page size, not zero: a zero limit
	// is a request no catalog can honour.
	if _, err := r.sessionHistory(context.Background(), worker.AgentHistoryParams{
		Agent: "claude-code", Ref: "ref-1",
	}); err != nil {
		t.Fatalf("read history: %v", err)
	}
	if catalog.asked.Limit != worker.MaxAgentHistoryItems {
		t.Fatalf("an unset limit reached the catalog as %d", catalog.asked.Limit)
	}
}

// TestASessionWithNoTimesTravelsWithNone is the zero-time guard.
//
// The zero time as milliseconds is a large negative year, and a store that read
// it would be recording that a session was last touched before the epoch — a
// number nobody can explain from the UI. Absent has to travel as absent.
func TestASessionWithNoTimesTravelsWithNone(t *testing.T) {
	one := session("ref-1", "one", time.Time{})
	one.CreatedAt = time.Time{}
	one.UpdatedAt = time.Time{}
	wire := wireAgentSession(one)
	if wire.CreatedAt != 0 || wire.UpdatedAt != 0 {
		t.Fatalf("a session with no times travelled with %d/%d", wire.CreatedAt, wire.UpdatedAt)
	}
}

// TestAMachineWithHundredsOfBrokenProvidersStillFitsOneFrame pins the arithmetic
// the frame budget's comment rests on.
//
// The budget measures rows, and the error map is built outside that loop, so the
// map is covered by the headroom under the frame instead: one clipped sentence
// per registered provider. That is a claim about numbers, and a claim about
// numbers that nothing tests is a claim that stops being true when somebody
// widens maxSessionError.
func TestAMachineWithHundredsOfBrokenProvidersStillFitsOneFrame(t *testing.T) {
	const providers = 512
	ids := make([]string, 0, providers)
	failWith := map[string]error{}
	for i := 0; i < providers; i++ {
		id := fmt.Sprintf("provider-%03d", i)
		ids = append(ids, id)
		// A sentence no provider would write and none of them is trusted not to:
		// the whole point is that the length comes from the provider.
		failWith[id] = errors.New(strings.Repeat("failure ", maxSessionError))
	}
	r := &Responder{Sessions: &fakeCatalog{ids: ids, failWith: failWith}}

	result, err := r.sessions(context.Background(), worker.AgentSessionsParams{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(result.Errors) != providers {
		t.Fatalf("got %d errors, want %d", len(result.Errors), providers)
	}
	for id, reason := range result.Errors {
		if len(reason) > maxSessionError {
			t.Fatalf("the sentence about %s is %d bytes, over the %d bound", id, len(reason), maxSessionError)
		}
	}
	frame, err := worker.NewFrame("query.result", result)
	if err != nil {
		t.Fatalf("the answer does not fit one frame: %v", err)
	}
	if len(frame.Data) > worker.MaxFrameBytes {
		t.Fatalf("the frame is %d bytes, over the %d limit", len(frame.Data), worker.MaxFrameBytes)
	}
}

// TestASessionRowIsClippedOnItsWayOut is the listing's version of the message
// bound: a row whose fields came from a provider is a row this machine has to be
// able to state the size of.
//
// Today's catalogs already bound these, so this is a guarantee rather than a fix
// — the same guarantee the message text gets, for the same reason: SessionCatalog
// is an interface, and a row that does not fit a frame is answered with silence
// rather than with an error anybody can read.
func TestASessionRowIsClippedOnItsWayOut(t *testing.T) {
	long := strings.Repeat("x", 8<<10)
	row := session("ref-1", "title", time.Now())
	row.Title = strings.Repeat("深", 8<<10)
	row.Cwd = long
	row.SourceURI = long
	row.Status = long
	row.SourceCursor = long
	row.ContentDigest = long
	row.ExternalRef = long
	r := &Responder{Sessions: &fakeCatalog{
		ids:      []string{"claude-code"},
		sessions: map[string][]agent.SessionInfo{"claude-code": {row}},
	}}

	result, err := r.sessions(context.Background(), worker.AgentSessionsParams{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(result.Sessions) != 1 {
		t.Fatalf("got %d sessions, want 1", len(result.Sessions))
	}
	got := result.Sessions[0]
	for name, value := range map[string]string{
		"external_ref":   got.ExternalRef,
		"cwd":            got.Cwd,
		"source_uri":     got.SourceURI,
		"status":         got.Status,
		"source_cursor":  got.SourceCursor,
		"content_digest": got.ContentDigest,
	} {
		if len(value) > maxCwd {
			t.Fatalf("%s is %d bytes, over every bound this layer has", name, len(value))
		}
	}
	if len(got.ExternalRef) > worker.MaxSessionRef {
		t.Fatalf("external_ref is %d bytes, over the %d the wire carries", len(got.ExternalRef), worker.MaxSessionRef)
	}
	if runes := utf8.RuneCountInString(got.Title); runes > maxTitle {
		t.Fatalf("title is %d characters, over the %d bound", runes, maxTitle)
	}
	if !utf8.ValidString(got.Title) {
		t.Fatalf("the clipped title is not valid text: %q", got.Title)
	}
}
