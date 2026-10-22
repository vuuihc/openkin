package node

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// fakeAgent is a stand-in for a real agent process on this machine.
type fakeAgent struct {
	events []adapter.Event
	// block, when set, keeps the run open until the handle is canceled.
	block bool

	mu     sync.Mutex
	specs  []adapter.TaskSpec
	starts int
}

func (f *fakeAgent) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	f.mu.Lock()
	f.specs = append(f.specs, spec)
	f.starts++
	f.mu.Unlock()

	ch := make(chan adapter.Event, len(f.events)+1)
	if f.block {
		go func() {
			<-ctx.Done()
			close(ch)
		}()
		return &fakeHandle{ch: ch}, nil
	}
	go func() {
		defer close(ch)
		for _, event := range f.events {
			select {
			case ch <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	return &fakeHandle{ch: ch}, nil
}

func (f *fakeAgent) lastSpec(t *testing.T) adapter.TaskSpec {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.specs) == 0 {
		t.Fatal("the agent was never started")
	}
	return f.specs[len(f.specs)-1]
}

type fakeHandle struct {
	ch       chan adapter.Event
	canceled bool
}

func (h *fakeHandle) Events() <-chan adapter.Event { return h.ch }
func (h *fakeHandle) Cancel() error                { h.canceled = true; return nil }

// runners maps one agent id to one fake.
type runners struct {
	agents map[string]*fakeAgent
}

func (r runners) Runnable(_ context.Context, agentID string) (adapter.Adapter, error) {
	agent, ok := r.agents[agentID]
	if !ok {
		return nil, errors.New("agent " + agentID + " is not installed on this machine")
	}
	return agent, nil
}

// recorder collects the frames a Node sends up.
type recorder struct {
	mu     sync.Mutex
	frames []worker.Frame
}

func (r *recorder) send(_ context.Context, frame worker.Frame) error {
	r.mu.Lock()
	r.frames = append(r.frames, frame)
	r.mu.Unlock()
	return nil
}

func (r *recorder) collected(t *testing.T) []worker.Frame {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]worker.Frame, len(r.frames))
	copy(out, r.frames)
	return out
}

// awaitFinish waits until the node has reported the turn ending.
func (r *recorder) awaitFinish(t *testing.T, turnID string) worker.TurnFinish {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, frame := range r.collected(t) {
			if frame.Kind != "turn.finish" {
				continue
			}
			finish, err := Decode[worker.TurnFinish](frame)
			if err != nil {
				t.Fatal(err)
			}
			if finish.TurnID == turnID {
				return finish
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("turn %s never finished; frames: %+v", turnID, r.collected(t))
	return worker.TurnFinish{}
}

func dispatchFrame(t *testing.T, dispatch worker.Dispatch) worker.Frame {
	t.Helper()
	frame, err := worker.NewFrame("turn.dispatch", dispatch)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func testDispatch(cwd string) worker.Dispatch {
	return worker.Dispatch{
		TurnID: "turn-1",
		TaskID: "task-1",
		Agent:  "claude-code",
		Cwd:    cwd,
		Prompt: "fix the failing test",
	}
}

func TestExecutorRunsTheTurnAndReportsEveryEvent(t *testing.T) {
	agent := &fakeAgent{events: []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s-1"}`)},
		{Type: "message", Payload: json.RawMessage(`{"text":"working"}`)},
		{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)},
	}}
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}}, Roots: []string{work}}
	rec := &recorder{}
	exec.SetSender(rec.send)

	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	finish := rec.awaitFinish(t, "turn-1")
	if finish.Status != worker.TurnOK {
		t.Fatalf("finish = %+v", finish)
	}

	// The sequence starts at one and has no holes: the Hub ends a turn that
	// skips a number, so anything else would fail every real turn.
	var kinds []string
	for _, frame := range rec.collected(t) {
		if frame.Kind != "turn.event" {
			continue
		}
		event, err := Decode[worker.TurnEvent](frame)
		if err != nil {
			t.Fatal(err)
		}
		if want := len(kinds) + 1; event.Seq != want {
			t.Fatalf("event seq = %d, want %d", event.Seq, want)
		}
		decoded, err := decodeEvent(event.Event)
		if err != nil {
			t.Fatal(err)
		}
		kinds = append(kinds, decoded.Type)
	}
	if strings.Join(kinds, ",") != "task_started,message,result" {
		t.Fatalf("events = %v", kinds)
	}

	// What the agent was asked to do, and what it was not: no provider config
	// crosses the wire, because the machine runs with its own (ADR 0022 D7).
	spec := agent.lastSpec(t)
	if spec.Prompt != "fix the failing test" || spec.Cwd != work || spec.Agent != "claude-code" {
		t.Fatalf("spec = %+v", spec)
	}
	if spec.ProviderCfg != nil {
		t.Fatalf("a provider config reached the agent: %+v", spec.ProviderCfg)
	}
	if spec.Execution.ID != "turn-1" {
		t.Fatalf("execution id = %q, want the turn id", spec.Execution.ID)
	}
}

func TestExecutorRefusesWorkOutsideItsRoots(t *testing.T) {
	agent := &fakeAgent{}
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}}, Roots: []string{work}}
	rec := &recorder{}
	exec.SetSender(rec.send)

	outside := filepath.Join(t.TempDir(), "somewhere-else")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(outside))); err != nil {
		t.Fatal(err)
	}
	finish := rec.awaitFinish(t, "turn-1")
	if finish.Status != worker.TurnError || !strings.Contains(finish.Error, "not a directory this machine works in") {
		t.Fatalf("finish = %+v", finish)
	}
	// The agent was never started: the refusal happens before anything runs.
	agent.mu.Lock()
	defer agent.mu.Unlock()
	if agent.starts != 0 {
		t.Fatalf("the agent ran %d times outside the declared roots", agent.starts)
	}
}

func TestAllowedCwd(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "checkout")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	exec := &Executor{Roots: []string{root}}

	for _, tc := range []struct {
		name string
		cwd  string
		want bool
	}{
		{name: "the root itself", cwd: root, want: true},
		{name: "a checkout inside it", cwd: inside, want: true},
		{name: "a path that only shares a prefix", cwd: root + "-elsewhere", want: false},
		{name: "the parent", cwd: filepath.Dir(root), want: false},
		{name: "an unrelated path", cwd: os.TempDir(), want: false},
		{name: "empty with one root", cwd: "", want: true},
		{name: "relative escapes", cwd: filepath.Join(root, "..", ".."), want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := exec.allowedCwd(tc.cwd); got != tc.want {
				t.Fatalf("allowedCwd(%q) = %v, want %v", tc.cwd, got, tc.want)
			}
		})
	}

	// A machine that has declared nothing runs nothing. Treating an empty
	// declaration as permission would make the boundary decorative.
	if (&Executor{}).allowedCwd(os.TempDir()) {
		t.Fatal("a machine with no roots accepted a path")
	}
	// With several roots, an empty cwd is ambiguous, so it is refused.
	if (&Executor{Roots: []string{"/a", "/b"}}).allowedCwd("") {
		t.Fatal("an empty cwd was accepted with more than one root")
	}
}

func TestExecutorReportsAnAgentItCannotRun(t *testing.T) {
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{}}, Roots: []string{work}}
	rec := &recorder{}
	exec.SetSender(rec.send)

	dispatch := testDispatch(work)
	dispatch.Agent = "codex"
	if err := exec.Handle(context.Background(), dispatchFrame(t, dispatch)); err != nil {
		t.Fatal(err)
	}
	finish := rec.awaitFinish(t, "turn-1")
	if finish.Status != worker.TurnError || !strings.Contains(finish.Error, "not installed") {
		t.Fatalf("finish = %+v", finish)
	}
}

func TestExecutorCancelStopsTheTurn(t *testing.T) {
	agent := &fakeAgent{block: true}
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}}, Roots: []string{work}}
	rec := &recorder{}
	exec.SetSender(rec.send)

	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	// Wait for the turn to actually be running before canceling it, or the
	// cancel races the start and lands on nothing.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && len(exec.Running()) == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if len(exec.Running()) != 1 {
		t.Fatal("the turn never started")
	}

	cancel, err := worker.NewFrame("turn.cancel", worker.TurnCancel{TurnID: "turn-1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := exec.Handle(context.Background(), cancel); err != nil {
		t.Fatal(err)
	}
	finish := rec.awaitFinish(t, "turn-1")
	if finish.Status != worker.TurnCanceled {
		t.Fatalf("finish = %+v", finish)
	}
	// The turn is no longer running here, so the machine has its slot back.
	for _, id := range exec.Running() {
		if id == "turn-1" {
			t.Fatal("the canceled turn is still registered")
		}
	}
}

func TestExecutorRefusesADuplicateTurn(t *testing.T) {
	agent := &fakeAgent{block: true}
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}}, Roots: []string{work}}
	rec := &recorder{}
	exec.SetSender(rec.send)

	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && len(exec.Running()) == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	// Two runs sharing one turn id would interleave into one transcript.
	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	finish := rec.awaitFinish(t, "turn-1")
	// Whichever run reported first, the machine started the agent exactly once.
	agent.mu.Lock()
	starts := agent.starts
	agent.mu.Unlock()
	if starts != 1 {
		t.Fatalf("the agent started %d times for one turn id", starts)
	}
	if finish.Status != worker.TurnError && finish.Status != worker.TurnCanceled {
		t.Fatalf("finish = %+v", finish)
	}
}

func TestExecutorWithoutAConnectionSaysSo(t *testing.T) {
	agent := &fakeAgent{}
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}}, Roots: []string{work}}
	// No sender installed: the node is not connected, so nothing can be
	// reported anywhere. It must not panic or hang.
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work)))
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a dispatch with no connection blocked")
	}
}
