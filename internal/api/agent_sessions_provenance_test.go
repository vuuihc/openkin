package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// These two tests pin the one field the attach route writes in two places: the
// machine a native session ref was minted on. A session id is only resolvable by
// the agent that produced it, so a task carrying the ref without its provenance
// reads as "local" everywhere, and a later turn hands a CLI an id it has never
// seen -- while reporting success.
const (
	foreignDeviceID  = "other-machine"
	foreignSessionID = "sess-from-elsewhere"
)

// silentAdapter accepts a turn and never answers it. The attach handler's own
// write is what these tests read, and a turn that reports a session id rewrites
// session_ref (and clears its provenance) on the task it just ran, a moment
// after the attach -- which would hide the row under test behind a different
// write, and leave the assertion racing the run loop.
type silentAdapter struct{}

func (a *silentAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event)
	h := &testHandle{ch: ch, cancelCh: make(chan struct{})}
	go func() {
		defer close(ch)
		select {
		case <-ctx.Done():
		case <-h.cancelCh:
		}
	}()
	return h, nil
}

// attachTestServer is newTestServer plus the two things the attach route needs
// and the harness does not build: a registry, and a run that stays out of the
// way. The registry is asked whether the session's agent can run here, so
// claude-code has to answer runnable or the route refuses the request outright.
func attachTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	s, token := newTestServer(t)
	runner := &silentAdapter{}
	eng := task.NewEngineFromAdapters(s.Store, map[string]adapter.Adapter{"claude-code": runner}, task.NewBus(), 4)
	t.Cleanup(eng.Close)
	if err := eng.Recover(context.Background()); err != nil {
		t.Fatalf("recover attach test engine: %v", err)
	}
	s.Engine = eng
	s.Agents = agent.MustRegistry(agent.Entry{
		ID: "claude-code", Name: "Claude Code", Priority: 20,
		Caps:   []agent.Capability{agent.CapabilityRun, agent.CapabilityResume},
		Runner: runner,
	})
	return s, token
}

// seedForeignSession indexes one provider session whose agent ran on another
// machine: the row an attach has to carry provenance for.
func seedForeignSession(t *testing.T, st *store.Store, cwd string) store.AgentSession {
	t.Helper()
	now := store.NowMilli()
	row, err := st.UpsertAgentSession(context.Background(), store.AgentSession{
		ID:           "01FOREIGNSESSION00000000000",
		DeviceID:     foreignDeviceID,
		AgentID:      "claude-code",
		ExternalRef:  foreignSessionID,
		Title:        "started elsewhere",
		Cwd:          cwd,
		Status:       "idle",
		Capabilities: []string{string(agent.CapabilitySessionAttach)},
		FirstSeenAt:  now,
		LastSeenAt:   now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatalf("seed agent session: %v", err)
	}
	return row
}

// attach posts an attach request for a session and returns the response.
func attach(t *testing.T, s *Server, token, sessionID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/agent-sessions/"+sessionID+"/attach",
		bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, req)
	return rr
}

// A session imported from another machine is attached here but remains that
// machine's session. The task has to say so: without the device on the row, the
// resume path checks an id against the local machine, decides it can resolve it,
// and resumes nothing.
func TestAttachForeignSessionToNewTaskKeepsProvenance(t *testing.T) {
	s, token := attachTestServer(t)
	cwd := t.TempDir()
	row := seedForeignSession(t, s.Store, cwd)

	rr := attach(t, s, token, row.ID, `{"prompt":"carry on"}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("attach a foreign session to a new task: status %d body %s", rr.Code, rr.Body.String())
	}
	var created agentSessionAttachResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatalf("attach response is not an attached task: %v (%s)", err, rr.Body.String())
	}
	if created.Task.ID == "" {
		t.Fatalf("attach created no task: %s", rr.Body.String())
	}

	// The 201 only says the handler was happy. The row is what the resume path
	// reads later, and it is the row that can lose the device.
	got, err := s.Store.GetTask(context.Background(), created.Task.ID)
	if err != nil {
		t.Fatalf("re-read attached task: %v", err)
	}
	if got.SessionRefDeviceID == nil || *got.SessionRefDeviceID != foreignDeviceID {
		t.Fatalf("attached task session_ref_device_id = %v, want %q: the task would resume a session only another machine can resolve",
			got.SessionRefDeviceID, foreignDeviceID)
	}
	if got.SessionRef == nil || *got.SessionRef != foreignSessionID {
		t.Fatalf("attached task session_ref = %v, want %q", got.SessionRef, foreignSessionID)
	}
}

// The same invariant where the task already exists. This path moves the ref and
// its provenance together, so a task that had no native session of its own
// cannot come out of it labelled as the owner of a session it does not own.
func TestAttachForeignSessionToExistingTaskWritesProvenance(t *testing.T) {
	s, token := attachTestServer(t)
	ctx := context.Background()
	cwd := t.TempDir()
	row := seedForeignSession(t, s.Store, cwd)

	// A finished task on the same agent and the same directory, with no native
	// session of its own yet: the state just before a session is attached to it.
	taskID := "01FOREIGNATTACHTASK0000000000"
	if err := s.Store.InsertTask(ctx, store.Task{
		ID: taskID, Title: "existing task", Agent: "claude-code", Cwd: cwd,
		Prompt: "earlier turn", Status: task.StatusSucceeded, CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatalf("seed task: %v", err)
	}

	rr := attach(t, s, token, row.ID, `{"task_id":"`+taskID+`"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("attach a foreign session to an existing task: status %d body %s", rr.Code, rr.Body.String())
	}

	got, err := s.Store.GetTask(ctx, taskID)
	if err != nil {
		t.Fatalf("re-read attached task: %v", err)
	}
	if got.SessionRefDeviceID == nil || *got.SessionRefDeviceID != foreignDeviceID {
		t.Fatalf("attached task session_ref_device_id = %v, want %q: the task would resume a session only another machine can resolve",
			got.SessionRefDeviceID, foreignDeviceID)
	}
	if got.SessionRef == nil || *got.SessionRef != foreignSessionID {
		t.Fatalf("attached task session_ref = %v, want %q", got.SessionRef, foreignSessionID)
	}
}
