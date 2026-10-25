package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
)

// This is the slice where a phone stops seeing only the sessions of the machine
// it happens to be talking to. What it asserts is the whole errand: a paired
// machine's sessions land in this Hub's list under that machine, one of them can
// be read, and attaching it produces a task that says out loud that the session
// it was attached to is not one this machine can continue.
//
// The last part is the one worth a test rather than a comment. Every step before
// it succeeds whether or not the notice is written, and the failure it prevents —
// a reader getting a reply that has forgotten the conversation, with nothing
// anywhere saying why — is invisible from the code that got it wrong.

// nodeCatalog is a paired machine's session catalog. It is the machine's own
// answer, so it is deliberately dumb: what is under test is what this Hub does
// with what a machine says, not how a machine finds out.
type nodeCatalog struct {
	sessions map[string][]agent.SessionInfo
	page     agent.HistoryPage
}

func (c *nodeCatalog) IDs() []string {
	ids := make([]string, 0, len(c.sessions))
	for id := range c.sessions {
		ids = append(ids, id)
	}
	return ids
}

func (c *nodeCatalog) ListSessions(_ context.Context, agentID string, _ agent.SessionQuery) ([]agent.SessionInfo, error) {
	sessions, ok := c.sessions[agentID]
	if !ok {
		return nil, agent.ErrSessionCatalogUnavailable
	}
	return sessions, nil
}

func (c *nodeCatalog) ReadSessionHistory(_ context.Context, agentID, ref string, _ agent.HistoryQuery) (agent.HistoryPage, error) {
	return c.page, nil
}

// sessionsServer is machinesServer with the two things the import and attach
// routes need configured: this Hub's own registry of runnable agents (the
// attach route refuses a session whose agent this daemon cannot run) and the
// paired machine's catalog, which is what the machine answers with.
//
// The registry here is built rather than taken from the engine, and that is not
// a shortcut: the attach route reads s.Agents, the turn reads the engine's own
// registration, and the two being separate objects is the production shape too
// (internal/server/server.go builds one registry and hands it to both).
func sessionsServer(t *testing.T, catalog node.SessionCatalog) (*Server, string, *node.Connections, *node.Responder) {
	t.Helper()
	s, master, conns := machinesServer(t)
	reg, err := agent.NewRegistry(agent.Entry{
		ID: "claude-code", Name: "Claude Code", Kind: agent.KindCLI,
		Caps: []agent.Capability{agent.CapabilityRun, agent.CapabilityResume},
		Runner: &testAdapter{events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s","subtype":"init"}`)},
			{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"ok"}],"partial":false}`)},
			{Type: "result", Payload: json.RawMessage(`{"cost_usd":0.02,"tokens_in":1,"tokens_out":2,"is_error":false}`)},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Agents = reg
	return s, master, conns, &node.Responder{Sessions: catalog}
}

// sessionsServerAccounts is sessionsServer on a Hub with accounts turned on,
// which is the only shape in which "who may import from another machine" is a
// question: a Hub with no accounts has one principal and every route is theirs.
func sessionsServerAccounts(t *testing.T, catalog node.SessionCatalog) (*Server, string, *node.Connections, *node.Responder) {
	t.Helper()
	s, master, conns, responder := sessionsServer(t, catalog)
	// accountsOn has to run before the router exists, which is why this is a
	// separate constructor rather than something a test turns on afterwards.
	accountsOn(s)
	return s, master, conns, responder
}

// A session on a paired machine arrives in this Hub's list, under that machine,
// and can be read from here.
func TestAPairedMachinesSessionsArriveInThisHubsList(t *testing.T) {
	now := time.Now()
	catalog := &nodeCatalog{
		sessions: map[string][]agent.SessionInfo{
			"claude-code": {{
				AgentID: "claude-code", ExternalRef: "node-session-1",
				Title: "on the node", Cwd: "/Users/someone/project", Status: "idle",
				Capabilities: []agent.Capability{agent.CapabilitySessionList, agent.CapabilitySessionAttach},
				CreatedAt:    now, UpdatedAt: now,
			}},
		},
		page: agent.HistoryPage{
			Items: []agent.HistoryItem{{
				AgentID: "claude-code", ExternalRef: "node-session-1",
				MessageID: "m1", Role: "user", Text: "what the node recorded",
				OccurredAt: now,
			}},
			SourceRev: "rev-1",
		},
	}
	s, master, conns, responder := sessionsServer(t, catalog)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	runResponder(t, hub.URL, deviceToken, responder)
	awaitConnected(t, conns, deviceID)

	// The import names the machine, which is the whole of the change: without it
	// this route reads this Hub's own catalogs, and a phone syncing its sessions
	// gets the ones of whatever machine it reached.
	body := map[string]any{"device_id": deviceID}
	rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("import status %d: %s", rec.Code, rec.Body.String())
	}
	var imported agentSessionImportResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
		t.Fatal(err)
	}
	if imported.Imported != 1 {
		t.Fatalf("imported %d sessions, want 1: %s", imported.Imported, rec.Body.String())
	}
	if imported.Providers["claude-code"] != 1 {
		t.Fatalf("the import does not say which provider the session came from: %s", rec.Body.String())
	}
	if len(imported.Errors) != 0 {
		t.Fatalf("a machine that answered cleanly was reported as failing: %v", imported.Errors)
	}

	listed := listAgentSessions(t, s.Handler(), master)
	if len(listed) != 1 {
		t.Fatalf("got %d sessions, want the machine's one", len(listed))
	}
	row := listed[0]
	// Under that machine, not this one. This is what makes the console bucket it
	// under the machine's heading, and what makes the ref mean something on the
	// way back.
	if row.DeviceID != deviceID {
		t.Fatalf("the session was recorded as %q, want the machine that answered %q", row.DeviceID, deviceID)
	}
	if row.ExternalRef != "node-session-1" || row.Title != "on the node" {
		t.Fatalf("the row does not carry what the machine said: %+v", row)
	}

	// Reading it asks that machine, because the ref names a conversation in that
	// machine's namespace: this Hub's own catalog would answer about a different
	// session that happens to share a name, or about nothing.
	history := getJSON(t, s.Handler(), master, "/api/agent-sessions/"+row.ID+"/history")
	if history.Code != http.StatusOK {
		t.Fatalf("history status %d: %s", history.Code, history.Body.String())
	}
	var page agentSessionHistoryResponse
	if err := json.Unmarshal(history.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Text != "what the node recorded" {
		t.Fatalf("the transcript did not come from the machine: %s", history.Body.String())
	}
	if page.SourceRev != "rev-1" {
		t.Fatalf("the machine's revision was lost: %s", history.Body.String())
	}
}

// The acceptance criterion for this slice, end to end: attach a session that
// lives on another machine and the turn says so in the transcript.
func TestAttachingAnotherMachinesSessionAnnouncesTheRef(t *testing.T) {
	now := time.Now()
	catalog := &nodeCatalog{
		sessions: map[string][]agent.SessionInfo{
			"claude-code": {{
				AgentID: "claude-code", ExternalRef: "node-session-1",
				Title: "on the node", Cwd: t.TempDir(), Status: "idle",
				Capabilities: []agent.Capability{agent.CapabilitySessionList, agent.CapabilitySessionAttach},
				CreatedAt:    now, UpdatedAt: now,
			}},
		},
	}
	s, master, conns, responder := sessionsServer(t, catalog)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	runResponder(t, hub.URL, deviceToken, responder)
	awaitConnected(t, conns, deviceID)

	if rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master,
		map[string]any{"device_id": deviceID}); rec.Code != http.StatusOK {
		t.Fatalf("import status %d: %s", rec.Code, rec.Body.String())
	}
	listed := listAgentSessions(t, s.Handler(), master)
	if len(listed) != 1 {
		t.Fatalf("got %d sessions, want 1", len(listed))
	}
	row := listed[0]

	rec := postJSON(t, s.Handler(), "/api/agent-sessions/"+row.ID+"/attach", master,
		map[string]any{"prompt": "carry on", "cwd": row.Cwd})
	if rec.Code != http.StatusCreated {
		t.Fatalf("attach status %d: %s", rec.Code, rec.Body.String())
	}
	var attached agentSessionAttachResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &attached); err != nil {
		t.Fatal(err)
	}
	if attached.Task.SessionRef == nil || *attached.Task.SessionRef != "node-session-1" {
		t.Fatalf("the task did not carry the machine's ref: %+v", attached.Task)
	}
	// The ref is only resolvable on the machine that minted it, and the task has
	// to say which machine that is or the resume path hands it over blind.
	if attached.Task.SessionRefDeviceID == nil || *attached.Task.SessionRefDeviceID != deviceID {
		t.Fatalf("the task does not record which machine the ref came from: %+v", attached.Task)
	}

	waitTaskSettled(t, s, attached.Task.ID)
	notices := noticesOn(t, s, attached.Task.ID)
	if len(notices) != 1 {
		t.Fatalf("got %d notices, want 1 telling the reader the session was not continued: %+v",
			len(notices), notices)
	}
	// The machine, named. A sentence that says "another machine" leaves the
	// reader unable to tell which one, and the person reading it is deciding
	// whether the agent forgot or never had the conversation.
	if notices[0]["session_ref_device_id"] != deviceID {
		t.Fatalf("the notice does not carry which machine the ref came from: %+v", notices[0])
	}
	message, _ := notices[0]["message"].(string)
	if !strings.Contains(message, "studio") {
		t.Fatalf("the notice does not name the machine a person knows it by: %q", message)
	}
}

// listAgentSessions reads this Hub's session list the way a console does.
func listAgentSessions(t *testing.T, h http.Handler, token string) []agentSessionResponse {
	t.Helper()
	rec := getJSON(t, h, token, "/api/agent-sessions")
	if rec.Code != http.StatusOK {
		t.Fatalf("list status %d: %s", rec.Code, rec.Body.String())
	}
	var rows []agentSessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

// noticesOn returns the notice events a task has, which is where a turn says
// something to the person rather than to the agent.
func noticesOn(t *testing.T, s *Server, taskID string) []map[string]any {
	t.Helper()
	events, err := s.Store.ListEvents(context.Background(), taskID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, ev := range events {
		if ev.Type != "notice" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(ev.Payload, &payload); err != nil {
			t.Fatalf("notice payload is not an object: %v", err)
		}
		out = append(out, payload)
	}
	return out
}

// waitTaskSettled waits for a task to stop running, whichever way it stopped:
// what these tests assert is what was said, and a turn that failed still says
// what it refused.
func waitTaskSettled(t *testing.T, s *Server, taskID string) store.Task {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		row, err := s.Store.GetTask(context.Background(), taskID)
		if err == nil && row.Status != "queued" && row.Status != "running" {
			return row
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task %s never settled", taskID)
	return store.Task{}
}

// getJSON reads a route as the console does. POST has one of these already
// (node_turn_test.go); this is its GET half.
func getJSON(t *testing.T, h http.Handler, token, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// A page the machine had to cut arrives saying so.
//
// This is the end of the chain the node's own tests begin: the machine drops the
// messages that do not fit one answer, and clearing the cursor is all it used to
// do about it. An empty cursor is also what the end of a transcript looks like,
// so the reader was shown a stopped page as the whole conversation — and the
// same session read on the machine that holds it paged to the end, which is how
// the difference becomes visible to the person least able to explain it.
func TestAPageTheMachineCutArrivesSayingSo(t *testing.T) {
	now := time.Now()
	// Long enough that the machine's own frame budget cannot carry the page, and
	// long enough per message that each one is cut by the message cap as well.
	items := make([]agent.HistoryItem, 0, 20)
	for i := 0; i < 20; i++ {
		items = append(items, agent.HistoryItem{
			AgentID: "claude-code", ExternalRef: "node-session-1",
			MessageID:  fmt.Sprintf("m%d", i),
			Role:       "assistant",
			Text:       fmt.Sprintf("%d:%s", i, strings.Repeat("x", 70<<10)),
			OccurredAt: now,
		})
	}
	catalog := &nodeCatalog{
		sessions: map[string][]agent.SessionInfo{
			"claude-code": {{
				AgentID: "claude-code", ExternalRef: "node-session-1",
				Title: "on the node", Cwd: t.TempDir(), Status: "idle",
				Capabilities: []agent.Capability{agent.CapabilitySessionList, agent.CapabilitySessionAttach},
				CreatedAt:    now, UpdatedAt: now,
			}},
		},
		page: agent.HistoryPage{Items: items, NextCursor: "cursor-2", SourceRev: "rev-1"},
	}
	s, master, conns, responder := sessionsServer(t, catalog)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	runResponder(t, hub.URL, deviceToken, responder)
	awaitConnected(t, conns, deviceID)

	if rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master,
		map[string]any{"device_id": deviceID}); rec.Code != http.StatusOK {
		t.Fatalf("import status %d: %s", rec.Code, rec.Body.String())
	}
	listed := listAgentSessions(t, s.Handler(), master)
	if len(listed) != 1 {
		t.Fatalf("got %d sessions, want 1", len(listed))
	}

	rec := getJSON(t, s.Handler(), master, "/api/agent-sessions/"+listed[0].ID+"/history")
	if rec.Code != http.StatusOK {
		t.Fatalf("history status %d: %s", rec.Code, rec.Body.String())
	}
	var page agentSessionHistoryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) == 0 || len(page.Items) >= len(items) {
		t.Fatalf("the machine sent %d of %d messages; this test needs a cut page",
			len(page.Items), len(items))
	}
	if !page.Truncated {
		t.Fatal("a page the machine cut arrived as a page that ended")
	}
	// No cursor, because the provider's cursor names the position after the whole
	// page it returned: following it would skip everything this answer left out.
	if page.NextCursor != "" {
		t.Fatalf("a cut page handed back a cursor to follow: %q", page.NextCursor)
	}
	// And the messages themselves: the cap is the machine's, and the reader is
	// entitled to know that what they are reading is where the message stopped
	// rather than where the agent did.
	if !page.Items[0].Truncated {
		t.Fatalf("a message cut by the machine's own cap says it was not: %+v", page.Items[0])
	}
	if got := utf8.RuneCountInString(page.Items[0].Text); got != worker.MaxAgentHistoryText {
		t.Fatalf("a message the machine cut arrived as %d runes, want the cap %d",
			got, worker.MaxAgentHistoryText)
	}
}

// The ways asking a machine for its sessions can fail, and what each one tells
// the caller to do about it.
//
// They share one mapping (writeMachineQueryError) with every other machine
// question, and the mapping is the whole of what a console can act on: a machine
// that is asleep is a different instruction from a Hub with no channel at all,
// and an answer this Hub cannot read is nobody's fault but this Hub's.
func TestAskingAMachineForItsSessionsFailsInTheWayTheCallerCanAct(t *testing.T) {
	now := time.Now()
	catalog := &nodeCatalog{
		sessions: map[string][]agent.SessionInfo{
			"claude-code": {{
				AgentID: "claude-code", ExternalRef: "node-session-1",
				Title: "on the node", Cwd: "/tmp/project", Status: "idle",
				CreatedAt: now, UpdatedAt: now,
			}},
		},
	}

	cases := []struct {
		name string
		// pair returns the device id to ask, having put the Hub in the state the
		// case is about.
		pair func(t *testing.T, s *Server, hubURL, master string, conns *node.Connections) string
		want int
		// says is a phrase the answer has to contain, because the status alone
		// does not say whether the right thing was reported: two of these cases
		// are a 400 and they are not the same 400.
		says string
	}{
		{
			name: "a machine this hub has never paired",
			pair: func(_ *testing.T, _ *Server, _ string, _ string, _ *node.Connections) string {
				return "device-nobody-paired"
			},
			want: http.StatusBadRequest,
			says: "unknown device",
		},
		{
			name: "a machine that has been revoked",
			pair: func(t *testing.T, s *Server, _ string, master string, _ *node.Connections) string {
				// Revoked without ever connecting, which is the state the registry
				// row is left in when a phone is removed from a Hub: it can no
				// longer dial in, and the Hub must not keep asking it anything.
				_, deviceID := pairDevice(t, s.Handler(), master)
				if err := s.Store.RevokeDeviceCredential(context.Background(), deviceID, now.UnixMilli()); err != nil {
					t.Fatal(err)
				}
				return deviceID
			},
			want: http.StatusBadRequest,
			says: "has been revoked",
		},
		{
			name: "a machine that is paired but not connected",
			pair: func(t *testing.T, s *Server, _ string, master string, _ *node.Connections) string {
				_, deviceID := pairDevice(t, s.Handler(), master)
				return deviceID
			},
			want: http.StatusConflict,
			says: "not connected",
		},
		{
			name: "a machine that does not answer",
			pair: func(t *testing.T, s *Server, hubURL, master string, conns *node.Connections) string {
				deviceToken, deviceID := pairDevice(t, s.Handler(), master)
				// A machine that is connected and silent, which is what the
				// timeout is for: it is not the same as one that never dialled in.
				dialFrames(t, hubURL, deviceToken, func(node.WriteFunc, worker.Query) {})
				awaitConnected(t, conns, deviceID)
				s.Queries.Timeout = func(string) time.Duration { return 50 * time.Millisecond }
				return deviceID
			},
			want: http.StatusGatewayTimeout,
			says: "did not answer",
		},
		{
			name: "a machine whose answer this hub cannot read",
			pair: func(t *testing.T, s *Server, hubURL, master string, conns *node.Connections) string {
				deviceToken, deviceID := pairDevice(t, s.Handler(), master)
				// The shape a version skew produces: a well-formed answer carrying
				// a payload this Hub's decoder does not recognize.
				dialFrames(t, hubURL, deviceToken, func(send node.WriteFunc, query worker.Query) {
					answer, err := worker.NewFrame("query.result", worker.QueryResult{
						ID:     query.ID,
						Result: json.RawMessage(`{"sessions":42}`),
					})
					if err != nil {
						t.Errorf("encode the answer: %v", err)
						return
					}
					if err := send(context.Background(), answer); err != nil {
						t.Errorf("send the answer: %v", err)
					}
				})
				awaitConnected(t, conns, deviceID)
				return deviceID
			},
			want: http.StatusInternalServerError,
			says: "could not be read",
		},
		{
			name: "a machine that reads the question and declines it",
			pair: func(t *testing.T, s *Server, hubURL, master string, conns *node.Connections) string {
				deviceToken, deviceID := pairDevice(t, s.Handler(), master)
				// The shape a version skew has from this side: the machine is
				// connected and it answers, and its answer is that it does not
				// know how to list its own sessions. That is a Mac which has
				// been updated and a NAS which has not, which is the ordinary
				// state of two machines rather than an exotic one.
				runResponder(t, hubURL, deviceToken, &node.Responder{})
				awaitConnected(t, conns, deviceID)
				return deviceID
			},
			want: http.StatusNotImplemented,
			says: "declined to answer",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, master, conns, _ := sessionsServer(t, catalog)
			hub := httptest.NewServer(s.Handler())
			defer hub.Close()
			deviceID := tc.pair(t, s, hub.URL, master, conns)

			rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master,
				map[string]any{"device_id": deviceID})
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.says) {
				t.Fatalf("the answer does not say %q: %s", tc.says, rec.Body.String())
			}
			// Nothing was imported under a machine the Hub could not read, so a
			// console that ignores the status does not end up with rows filed
			// under a machine that never answered.
			if rows := listAgentSessions(t, s.Handler(), master); len(rows) != 0 {
				t.Fatalf("a failed import left %d sessions behind: %+v", len(rows), rows)
			}
		})
	}
}

// A member cannot make the Hub pull another machine's sessions into this one.
//
// The route is gated for operators, and the gate is the same door for both
// branches — but the device branch is the one that reaches a second machine, and
// the rows it lands are what an attach reads its cwd from. So the test is not
// that the route is gated; it is that naming a machine does not open a second
// way in.
func TestAMemberCannotImportAnotherMachinesSessions(t *testing.T) {
	now := time.Now()
	catalog := &nodeCatalog{
		sessions: map[string][]agent.SessionInfo{
			"claude-code": {{
				AgentID: "claude-code", ExternalRef: "node-session-1",
				Title: "on the node", Cwd: "/tmp/project", Status: "idle",
				CreatedAt: now, UpdatedAt: now,
			}},
		},
	}
	s, master, conns, responder := sessionsServerAccounts(t, catalog)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	code, err := s.Accounts.IssueBootstrapCode(t.Context())
	if err != nil {
		t.Fatalf("issue bootstrap code: %v", err)
	}
	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)
	owner.master = master
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	runResponder(t, hub.URL, deviceToken, responder)
	awaitConnected(t, conns, deviceID)

	member := joinMember(t, s, s.Handler(), "session-member", "session-member@example.com")
	rec := member.do(http.MethodPost, "/api/agent-sessions/import",
		fmt.Sprintf(`{"device_id":%q}`, deviceID))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("member import status %d, want 403: %s", rec.Code, rec.Body.String())
	}
	// And the machine was not asked on their behalf: the refusal is a door, not a
	// receipt for work already done. Read as the holder, because a member cannot
	// read this route's list at all and an empty answer from them would prove
	// nothing.
	if rows := listAgentSessions(t, s.Handler(), master); len(rows) != 0 {
		t.Fatalf("a refused import left %d sessions behind: %+v", len(rows), rows)
	}
	// The same request from the holder works, which is what makes the 403 the
	// gate rather than a machine that happens to be unreachable.
	if rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master,
		map[string]any{"device_id": deviceID}); rec.Code != http.StatusOK {
		t.Fatalf("the holder's import status %d: %s", rec.Code, rec.Body.String())
	}
	if rows := listAgentSessions(t, s.Handler(), master); len(rows) != 1 {
		t.Fatalf("the holder's import landed %d sessions, want the machine's one", len(rows))
	}
}

// dialFrames dials the Hub the way a machine does and hands every question to
// answer.
//
// It is how a test produces an answer no well-behaved machine would give: one
// this Hub cannot read, or none at all. The sender arrives after the connection
// is up, so it is held behind a lock rather than captured — the read loop and
// the ready callback are two goroutines.
func dialFrames(
	t *testing.T,
	hubURL, deviceToken string,
	answer func(send node.WriteFunc, query worker.Query),
) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	var mu sync.Mutex
	var send node.WriteFunc
	go func() {
		_ = node.Run(ctx, node.ClientConfig{
			HubURL: hubURL,
			Token:  deviceToken,
			Hello:  testHello(),
			OnFrame: func(_ context.Context, frame worker.Frame) error {
				if frame.Kind != "query" {
					return nil
				}
				query, err := node.Decode[worker.Query](frame)
				if err != nil {
					return err
				}
				mu.Lock()
				writer := send
				mu.Unlock()
				answer(writer, query)
				return nil
			},
			OnReady: func(writer node.WriteFunc) {
				mu.Lock()
				send = writer
				mu.Unlock()
			},
		})
	}()
}

// hubCatalog is this machine's own provider catalog, in the shape the Hub reads
// its local registry through.
//
// It is deliberately not nodeCatalog: that one is the node's interface and this
// one is the Hub's, and a fixture that made them a single type would stop
// noticing the day a machine's answer and this machine's own scan stop being
// the same answer. The two paths agreeing is the point of most of what follows.
type hubCatalog struct {
	sessions []agent.SessionInfo
	page     agent.HistoryPage
}

func (c *hubCatalog) List(context.Context, agent.SessionQuery) ([]agent.SessionInfo, error) {
	return c.sessions, nil
}

func (c *hubCatalog) Inspect(_ context.Context, ref string) (agent.SessionInfo, error) {
	for _, session := range c.sessions {
		if session.ExternalRef == ref {
			return session, nil
		}
	}
	return agent.SessionInfo{}, agent.ErrSessionCatalogUnavailable
}

func (c *hubCatalog) ReadHistory(context.Context, string, agent.HistoryQuery) (agent.HistoryPage, error) {
	return c.page, nil
}

// localSessionsServer is sessionsServer for the other half of the import route:
// this Hub's own catalog, which is what the route reads when it is not naming a
// machine. DesktopID is set because one of the ways to name this machine is its
// desktop id, and an empty id would make that spelling untestable.
func localSessionsServer(t *testing.T, catalog *hubCatalog) (*Server, string) {
	t.Helper()
	s, master, _ := machinesServer(t)
	s.DesktopID = "desktop-hub"
	reg, err := agent.NewRegistry(agent.Entry{
		ID: "claude-code", Name: "Claude Code", Kind: agent.KindCLI,
		Caps: []agent.Capability{
			agent.CapabilityRun,
			agent.CapabilitySessionList,
			agent.CapabilitySessionHistoryRead,
		},
		Runner:  &testAdapter{},
		Catalog: catalog,
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Agents = reg
	return s, master
}

// An import that names no machine — or names this one — reads this machine.
//
// The branch that decides this is one line, and it is the line the slice turns
// on: importing without naming a machine is what every client written before
// this slice sends, and what a console sends when the person taps "import
// sessions" without thinking about machines at all. A Hub whose default had
// become "ask a machine" would answer 503 to all of them, or import nothing,
// while every device test stayed green — they all name a device.
func TestAnImportThatNamesNoMachineReadsThisMachine(t *testing.T) {
	now := time.Now()
	for _, device := range []string{"", "self", "desktop-hub"} {
		t.Run("device_id="+device, func(t *testing.T) {
			s, master := localSessionsServer(t, &hubCatalog{sessions: []agent.SessionInfo{{
				AgentID: "claude-code", ExternalRef: "hub-session-1",
				Title: "on this machine", Cwd: "/tmp/project", Status: "idle",
				Capabilities: []agent.Capability{agent.CapabilitySessionList},
				CreatedAt:    now, UpdatedAt: now,
			}}})
			body := map[string]any{}
			if device != "" {
				body["device_id"] = device
			}
			rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master, body)
			if rec.Code != http.StatusOK {
				t.Fatalf("import status %d: %s", rec.Code, rec.Body.String())
			}
			var imported agentSessionImportResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
				t.Fatal(err)
			}
			if imported.Imported != 1 {
				t.Fatalf("imported %d sessions, want this machine's one: %s",
					imported.Imported, rec.Body.String())
			}
			rows := listAgentSessions(t, s.Handler(), master)
			if len(rows) != 1 {
				t.Fatalf("the list has %d sessions, want 1", len(rows))
			}
			// Filed under *this* machine. A row landed under a named machine
			// would be a session this Hub says it read somewhere else, which is
			// the bookkeeping an attach reads its cwd from.
			if rows[0].DeviceID != "desktop-hub" {
				t.Fatalf("the session is filed under %q, want this machine", rows[0].DeviceID)
			}
		})
	}
}

// A machine with more sessions than one import carries says so — in a field of
// its own, not in the error map.
//
// The count alone reads as the whole of them, so it has to be said; but a
// console counting errors uses that count to decide whether to show a warning,
// and "truncated" is not a provider anybody can go and fix. Reporting it as one
// sends the reader to look at a CLI that is working.
func TestAnImportSaysWhenAMachineHadMoreThanItCouldSend(t *testing.T) {
	now := time.Now()
	sessions := make([]agent.SessionInfo, 0, worker.MaxAgentSessions+1)
	for i := 0; i <= worker.MaxAgentSessions; i++ {
		sessions = append(sessions, agent.SessionInfo{
			AgentID: "claude-code", ExternalRef: fmt.Sprintf("node-session-%d", i),
			Title: "on the node", Cwd: "/tmp/project", Status: "idle",
			CreatedAt: now, UpdatedAt: now,
		})
	}
	s, master, conns, responder := sessionsServer(t, &nodeCatalog{
		sessions: map[string][]agent.SessionInfo{"claude-code": sessions},
	})
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	runResponder(t, hub.URL, deviceToken, responder)
	awaitConnected(t, conns, deviceID)

	rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master,
		map[string]any{"device_id": deviceID})
	if rec.Code != http.StatusOK {
		t.Fatalf("import status %d: %s", rec.Code, rec.Body.String())
	}
	var imported agentSessionImportResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
		t.Fatal(err)
	}
	if imported.Imported != worker.MaxAgentSessions {
		t.Fatalf("imported %d sessions, want the wire's cap %d",
			imported.Imported, worker.MaxAgentSessions)
	}
	if !imported.Truncated {
		t.Fatalf("a machine with %d sessions answered as if it had them all: %s",
			len(sessions), rec.Body.String())
	}
	// A cap is not a failure. The rows that arrived are real, and a caller told
	// otherwise would look for a provider to repair.
	if len(imported.Errors) != 0 {
		t.Fatalf("a capped import reported failures: %v", imported.Errors)
	}
}

// A cursor no wire would carry is refused here too.
//
// The bound is the protocol's, and it exists because a cursor travels in a
// frame. Applying it on only one of the two paths is what makes one session
// page differently depending on where the reader happens to be: the machine
// holding it accepts a cursor that a phone asking for the same session gets a
// 400 for. Both sides of the boundary are asserted, because an off-by-one here
// would refuse the longest cursor a machine is allowed to answer with.
func TestBothHistoryPathsRefuseACursorNoWireWouldCarry(t *testing.T) {
	now := time.Now()
	s, master := localSessionsServer(t, &hubCatalog{
		sessions: []agent.SessionInfo{{
			AgentID: "claude-code", ExternalRef: "hub-session-1", Title: "on this machine",
			Cwd: "/tmp/project", Status: "idle", CreatedAt: now, UpdatedAt: now,
		}},
		page: agent.HistoryPage{Items: []agent.HistoryItem{{
			AgentID: "claude-code", ExternalRef: "hub-session-1",
			MessageID: "m1", Role: "user", Text: "hello",
		}}},
	})
	if rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master, map[string]any{}); rec.Code != http.StatusOK {
		t.Fatalf("import status %d: %s", rec.Code, rec.Body.String())
	}
	rows := listAgentSessions(t, s.Handler(), master)
	if len(rows) != 1 {
		t.Fatalf("the list has %d sessions, want 1", len(rows))
	}
	path := "/api/agent-sessions/" + rows[0].ID + "/history?cursor="

	over := getJSON(t, s.Handler(), master, path+strings.Repeat("c", worker.MaxAgentHistoryCursor+1))
	if over.Code != http.StatusBadRequest {
		t.Fatalf("a cursor of %d bytes answered %d, want 400: %s",
			worker.MaxAgentHistoryCursor+1, over.Code, over.Body.String())
	}
	if !strings.Contains(over.Body.String(), "at most") {
		t.Fatalf("the refusal does not say what the bound is: %s", over.Body.String())
	}
	at := getJSON(t, s.Handler(), master, path+strings.Repeat("c", worker.MaxAgentHistoryCursor))
	if at.Code != http.StatusOK {
		t.Fatalf("a cursor of exactly %d bytes answered %d, want 200: %s",
			worker.MaxAgentHistoryCursor, at.Code, at.Body.String())
	}
}

// A message whose provider recorded no time reads the same from either path.
//
// The two are one field on one transcript, and they used to disagree: this
// machine answered the zero time's UnixMilli, which is the year 1, while the
// wire answered zero. A client cannot tell a sentinel from a date it has never
// seen, so the number that means "no time" has to be the same number whichever
// machine was asked.
func TestAMessageWithNoTimeReadsTheSameFromEitherPath(t *testing.T) {
	item := agent.HistoryItem{
		AgentID: "claude-code", ExternalRef: "session-1", MessageID: "m1",
		Role: "user", Text: "no time recorded",
	}

	t.Run("this machine", func(t *testing.T) {
		s, master := localSessionsServer(t, &hubCatalog{
			sessions: []agent.SessionInfo{{
				AgentID: "claude-code", ExternalRef: "session-1", Title: "on this machine",
				Cwd: "/tmp/project", Status: "idle",
			}},
			page: agent.HistoryPage{Items: []agent.HistoryItem{item}},
		})
		if rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master, map[string]any{}); rec.Code != http.StatusOK {
			t.Fatalf("import status %d: %s", rec.Code, rec.Body.String())
		}
		rows := listAgentSessions(t, s.Handler(), master)
		rec := getJSON(t, s.Handler(), master, "/api/agent-sessions/"+rows[0].ID+"/history")
		if rec.Code != http.StatusOK {
			t.Fatalf("history status %d: %s", rec.Code, rec.Body.String())
		}
		var page agentSessionHistoryResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != 1 {
			t.Fatalf("the page has %d items, want 1", len(page.Items))
		}
		if page.Items[0].OccurredAt != 0 {
			t.Fatalf("a message with no time came back as %d, want the zero sentinel",
				page.Items[0].OccurredAt)
		}
	})

	t.Run("another machine", func(t *testing.T) {
		s, master, conns, responder := sessionsServer(t, &nodeCatalog{
			sessions: map[string][]agent.SessionInfo{
				"claude-code": {{
					AgentID: "claude-code", ExternalRef: "session-1", Title: "on the node",
					Cwd: "/tmp/project", Status: "idle",
				}},
			},
			page: agent.HistoryPage{Items: []agent.HistoryItem{item}},
		})
		hub := httptest.NewServer(s.Handler())
		defer hub.Close()
		deviceToken, deviceID := pairDevice(t, s.Handler(), master)
		runResponder(t, hub.URL, deviceToken, responder)
		awaitConnected(t, conns, deviceID)

		if rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master,
			map[string]any{"device_id": deviceID}); rec.Code != http.StatusOK {
			t.Fatalf("import status %d: %s", rec.Code, rec.Body.String())
		}
		rows := listAgentSessions(t, s.Handler(), master)
		rec := getJSON(t, s.Handler(), master, "/api/agent-sessions/"+rows[0].ID+"/history")
		if rec.Code != http.StatusOK {
			t.Fatalf("history status %d: %s", rec.Code, rec.Body.String())
		}
		var page agentSessionHistoryResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != 1 {
			t.Fatalf("the page has %d items, want 1", len(page.Items))
		}
		if page.Items[0].OccurredAt != 0 {
			t.Fatalf("the machine's no-time message came back as %d, want the zero sentinel",
				page.Items[0].OccurredAt)
		}
	})
}

// fileSession records a session as if it had been imported from that machine,
// which is the state a reader is in when the machine goes away: the row is here
// and the conversation is there.
func fileSession(t *testing.T, s *Server, device string, now time.Time) store.AgentSession {
	t.Helper()
	row, err := s.Store.UpsertAgentSession(context.Background(), fromAgentSession(agent.SessionInfo{
		AgentID: "claude-code", ExternalRef: "node-session-1", Title: "on the node",
		Cwd: "/tmp/project", Status: "idle", CreatedAt: now, UpdatedAt: now,
	}, device))
	if err != nil {
		t.Fatal(err)
	}
	return row
}

// Reading one session's transcript off a paired machine fails the way asking
// that machine anything else fails.
//
// The mapping is shared with every other machine question and is asserted
// through the import route; what this pins is this route's wiring to it. The
// case is a phone opening a session that lives on a Mac which has since gone to
// sleep, and the difference between the statuses is the whole of what the reader
// can do about it: 409 says wake that machine or read another session, where a
// 500 would say this Hub is broken and a 404 would say the session is gone.
func TestReadingATranscriptOffAMachineFailsInTheWayTheCallerCanAct(t *testing.T) {
	now := time.Now()
	catalog := &nodeCatalog{
		sessions: map[string][]agent.SessionInfo{
			"claude-code": {{
				AgentID: "claude-code", ExternalRef: "node-session-1",
				Title: "on the node", Cwd: "/tmp/project", Status: "idle",
				CreatedAt: now, UpdatedAt: now,
			}},
		},
	}

	cases := []struct {
		name string
		// file puts the Hub in the state the case is about and returns the row
		// the reader will open.
		file func(t *testing.T, s *Server, hubURL, master string, conns *node.Connections) store.AgentSession
		want int
		says string
	}{
		{
			name: "a machine that is paired but not connected",
			file: func(t *testing.T, s *Server, _ string, master string, _ *node.Connections) store.AgentSession {
				_, deviceID := pairDevice(t, s.Handler(), master)
				return fileSession(t, s, deviceID, now)
			},
			want: http.StatusConflict,
			says: "not connected",
		},
		{
			name: "a machine that reads the question and declines it",
			file: func(t *testing.T, s *Server, hubURL, master string, conns *node.Connections) store.AgentSession {
				deviceToken, deviceID := pairDevice(t, s.Handler(), master)
				// Connected, answering, and older than the question: the shape
				// two machines are in for as long as it takes to update both.
				runResponder(t, hubURL, deviceToken, &node.Responder{})
				awaitConnected(t, conns, deviceID)
				return fileSession(t, s, deviceID, now)
			},
			want: http.StatusNotImplemented,
			says: "declined to answer",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, master, conns, _ := sessionsServer(t, catalog)
			hub := httptest.NewServer(s.Handler())
			defer hub.Close()
			row := tc.file(t, s, hub.URL, master, conns)

			rec := getJSON(t, s.Handler(), master, "/api/agent-sessions/"+row.ID+"/history")
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.says) {
				t.Fatalf("the answer does not say %q: %s", tc.says, rec.Body.String())
			}
		})
	}
}

// countingCatalog answers as the machine would and remembers being asked.
//
// The distinction it exists for is that between this Hub's own answer and the
// machine's: both are a 200 carrying a per-provider failure, so the status alone
// cannot tell a question that was answered from one that was never sent.
type countingCatalog struct {
	node.SessionCatalog
	mu    sync.Mutex
	asked []string
}

func (c *countingCatalog) ListSessions(ctx context.Context, agentID string, q agent.SessionQuery) ([]agent.SessionInfo, error) {
	c.mu.Lock()
	c.asked = append(c.asked, agentID)
	c.mu.Unlock()
	return c.SessionCatalog.ListSessions(ctx, agentID, q)
}

func (c *countingCatalog) asks() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.asked...)
}

// A provider name no catalog can be asked about is answered here rather than
// sent on to be refused there.
//
// A name longer than the wire's bound is a caller's mistake, and a machine that
// receives it says so in its own words — which reach the reader as a refusal by
// the machine, about a limit the machine did not choose. This machine's own scan
// has always answered that shape of problem softly, beside the providers that
// worked, and the two paths ask the same question.
func TestAProviderNameNoWireWouldCarryIsAnsweredWithoutAsking(t *testing.T) {
	now := time.Now()
	catalog := &countingCatalog{SessionCatalog: &nodeCatalog{
		sessions: map[string][]agent.SessionInfo{
			"claude-code": {{
				AgentID: "claude-code", ExternalRef: "node-session-1",
				Title: "on the node", Cwd: "/tmp/project", Status: "idle",
				CreatedAt: now, UpdatedAt: now,
			}},
		},
	}}
	// The counter is handed to the machine rather than to this Hub, so it counts
	// the questions that actually crossed the wire.
	s, master, conns, responder := sessionsServer(t, catalog)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	runResponder(t, hub.URL, deviceToken, responder)
	awaitConnected(t, conns, deviceID)

	tooLong := strings.Repeat("a", worker.MaxAgentID+1)
	rec := postJSON(t, s.Handler(), "/api/agent-sessions/import", master,
		map[string]any{"device_id": deviceID, "agents": []string{tooLong}})
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 — a provider this Hub cannot ask about is one provider's failure, not the import's: %s",
			rec.Code, rec.Body.String())
	}
	var imported agentSessionImportResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
		t.Fatal(err)
	}
	if imported.Imported != 0 {
		t.Fatalf("imported %d sessions for a name that cannot name one: %s", imported.Imported, rec.Body.String())
	}
	reason, ok := imported.Errors[tooLong]
	if !ok {
		t.Fatalf("the import does not say why that provider was not read: %v", imported.Errors)
	}
	if !strings.Contains(reason, fmt.Sprintf("exceeds %d bytes", worker.MaxAgentID)) {
		t.Fatalf("the reason is not this Hub's own bound on the name: %q", reason)
	}
	// The whole point: the machine was never asked. A question this Hub can see
	// is unanswerable is not worth a round trip, and the answer it would get
	// back reads as a fault of the machine rather than of the name.
	if asks := catalog.asks(); len(asks) != 0 {
		t.Fatalf("the machine was asked about %q anyway", asks)
	}
}
