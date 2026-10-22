package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
	"github.com/vuuihc/openkin/internal/workspace"
)

// remoteHub is a Hub that can dispatch and cannot execute: it has no agents of
// its own. That is what makes the dispatch path the only way these tests can
// pass — a turn that quietly ran here would fail with "unknown agent".
func remoteHub(t *testing.T) (*Server, string, *node.Connections, *node.Turns) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	const token = "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb"
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{}, task.NewBus(), 4)
	t.Cleanup(eng.Close)
	if err := eng.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The production wiring, including the part that would stat a cwd and cut a
	// worktree in it. Leaving this out is what hid the fact that a remote task
	// was being prepared here at all.
	eng.SetWorkspaceRuntime(workspace.NewManager(t.TempDir()))

	turns := node.NewTurns()
	conns := node.NewConnections(func(sender node.Sender) { turns.Abandon(sender) })
	eng.SetRemoteRunner("hub-machine", func(stored store.Task, executionID string) (adapter.Adapter, error) {
		return &node.Adapter{Conns: conns, Turns: turns, DeviceID: stored.ExecutingDeviceID}, nil
	})

	return &Server{
		Store:      st,
		Auth:       remote.NewAuth(token),
		Engine:     eng,
		Version:    "test",
		Workers:    worker.NewRegistry(time.Minute, nil),
		DesktopID:  "hub-machine",
		Nodes:      conns,
		NodeFrames: turns.RouteFrame,
	}, token, conns, turns
}

// nodeHello is what the other machine announces: this machine's version, and
// the directories it is willing to work in.
func nodeHello(roots ...string) worker.Hello {
	hello := testHello()
	hello.WorkspaceRoots = make([]worker.WorkspaceRoot, 0, len(roots))
	for _, root := range roots {
		hello.WorkspaceRoots = append(hello.WorkspaceRoots, worker.WorkspaceRoot{Path: root})
	}
	return hello
}

// postJSON posts a body and returns the recorder.
func postJSON(t *testing.T, h http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// createTask posts a task and returns it, failing the test on any error.
func createTask(t *testing.T, h http.Handler, token string, body map[string]any) store.Task {
	t.Helper()
	rec := postJSON(t, h, "/api/tasks", token, body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create task: %d %s", rec.Code, rec.Body.String())
	}
	var created store.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	return created
}

// awaitTaskStatus polls until a task reaches want, or fails with whatever it
// did instead.
func awaitTaskStatus(t *testing.T, s *Server, taskID, want string) store.Task {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var last store.Task
	for time.Now().Before(deadline) {
		stored, err := s.Store.GetTask(context.Background(), taskID)
		if err == nil {
			last = stored
			if stored.Status == want {
				return stored
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	events, _ := s.Store.ListEvents(context.Background(), taskID, 0)
	t.Fatalf("task status = %q, want %q (events: %+v)", last.Status, want, events)
	return store.Task{}
}

// said returns everything the transcript said went wrong, in order.
func said(t *testing.T, s *Server, taskID string) string {
	t.Helper()
	events, err := s.Store.ListEvents(context.Background(), taskID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var messages []string
	for _, event := range events {
		if event.Type == "error" {
			messages = append(messages, string(event.Payload))
		}
	}
	return strings.Join(messages, " | ")
}

// e2eAgent stands in for the agent installed on the other machine.
type e2eAgent struct{ events []adapter.Event }

func (a *e2eAgent) Start(ctx context.Context, _ adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event, len(a.events)+1)
	go func() {
		defer close(ch)
		for _, event := range a.events {
			select {
			case ch <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	return &e2eHandle{ch: ch}, nil
}

type e2eHandle struct{ ch chan adapter.Event }

func (h *e2eHandle) Events() <-chan adapter.Event { return h.ch }
func (h *e2eHandle) Cancel() error                { return nil }

// e2eRunners is the other machine's agent registry: it has exactly one agent.
type e2eRunners struct{ agent adapter.Adapter }

func (r e2eRunners) Runnable(_ context.Context, agentID string) (adapter.Adapter, error) {
	if agentID != "claude-code" {
		return nil, fmt.Errorf("%s is not installed on this machine", agentID)
	}
	return r.agent, nil
}

// emptyRunners is a machine that announced an agent and then cannot run it:
// uninstalled between the hello and the dispatch.
type emptyRunners struct{}

func (emptyRunners) Runnable(_ context.Context, agentID string) (adapter.Adapter, error) {
	return nil, fmt.Errorf("%s was uninstalled on this machine", agentID)
}

// startExecutor dials the Hub for real — WebSocket, handshake, heartbeats — and
// runs whatever it is sent with the given agent.
func startExecutor(t *testing.T, hubURL, deviceToken string, roots []string, agent *e2eAgent) *node.Executor {
	t.Helper()
	return startRunners(t, hubURL, deviceToken, roots, e2eRunners{agent: agent})
}

// startRunners is startExecutor with the machine's agent layer supplied, which
// is how a test makes the machine disagree with what it announced.
func startRunners(t *testing.T, hubURL, deviceToken string, roots []string, runners node.Runners) *node.Executor {
	t.Helper()
	executor := &node.Executor{Runners: runners, Roots: roots}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		_ = node.Run(ctx, node.ClientConfig{
			HubURL:  hubURL,
			Token:   deviceToken,
			Hello:   nodeHello(roots...),
			OnFrame: executor.Handle,
			OnReady: executor.SetSender,
			Warn:    func(format string, args ...any) { t.Logf("node: "+format, args...) },
		})
	}()
	return executor
}

// awaitOnline waits for the Hub to have a live channel to the machine.
func awaitOnline(t *testing.T, conns *node.Connections, deviceID string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if conns.Connected(deviceID) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the machine never connected to the hub")
}

// TestRemoteTurnEndToEnd is the M2.2 acceptance path: a task created on the Hub
// naming another machine, dispatched over a real control channel, executed
// there, and stored here under the Hub's own sequence numbers.
func TestRemoteTurnEndToEnd(t *testing.T) {
	s, master, conns, turns := remoteHub(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)

	work := t.TempDir()
	remote := &e2eAgent{events: []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{"session_id":"remote-session-1","subtype":"init"}`)},
		{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"done over here"}],"partial":false}`)},
		{Type: "result", Payload: json.RawMessage(`{"cost_usd":0.03,"tokens_in":7,"tokens_out":9,"is_error":false}`)},
	}}
	executor := startExecutor(t, hub.URL, deviceToken, []string{work}, remote)
	awaitOnline(t, conns, deviceID)

	created := createTask(t, s.Handler(), master, map[string]any{
		"agent": "claude-code", "cwd": work, "prompt": "do the thing over there",
		"executing_device_id": deviceID,
	})
	if created.ExecutingDeviceID != deviceID {
		t.Fatalf("created = %+v", created)
	}

	awaitTaskStatus(t, s, created.ID, task.StatusSucceeded)

	// The transcript is ordinary rows the console already knows how to read, and
	// the Hub allocated their order: no holes, same guarantee as a local turn.
	events, err := s.Store.ListEvents(context.Background(), created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	// The user's own prompt, then the three the remote agent produced.
	if len(events) != 4 {
		t.Fatalf("events = %+v", events)
	}
	for i, event := range events {
		if event.Seq != i+1 {
			t.Fatalf("event %d has seq %d", i, event.Seq)
		}
	}
	var types []string
	for _, event := range events {
		types = append(types, event.Type)
	}
	if got := strings.Join(types, ","); got != "message,task_started,message,result" {
		t.Fatalf("event types = %s", got)
	}

	stored, err := s.Store.GetTask(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The session the agent reported on the other machine came back with the
	// events, so the next turn can resume it (M2.3 owns per-device resolution).
	if stored.SessionRef == nil || *stored.SessionRef != "remote-session-1" {
		t.Fatalf("session_ref = %v, want the ref the remote agent reported", stored.SessionRef)
	}
	// Usage is accounted where the session lives, wherever the turn ran.
	if stored.TokensIn != 7 || stored.TokensOut != 9 {
		t.Fatalf("tokens = %d/%d, want 7/9", stored.TokensIn, stored.TokensOut)
	}
	if stored.CostUSD == nil || *stored.CostUSD != 0.03 {
		t.Fatalf("cost = %v, want 0.03", stored.CostUSD)
	}

	// A dispatched turn leaves nothing running on either side.
	if running := turns.Running(""); len(running) != 0 {
		t.Fatalf("turns still open on the hub: %v", running)
	}
	if running := executor.Running(); len(running) != 0 {
		t.Fatalf("turns still running on the machine: %v", running)
	}
}

// TestRemoteTurnIsRefusedOutsideTheMachinesRoots is the containment boundary: a
// Hub asking for a directory this machine never agreed to work in is refused on
// the machine that owns the filesystem.
func TestRemoteTurnIsRefusedOutsideTheMachinesRoots(t *testing.T) {
	s, master, conns, turns := remoteHub(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)

	work := t.TempDir()
	remote := &e2eAgent{events: []adapter.Event{{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)}}}
	startExecutor(t, hub.URL, deviceToken, []string{work}, remote)
	awaitOnline(t, conns, deviceID)

	// The Hub is another party and cannot be trusted to bound itself, so it is
	// not the one that decides.
	elsewhere := t.TempDir()
	created := createTask(t, s.Handler(), master, map[string]any{
		"agent": "claude-code", "cwd": elsewhere, "prompt": "look at my private files",
		"executing_device_id": deviceID,
	})
	stored := awaitTaskStatus(t, s, created.ID, task.StatusFailed)
	if stored.Status != task.StatusFailed {
		t.Fatalf("status = %q", stored.Status)
	}
	if message := said(t, s, created.ID); message == "" {
		t.Fatal("the refusal arrived with no reason")
	}
	if running := turns.Running(""); len(running) != 0 {
		t.Fatalf("turns still open on the hub: %v", running)
	}
}

// TestRemoteTurnFailsWhenTheDeviceIsGone: a dispatch aimed at a machine that is
// not connected has to fail the task, with a reason, and leave nothing behind.
func TestRemoteTurnFailsWhenTheDeviceIsGone(t *testing.T) {
	s, master, _, turns := remoteHub(t)

	// Paired, so the Hub knows the device, but never connected.
	_, deviceID := pairDevice(t, s.Handler(), master)
	created := createTask(t, s.Handler(), master, map[string]any{
		"agent": "claude-code", "cwd": t.TempDir(), "prompt": "run somewhere unreachable",
		"executing_device_id": deviceID,
	})
	awaitTaskStatus(t, s, created.ID, task.StatusFailed)
	if message := said(t, s, created.ID); message == "" {
		t.Fatal("the failure arrived with no reason")
	}
	if running := turns.Running(""); len(running) != 0 {
		t.Fatalf("a turn was left open for a machine that was never there: %v", running)
	}
}

// TestRemoteTurnFailsWhenTheAgentIsNotThere: the Hub accepted the agent because
// the machine said it had it, and the machine turned out not to. The failure has
// to come back with the machine's own reason rather than hang.
func TestRemoteTurnFailsWhenTheAgentIsNotThere(t *testing.T) {
	s, master, conns, turns := remoteHub(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	work := t.TempDir()
	// The hello still advertises claude-code; the agent layer does not have it.
	startRunners(t, hub.URL, deviceToken, []string{work}, emptyRunners{})
	awaitOnline(t, conns, deviceID)

	created := createTask(t, s.Handler(), master, map[string]any{
		"agent": "claude-code", "cwd": work, "prompt": "run this",
		"executing_device_id": deviceID,
	})
	awaitTaskStatus(t, s, created.ID, task.StatusFailed)
	if message := said(t, s, created.ID); !strings.Contains(message, "uninstalled") {
		t.Fatalf("the machine's reason was lost: %q", message)
	}
	if running := turns.Running(""); len(running) != 0 {
		t.Fatalf("turns still open on the hub: %v", running)
	}
}

// TestRemoteTurnEndsWhenTheMachineDisconnects: the transcript must be closed
// with a reason rather than left waiting on a socket that is gone.
func TestRemoteTurnEndsWhenTheMachineDisconnects(t *testing.T) {
	s, master, conns, turns := remoteHub(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)

	work := t.TempDir()
	// An agent that never finishes: it blocks until its context is canceled.
	blocking := &blockingAgent{started: make(chan struct{})}
	executor := &node.Executor{Runners: e2eRunners{agent: blocking}, Roots: []string{work}}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		_ = node.Run(ctx, node.ClientConfig{
			HubURL:  hub.URL,
			Token:   deviceToken,
			Hello:   nodeHello(work),
			OnFrame: executor.Handle,
			OnReady: executor.SetSender,
			Warn:    func(format string, args ...any) { t.Logf("node: "+format, args...) },
		})
	}()
	awaitOnline(t, conns, deviceID)

	created := createTask(t, s.Handler(), master, map[string]any{
		"agent": "claude-code", "cwd": work, "prompt": "run until the cable is pulled",
		"executing_device_id": deviceID,
	})
	select {
	case <-blocking.started:
	case <-time.After(10 * time.Second):
		t.Fatal("the turn never reached the other machine")
	}

	cancel()
	awaitTaskStatus(t, s, created.ID, task.StatusFailed)
	if message := said(t, s, created.ID); message == "" {
		t.Fatal("the disconnection was not explained")
	}
	// The Hub is not left holding a turn for a machine it can no longer reach.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && len(turns.Running("")) != 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if running := turns.Running(""); len(running) != 0 {
		t.Fatalf("turns still open after the machine went away: %v", running)
	}
}

// blockingAgent runs a turn that only ends when it is canceled.
type blockingAgent struct{ started chan struct{} }

func (a *blockingAgent) Start(ctx context.Context, _ adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event, 1)
	if a.started != nil {
		close(a.started)
	}
	go func() {
		<-ctx.Done()
		close(ch)
	}()
	return &e2eHandle{ch: ch}, nil
}

// TestRemoteTaskIsNotPreparedOnTheHub pins the boundary the whole feature rests
// on: a remote task's cwd is another machine's path, so the Hub neither checks
// that it exists nor rewrites it into a worktree of its own. A Hub that stats
// the path rejects precisely the tasks it exists to dispatch — the directory it
// cannot see is the normal case, not an error.
func TestRemoteTaskIsNotPreparedOnTheHub(t *testing.T) {
	s, master, conns, _ := remoteHub(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	work := t.TempDir()
	startExecutor(t, hub.URL, deviceToken, []string{work}, &e2eAgent{})
	awaitOnline(t, conns, deviceID)

	// A path that exists on the machine that will run the turn, and nowhere
	// else as far as the Hub is concerned.
	remoteOnly := filepath.Join(work, "checkout")

	// The Hub has no such directory, and accepts the task anyway.
	created := createTask(t, s.Handler(), master, map[string]any{
		"agent": "claude-code", "cwd": remoteOnly, "prompt": "work in my checkout",
		"executing_device_id": deviceID,
	})
	if created.ExecutionCwd != remoteOnly || created.Cwd != remoteOnly {
		t.Fatalf("the hub rewrote the path: cwd=%q execution_cwd=%q, want %q",
			created.Cwd, created.ExecutionCwd, remoteOnly)
	}
	if created.WorkspaceMode == "worktree" {
		t.Fatalf("the hub cut a worktree for another machine's directory: %+v", created)
	}
	if created.WorkspacePolicy != string(store.WorkspacePolicyShared) {
		t.Fatalf("workspace policy = %q, want shared", created.WorkspacePolicy)
	}

	// The turn reaches the machine, which is the one that decides: the
	// directory is not there, and that is its call to make, with its own reason.
	awaitTaskStatus(t, s, created.ID, task.StatusFailed)
	if message := said(t, s, created.ID); !strings.Contains(message, "not a directory this machine works in") {
		t.Fatalf("the failure did not come from the machine: %q", message)
	}
}

// TestCreateRejectsAnUnknownDevice keeps a typo from becoming a task that only
// fails once a turn starts.
func TestCreateRejectsAnUnknownDevice(t *testing.T) {
	s, master, _, _ := remoteHub(t)

	rec := postJSON(t, s.Handler(), "/api/tasks", master, map[string]any{
		"agent": "claude-code", "cwd": t.TempDir(), "prompt": "go nowhere",
		"executing_device_id": "device-that-does-not-exist",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unknown device") {
		t.Fatalf("body = %s", rec.Body.String())
	}

	// This daemon is a valid answer even though it is not paired with itself:
	// the objection here is that it has no agents, not that it is unknown.
	rec = postJSON(t, s.Handler(), "/api/tasks", master, map[string]any{
		"agent": "claude-code", "cwd": t.TempDir(), "prompt": "run here",
		"executing_device_id": "hub-machine",
	})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "agent") {
		t.Fatalf("the hub's own id: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "unknown device") {
		t.Fatalf("the hub does not know itself: %s", rec.Body.String())
	}
}

// TestCreateRejectsARevokedDevice: revocation is not only about refusing the
// next handshake. A task aimed at a machine the Hub has cut off can never run,
// so it is refused while the user is still looking at the form.
func TestCreateRejectsARevokedDevice(t *testing.T) {
	s, master, _, _ := remoteHub(t)
	_, deviceID := pairDevice(t, s.Handler(), master)
	if err := s.Store.RevokeDeviceCredential(context.Background(), deviceID, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	rec := postJSON(t, s.Handler(), "/api/tasks", master, map[string]any{
		"agent": "claude-code", "cwd": t.TempDir(), "prompt": "go nowhere",
		"executing_device_id": deviceID,
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "revoked") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestCreateRefusesWorktreeIsolationOnAnotherMachine: the Hub cannot cut a
// worktree in a directory it does not have, and running the task in that
// machine's shared checkout instead would be a silent downgrade — two tasks
// editing the same files while the user believes they are isolated.
func TestCreateRefusesWorktreeIsolationOnAnotherMachine(t *testing.T) {
	s, master, conns, _ := remoteHub(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	work := t.TempDir()
	startExecutor(t, hub.URL, deviceToken, []string{work}, &e2eAgent{})
	awaitOnline(t, conns, deviceID)

	rec := postJSON(t, s.Handler(), "/api/tasks", master, map[string]any{
		"agent": "claude-code", "cwd": work, "prompt": "isolate me over there",
		"workspace_mode": "worktree", "executing_device_id": deviceID,
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "another machine") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestForkRunsWhereTheSourceRuns: a fork continues the same conversation in the
// same directory. Carrying only the cwd would leave the branch on the Hub, in a
// different checkout of the same repository, with a session ref the agent there
// never issued — the user asked to continue that work, not to copy it here.
func TestForkRunsWhereTheSourceRuns(t *testing.T) {
	s, master, conns, _ := remoteHub(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	work := t.TempDir()
	startExecutor(t, hub.URL, deviceToken, []string{work}, &e2eAgent{})
	awaitOnline(t, conns, deviceID)

	source := createTask(t, s.Handler(), master, map[string]any{
		"agent": "claude-code", "cwd": work, "prompt": "work over there",
		"executing_device_id": deviceID,
	})
	awaitTaskStatus(t, s, source.ID, task.StatusFailed) // the fake agent reports nothing

	// No prompt: a fork that is a browsable copy, so nothing is dispatched and
	// the assertion is about the row rather than about a second turn.
	rec := postJSON(t, s.Handler(), "/api/tasks/"+source.ID+"/fork", master, map[string]any{})
	if rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
		t.Fatalf("fork: %d %s", rec.Code, rec.Body.String())
	}
	var forked store.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &forked); err != nil {
		t.Fatal(err)
	}
	if forked.ExecutingDeviceID != deviceID {
		t.Fatalf("fork runs on %q, want the source's machine %q", forked.ExecutingDeviceID, deviceID)
	}
	if forked.WorkspacePolicy != string(store.WorkspacePolicyShared) {
		t.Fatalf("fork workspace policy = %q, want shared", forked.WorkspacePolicy)
	}
	if forked.WorkspaceMode == "worktree" {
		t.Fatalf("the hub cut a worktree for a fork of another machine's task: %+v", forked)
	}
	if forked.ExecutionCwd != work || forked.Cwd != work {
		t.Fatalf("fork cwd = %q/%q, want %q", forked.Cwd, forked.ExecutionCwd, work)
	}
}

// TestWorkspaceFilesAreNotServedFromTheHub: the console renders a Files panel
// for every task, and the Hub has no filesystem for one that runs elsewhere.
// Answering the request from here would read — and on a write, overwrite — this
// machine's own directory at the same address, which is usually a different
// checkout of the same repository, so the mistake would go unnoticed.
func TestWorkspaceFilesAreNotServedFromTheHub(t *testing.T) {
	s, master, conns, _ := remoteHub(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	// A directory that exists here *and* is the task's cwd: the guard has to
	// hold even when the path would resolve.
	work := t.TempDir()
	startExecutor(t, hub.URL, deviceToken, []string{work}, &e2eAgent{})
	awaitOnline(t, conns, deviceID)

	created := createTask(t, s.Handler(), master, map[string]any{
		"agent": "claude-code", "cwd": work, "prompt": "list my files",
		"executing_device_id": deviceID,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+created.ID+"/workspace/list?path=.", nil)
	req.Header.Set("Authorization", "Bearer "+master)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), deviceID) {
		t.Fatalf("the refusal does not say where the files are: %s", rec.Body.String())
	}

	body, err := json.Marshal(map[string]string{"path": "note.txt", "content": "clobbered"})
	if err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPut, "/api/tasks/"+created.ID+"/workspace/file", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+master)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("write: %d %s", rec.Code, rec.Body.String())
	}
	// Nothing was written here: the whole point is that the Hub's own copy of
	// that path is not the one the user is looking at.
	if _, err := os.Stat(filepath.Join(work, "note.txt")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the hub wrote into its own directory: %v", err)
	}
}

// TestCreateJudgesTheAgentOnTheMachineThatWillRunIt: a Hub with no agents
// accepts work for a machine that has them, and still catches the case where
// that machine reported the agent missing or unusable.
func TestCreateJudgesTheAgentOnTheMachineThatWillRunIt(t *testing.T) {
	s, master, conns, _ := remoteHub(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	work := t.TempDir()
	// The hello is the only thing that says what this machine has: testHello
	// reports claude-code available and codex installed but not signed in.
	startExecutor(t, hub.URL, deviceToken, []string{work}, &e2eAgent{})
	awaitOnline(t, conns, deviceID)

	rec := postJSON(t, s.Handler(), "/api/tasks", master, map[string]any{
		"agent": "codex", "cwd": work, "prompt": "run this",
		"executing_device_id": deviceID,
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an unusable agent was accepted: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not signed in") {
		t.Fatalf("the machine's own reason was lost: %s", rec.Body.String())
	}

	rec = postJSON(t, s.Handler(), "/api/tasks", master, map[string]any{
		"agent": "claude-code", "cwd": work, "prompt": "this one it has",
		"executing_device_id": deviceID,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("an agent the machine reported was refused: %d %s", rec.Code, rec.Body.String())
	}
}

// A rerun is the same work again: same directory, same machine. A new task that
// lost the machine would run the Hub's own copy of that path — or fail on a
// directory that only exists over there — instead of repeating what the user
// asked to repeat.
func TestReplayRerunStaysOnTheSameMachine(t *testing.T) {
	s, master, _, _ := remoteHub(t)
	h := s.Handler()

	// No live node needed: the task row is what the replay copies, and the
	// dispatch that follows is not what this test is about.
	_, deviceID := pairDevice(t, h, master)
	work := t.TempDir()
	original := createTask(t, h, master, map[string]any{
		"agent": "claude-code", "cwd": work, "prompt": "do the thing over there",
		"executing_device_id": deviceID,
	})
	if original.ExecutingDeviceID != deviceID {
		t.Fatalf("created = %+v", original)
	}

	rec := postJSON(t, h, "/api/tasks/"+original.ID+"/replay", master,
		map[string]any{"mode": "rerun", "prompt": "again"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("replay: %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Mode string     `json:"mode"`
		Task store.Task `json:"task"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Mode != "rerun" || body.Task.ID == "" || body.Task.ID == original.ID {
		t.Fatalf("replay = %+v", body)
	}
	if body.Task.ExecutingDeviceID != deviceID {
		t.Fatalf("the rerun runs on %q, not %q", body.Task.ExecutingDeviceID, deviceID)
	}
	if body.Task.Cwd != work {
		t.Fatalf("the rerun runs at %q, not %q", body.Task.Cwd, work)
	}
}

// A device can be running a turn this Hub knows nothing about: the Hub
// restarted, or the connection was replaced while the dispatch was in flight.
// Ignoring its events would leave an agent working on a machine nobody is
// collecting results from, so the Hub says the one thing that stops it.
func TestAnUnknownTurnIsToldToStop(t *testing.T) {
	s, master, _, _ := remoteHub(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()

	deviceToken, _ := pairDevice(t, s.Handler(), master)
	wsURL := "ws" + hub.URL[len("http"):] + node.Path
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + deviceToken}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	hello, err := worker.NewFrame("hello", nodeHello("/code/kin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := node.WriteFrame(ctx, ws, hello); err != nil {
		t.Fatal(err)
	}
	if ack, err := node.ReadFrame(ctx, ws); err != nil || ack.Kind != "hello_ack" {
		t.Fatalf("handshake: %q %v", ack.Kind, err)
	}

	up, err := worker.NewFrame("turn.event", worker.TurnEvent{
		TurnID: "turn-from-a-previous-hub", Seq: 1,
		Event: json.RawMessage(`{"type":"message"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	stop := writeAndExpectCancel(t, ctx, ws, up)
	if stop.TurnID != "turn-from-a-previous-hub" {
		t.Fatalf("cancel = %+v", stop)
	}
	if !strings.Contains(stop.Reason, "no longer running") {
		t.Fatalf("the machine is not told why: %q", stop.Reason)
	}

	// The same answer for the other two frames a device can send about a turn
	// this Hub has no record of. The ack it sends first is the one worth
	// answering promptly: it arrives before the agent has done anything, so a
	// cancel there is a run that never happens rather than one thrown away.
	started, err := worker.NewFrame("turn.started", worker.TurnStarted{TurnID: "turn-started-elsewhere"})
	if err != nil {
		t.Fatal(err)
	}
	if got := writeAndExpectCancel(t, ctx, ws, started); got.TurnID != "turn-started-elsewhere" {
		t.Fatalf("start ack cancel = %+v", got)
	}
	finish, err := worker.NewFrame("turn.finish", worker.TurnFinish{
		TurnID: "turn-finished-elsewhere", Status: worker.TurnOK,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := writeAndExpectCancel(t, ctx, ws, finish); got.TurnID != "turn-finished-elsewhere" {
		t.Fatalf("finish cancel = %+v", got)
	}
}

// writeAndExpectCancel sends one frame about a turn and returns the cancel the
// Hub answers it with, failing the test if the answer is anything else.
func writeAndExpectCancel(t *testing.T, ctx context.Context, ws *websocket.Conn, frame worker.Frame) worker.TurnCancel {
	t.Helper()
	if err := node.WriteFrame(ctx, ws, frame); err != nil {
		t.Fatal(err)
	}
	down, err := node.ReadFrame(ctx, ws)
	if err != nil {
		t.Fatal(err)
	}
	if down.Kind != "turn.cancel" {
		t.Fatalf("the hub answered a %s frame for an unknown turn with %q", frame.Kind, down.Kind)
	}
	cancel, err := node.Decode[worker.TurnCancel](down)
	if err != nil {
		t.Fatal(err)
	}
	return cancel
}
