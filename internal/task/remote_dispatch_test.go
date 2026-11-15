package task

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/skills"
	"github.com/vuuihc/openkin/internal/store"
)

// remoteAgent stands in for a turn running on another machine: the engine sees
// an ordinary adapter, and nothing about it says "remote".
type remoteAgent struct {
	events []adapter.Event
	gate   chan struct{}
}

func (a *remoteAgent) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	if a.gate != nil {
		select {
		case <-a.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ch := make(chan adapter.Event, 16)
	h := &fakeHandle{ch: ch, cancelCh: make(chan struct{})}
	go func() {
		defer close(ch)
		for _, ev := range a.events {
			select {
			case <-h.cancelCh:
				return
			case ch <- ev:
			}
		}
	}()
	return h, nil
}

func TestEngineDispatchesToTheTasksDevice(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)

	remote := &remoteAgent{events: successEvents()}
	var (
		mu    sync.Mutex
		calls []string
	)
	e.SetRemoteRunner("this-machine", func(task store.Task, executionID string) (adapter.Adapter, error) {
		mu.Lock()
		calls = append(calls, task.ExecutingDeviceID)
		mu.Unlock()
		if executionID == "" {
			t.Error("the remote runner was not told which execution this is")
		}
		return remote, nil
	})

	created, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/code/kin", Prompt: "run this over there",
		ExecutingDeviceID: "studio",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 5*time.Second)

	mu.Lock()
	got := append([]string(nil), calls...)
	mu.Unlock()
	if len(got) != 1 || got[0] != "studio" {
		t.Fatalf("remote runner calls = %v", got)
	}
	// The turn took the ordinary path downstream: the events are rows in the
	// Hub's own store, with the Hub's own sequence numbers.
	local.mu.Lock()
	localStarts := local.started
	local.mu.Unlock()
	if localStarts != 0 {
		t.Fatalf("the local adapter ran a turn that belongs to another machine (%d times)", localStarts)
	}
	events, err := st.ListEvents(context.Background(), created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) < 3 {
		t.Fatalf("events = %+v", events)
	}
	for i, event := range events {
		if event.Seq != i+1 {
			t.Fatalf("event %d has seq %d", i, event.Seq)
		}
	}

	// And the row says where it ran, which is what the console will show.
	stored, err := st.GetTask(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ExecutingDeviceID != "studio" {
		t.Fatalf("executing_device_id = %q", stored.ExecutingDeviceID)
	}
}

func TestEngineRunsLocallyWhenTheDeviceIsItsOwn(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, local)

	called := false
	e.SetRemoteRunner("studio", func(store.Task, string) (adapter.Adapter, error) {
		called = true
		return nil, errors.New("should not be asked")
	})

	created, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "run here",
		ExecutingDeviceID: "studio",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 5*time.Second)
	if called {
		t.Fatal("a task for this machine was dispatched away")
	}
	local.mu.Lock()
	defer local.mu.Unlock()
	if local.started != 1 {
		t.Fatalf("the local adapter ran %d times", local.started)
	}
}

func TestEngineFailsATaskItCannotDispatch(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)

	// A daemon with no way to reach other machines must say so rather than
	// quietly run the turn on the wrong computer.
	e.SetRemoteRunner("this-machine", func(store.Task, string) (adapter.Adapter, error) {
		return nil, errors.New("device is not connected")
	})

	created, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "run over there",
		ExecutingDeviceID: "studio",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusFailed, 5*time.Second)

	events, err := st.ListEvents(context.Background(), created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var said string
	for _, event := range events {
		if event.Type == "error" {
			said = string(event.Payload)
		}
	}
	if !strings.Contains(said, "device is not connected") {
		t.Fatalf("the failure was not explained: %q", said)
	}
	local.mu.Lock()
	defer local.mu.Unlock()
	if local.started != 0 {
		t.Fatal("the local adapter ran a task that belongs to another machine")
	}
}

func TestEngineRefusesToDispatchWithoutARunner(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)
	// No SetRemoteRunner: this is a standalone daemon that has never heard of
	// another machine.
	created, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "run over there",
		ExecutingDeviceID: "studio",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusFailed, 5*time.Second)
	events, _ := st.ListEvents(context.Background(), created.ID, 0)
	var said string
	for _, event := range events {
		if event.Type == "error" {
			said = string(event.Payload)
		}
	}
	if !strings.Contains(said, "cannot dispatch") {
		t.Fatalf("the failure was not explained: %q", said)
	}
}

// TestRemoteTurnSkipsLocalOnlyPlanning pins what a remote turn does *not* do.
// Plan and route resolution choose an agent, and the machine that runs the turn
// is the one that has to have it.
func TestRemoteTurnSkipsLocalOnlyPlanning(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, local)

	remote := &remoteAgent{events: successEvents()}
	e.SetRemoteRunner("this-machine", func(store.Task, string) (adapter.Adapter, error) {
		return remote, nil
	})

	// Two mentioned agents would normally become an orchestrated plan with a
	// worker step on this machine.
	created, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "@codex and @claude-code both look at this",
		ExecutingDeviceID: "studio",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 5*time.Second)
	local.mu.Lock()
	defer local.mu.Unlock()
	if local.started != 0 {
		t.Fatal("a remote turn ran a local orchestration step")
	}
}

func TestCreateCarriesNoDeviceMeansThisOne(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	created, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "say hi",
	})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := st.GetTask(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ExecutingDeviceID != "" {
		t.Fatalf("executing_device_id = %q, want empty for a local task", stored.ExecutingDeviceID)
	}
}

func TestRemoteTurnRoundTripsThroughJSON(t *testing.T) {
	// The device id is part of the task's public shape, because a console has to
	// be able to show and set it.
	raw, err := json.Marshal(store.Task{ID: "t1", ExecutingDeviceID: "studio"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"executing_device_id":"studio"`) {
		t.Fatalf("task json = %s", raw)
	}
	var decoded store.Task
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.ExecutingDeviceID != "studio" {
		t.Fatalf("decoded = %+v", decoded)
	}
}

// recordingSkills counts the reads a skill resolver would do from this
// machine's filesystem.
type recordingSkills struct{ calls int }

func (r *recordingSkills) Context(context.Context, string, string) (skills.Context, error) {
	r.calls++
	return skills.Context{Instructions: "this machine's skills"}, nil
}

// A remote task's cwd names a directory on the other machine. Reading this
// machine's projects and SKILL.md files at the same address attaches the wrong
// context — the Hub's One-Pager, the Hub's skills — to work that never touches
// the Hub's checkout. The same repository is usually cloned at the same path on
// both machines, which is what makes the mistake invisible.
func TestRemoteTaskTakesNoContextFromThisMachinesDirectories(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)
	e.SetRemoteRunner("this-machine", func(store.Task, string) (adapter.Adapter, error) {
		return &remoteAgent{events: successEvents()}, nil
	})

	work := t.TempDir()
	if err := st.InsertProject(context.Background(), store.Project{
		ID: "proj-1", Name: "OpenKin", Mode: store.ProjectModeShip, OnePagerRel: "PRINCIPLE.md",
	}, []string{work}); err != nil {
		t.Fatal(err)
	}
	resolver := &recordingSkills{}
	e.SetSkillResolver(resolver)

	elsewhere, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: work, Prompt: "run over there", ExecutingDeviceID: "studio",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, elsewhere.ID, StatusSucceeded, 5*time.Second)
	if elsewhere.ProjectID != "" {
		t.Fatalf("a remote task adopted this machine's project %q", elsewhere.ProjectID)
	}
	if resolver.calls != 0 {
		t.Fatalf("skills were read from this machine for a remote task (%d times)", resolver.calls)
	}

	// The same cwd, run here, still resolves both: the guard is about which
	// machine owns the path, not about the path.
	here, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: work, Prompt: "run here",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, here.ID, StatusSucceeded, 5*time.Second)
	if here.ProjectID != "proj-1" {
		t.Fatalf("a local task lost its project: %q", here.ProjectID)
	}
	if resolver.calls == 0 {
		t.Fatal("a local task was given no skills")
	}
}
