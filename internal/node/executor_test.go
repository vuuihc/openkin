package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	// finished, when set, is closed after every event has been handed over.
	// It is how a test knows the run is done producing, not just started.
	finished chan struct{}

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
		if f.finished != nil {
			close(f.finished)
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

	// Every connection opens with the turns this machine still holds — here,
	// none — so the Hub can settle what it kept for the device instead of
	// waiting out the reconnect grace.
	frames := rec.collected(t)
	if len(frames) < 2 || frames[0].Kind != "turn.resume" {
		t.Fatalf("the connection did not open with a resume: %+v", frames)
	}
	resume, err := Decode[worker.TurnResume](frames[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(resume.TurnIDs) != 0 {
		t.Fatalf("resume = %+v, want no turns on a fresh connection", resume)
	}

	// Taking the work is the first thing the machine says, because it is the
	// only thing that tells the Hub the dispatch arrived: a node that ran the
	// turn and stayed quiet looks exactly like a node that never got it, and
	// the Hub ends a turn nobody started.
	if frames[1].Kind != "turn.started" {
		t.Fatalf("the frame after the resume is not the start ack: %+v", frames)
	}
	started, err := Decode[worker.TurnStarted](frames[1])
	if err != nil {
		t.Fatal(err)
	}
	if started.TurnID != "turn-1" {
		t.Fatalf("start ack = %+v", started)
	}

	// The sequence starts at one and has no holes: the Hub ends a turn that
	// skips a number, so anything else would fail every real turn.
	var kinds []string
	for _, frame := range frames {
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
	// A link inside the root pointing out of it, and a link inside the root
	// pointing at another link that leaves: containment has to be decided on
	// where a path really lands.
	elsewhere := t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(elsewhere, link); err != nil {
		t.Skipf("symlinks are not available here: %v", err)
	}
	outsideLink := filepath.Join(elsewhere, "back")
	if err := os.Symlink(link, outsideLink); err != nil {
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
		{name: "a bare relative path", cwd: "checkout", want: false},
		{name: "a path that is not there", cwd: filepath.Join(root, "gone"), want: false},
		{name: "a symlink out of the root", cwd: link, want: false},
		{name: "a symlink to a symlink out of the root", cwd: outsideLink, want: false},
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
	// A root reached through a link still contains its own real path.
	if viaLink := (&Executor{Roots: []string{link}}); !viaLink.allowedCwd(elsewhere) {
		t.Fatal("a root declared through a symlink rejected its own real path")
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

// gatedRunners is a machine whose agent lookup takes as long as the test says:
// the window between taking a dispatch off the read loop and having an agent to
// run it in.
type gatedRunners struct {
	gate  chan struct{}
	agent *fakeAgent
}

func (r gatedRunners) Runnable(ctx context.Context, _ string) (adapter.Adapter, error) {
	select {
	case <-r.gate:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return r.agent, nil
}

// TestACancelThatArrivesWithTheDispatchStopsTheAgent is the convergence rule at
// its narrowest: the Hub sends a cancel right behind a dispatch when a task is
// stopped as it starts, both frames land in one read, and the turn is already
// registered when the second one is handled. A turn that registered itself
// inside its own goroutine would lose the cancel in the microseconds before that
// goroutine runs, and a silent agent would work on for a Hub that has stopped
// listening.
func TestACancelThatArrivesWithTheDispatchStopsTheAgent(t *testing.T) {
	work := t.TempDir()
	agent := &fakeAgent{block: true}
	gate := make(chan struct{})
	exec := &Executor{
		Runners: gatedRunners{gate: gate, agent: agent},
		Roots:   []string{work},
	}
	// A working connection, so the only thing that can warn below is the cancel
	// itself: started-frame failures have their own tests.
	exec.SetSender((&recorder{}).send)
	var mu sync.Mutex
	var warned []string
	exec.Warn = func(format string, args ...any) {
		mu.Lock()
		warned = append(warned, fmt.Sprintf(format, args...))
		mu.Unlock()
	}

	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	cancelFrame, err := worker.NewFrame("turn.cancel", worker.TurnCancel{
		TurnID: "turn-1", Reason: "stopped as it started",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := exec.Handle(context.Background(), cancelFrame); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	dropped := append([]string(nil), warned...)
	mu.Unlock()
	if len(dropped) != 0 {
		t.Fatalf("the cancel was dropped as one for a turn this machine never had: %v", dropped)
	}
	// The agent comes up now, the way it would a moment after the read loop
	// moved on to the next frame.
	close(gate)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if running := exec.Running(); len(running) == 0 {
			// The turn ended by itself: its context was already cancelled when the
			// agent started, which is the only thing that stops an agent that has
			// printed nothing yet.
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("a turn cancelled as it started is still running: %v", exec.Running())
}

// TestExecutorIgnoresADuplicateDispatch pins what a second dispatch for a turn
// that is already running does: nothing. Answering with a finish of its own
// would end the live turn — the Hub settles a turn by id — and the run that is
// still working would report into a turn nobody is listening to.
func TestExecutorIgnoresADuplicateTurn(t *testing.T) {
	agent := &fakeAgent{block: true}
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}}, Roots: []string{work}}
	rec := &recorder{}
	exec.SetSender(rec.send)

	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	// The agent being up is the signal, not the registry: a dispatch is
	// registered on the read loop now, before its own goroutine has run.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		agent.mu.Lock()
		started := agent.starts
		agent.mu.Unlock()
		if started == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	// Two runs sharing one turn id would interleave into one transcript, so the
	// machine started the agent exactly once.
	agent.mu.Lock()
	starts := agent.starts
	agent.mu.Unlock()
	if starts != 1 {
		t.Fatalf("the agent started %d times for one turn id", starts)
	}
	// And the first run is still going: the duplicate did not end it.
	if running := exec.Running(); len(running) != 1 || running[0] != "turn-1" {
		t.Fatalf("running = %v, want the original turn untouched", running)
	}

	// The turn it is actually running still reports its own ending.
	cancel, err := worker.NewFrame("turn.cancel", worker.TurnCancel{TurnID: "turn-1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := exec.Handle(context.Background(), cancel); err != nil {
		t.Fatal(err)
	}
	if finish := rec.awaitFinish(t, "turn-1"); finish.Status != worker.TurnCanceled {
		t.Fatalf("finish = %+v", finish)
	}
}

func TestExecutorRefusesYOLOUnlessTheOperatorAllowedIt(t *testing.T) {
	agent := &fakeAgent{events: []adapter.Event{{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)}}}
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}}, Roots: []string{work}}
	rec := &recorder{}
	exec.SetSender(rec.send)

	dispatch := testDispatch(work)
	dispatch.PermissionMode = "yolo"
	if err := exec.Handle(context.Background(), dispatchFrame(t, dispatch)); err != nil {
		t.Fatal(err)
	}
	finish := rec.awaitFinish(t, "turn-1")
	if finish.Status != worker.TurnError || !strings.Contains(finish.Error, "--allow-yolo") {
		t.Fatalf("finish = %+v", finish)
	}
	// Nothing ran: a Hub that can ask for unchecked execution can ask for
	// anything, and this machine is the one that has to say no.
	agent.mu.Lock()
	starts := agent.starts
	agent.mu.Unlock()
	if starts != 0 {
		t.Fatalf("the agent ran %d times with permissions bypassed", starts)
	}

	// With the operator's consent it is a request this machine accepts.
	allowed := &Executor{
		Runners:   runners{agents: map[string]*fakeAgent{"claude-code": agent}},
		Roots:     []string{work},
		AllowYOLO: true,
	}
	rec2 := &recorder{}
	allowed.SetSender(rec2.send)
	if err := allowed.Handle(context.Background(), dispatchFrame(t, dispatch)); err != nil {
		t.Fatal(err)
	}
	if finish := rec2.awaitFinish(t, "turn-1"); finish.Status != worker.TurnOK {
		t.Fatalf("finish = %+v", finish)
	}
	if spec := agent.lastSpec(t); spec.PermissionMode != adapter.PermissionYOLO {
		t.Fatalf("permission mode = %q", spec.PermissionMode)
	}
}

// noApprovalAgent stands for an agent with no approval channel of its own: the
// mode the Hub is required to use for it is the same bypass yolo is.
type noApprovalAgent struct{ *fakeAgent }

func (noApprovalAgent) AutoApprovesAll(mode string) bool {
	switch adapter.NormalizePermissionMode(mode) {
	case adapter.PermissionAcceptEdits, adapter.PermissionYOLO:
		return true
	default:
		return false
	}
}

// mixedRunners maps agent ids to whatever adapter stands for them, so a test can
// hand the executor an agent whose mode mapping is not the default one.
type mixedRunners map[string]adapter.Adapter

func (r mixedRunners) Runnable(_ context.Context, agentID string) (adapter.Adapter, error) {
	found, ok := r[agentID]
	if !ok {
		return nil, errors.New("agent " + agentID + " is not installed on this machine")
	}
	return found, nil
}

// TestExecutorJudgesTheCeilingOnWhatTheAgentWillDo: the operator's --allow-yolo
// is consent to unattended execution, so it has to cover every way of getting
// there, not just the mode whose name says so. For an agent that has no approval
// prompt to keep, accept_edits is that same bypass under a milder name.
func TestExecutorJudgesTheCeilingOnWhatTheAgentWillDo(t *testing.T) {
	agent := &fakeAgent{events: []adapter.Event{{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)}}}
	work := t.TempDir()
	exec := &Executor{Runners: mixedRunners{"opencode": noApprovalAgent{agent}}, Roots: []string{work}}
	rec := &recorder{}
	exec.SetSender(rec.send)

	dispatch := testDispatch(work)
	dispatch.Agent = "opencode"
	dispatch.PermissionMode = adapter.PermissionAcceptEdits
	if err := exec.Handle(context.Background(), dispatchFrame(t, dispatch)); err != nil {
		t.Fatal(err)
	}
	finish := rec.awaitFinish(t, "turn-1")
	if finish.Status != worker.TurnError || !strings.Contains(finish.Error, "--allow-yolo") {
		t.Fatalf("finish = %+v", finish)
	}
	agent.mu.Lock()
	starts := agent.starts
	agent.mu.Unlock()
	if starts != 0 {
		t.Fatalf("the agent ran %d times with approvals bypassed", starts)
	}

	// The same dispatch on an agent that does keep a prompt is a request this
	// machine accepts: the ceiling is about what runs, not about the word.
	prompting := &fakeAgent{events: []adapter.Event{{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)}}}
	open := &Executor{Runners: mixedRunners{"opencode": prompting}, Roots: []string{work}}
	rec2 := &recorder{}
	open.SetSender(rec2.send)
	if err := open.Handle(context.Background(), dispatchFrame(t, dispatch)); err != nil {
		t.Fatal(err)
	}
	if finish := rec2.awaitFinish(t, "turn-1"); finish.Status != worker.TurnOK {
		t.Fatalf("a graded accept_edits was refused: %+v", finish)
	}

	// And with the operator's consent the bypass runs, with the mode it asked for.
	allowed := &Executor{
		Runners:   mixedRunners{"opencode": noApprovalAgent{agent}},
		Roots:     []string{work},
		AllowYOLO: true,
	}
	rec3 := &recorder{}
	allowed.SetSender(rec3.send)
	if err := allowed.Handle(context.Background(), dispatchFrame(t, dispatch)); err != nil {
		t.Fatal(err)
	}
	if finish := rec3.awaitFinish(t, "turn-1"); finish.Status != worker.TurnOK {
		t.Fatalf("finish = %+v", finish)
	}
	if spec := agent.lastSpec(t); spec.PermissionMode != adapter.PermissionAcceptEdits {
		t.Fatalf("permission mode = %q", spec.PermissionMode)
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

// TestExecutorBringsAttachmentsBeforeTheAgentStarts is the acceptance case in
// miniature: a prompt that names a file the Hub holds, a machine that does not
// hold it, and an agent that must be handed a path it can open.
func TestExecutorBringsAttachmentsBeforeTheAgentStarts(t *testing.T) {
	up := newUploadServer(t, "device-token")
	up.put("ab12.png", []byte("png-bytes"))
	work := t.TempDir()
	agent := &fakeAgent{}
	exec := &Executor{
		Runners:     runners{agents: map[string]*fakeAgent{"claude-code": agent}},
		Roots:       []string{work},
		Attachments: newFetcher(t, up),
	}
	rec := &recorder{}
	exec.SetSender(rec.send)

	dispatch := testDispatch(work)
	dispatch.Prompt = "what is this?\n\nAttached image:\n- shot.png: /hub/uploads/ab12.png"
	dispatch.Attachments = []worker.Attachment{{Path: "/hub/uploads/ab12.png", Stored: "ab12.png"}}
	if err := exec.Handle(context.Background(), dispatchFrame(t, dispatch)); err != nil {
		t.Fatal(err)
	}
	if finish := rec.awaitFinish(t, "turn-1"); finish.Status != worker.TurnOK {
		t.Fatalf("finish = %+v", finish)
	}

	spec := agent.lastSpec(t)
	local := filepath.Join(exec.Attachments.dir, "task-1", "ab12.png")
	if !strings.Contains(spec.Prompt, local) {
		t.Fatalf("the agent was handed %q, which does not name %q", spec.Prompt, local)
	}
	if strings.Contains(spec.Prompt, "/hub/uploads/ab12.png") {
		t.Fatalf("the agent was handed the hub's path: %q", spec.Prompt)
	}
}

// TestExecutorWithoutAFetcherStillRunsTheTurn keeps the degradation honest: a
// node built without a fetcher is a node that cannot bring the file, not one
// that refuses the work.
func TestExecutorWithoutAFetcherStillRunsTheTurn(t *testing.T) {
	work := t.TempDir()
	agent := &fakeAgent{}
	exec := &Executor{
		Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}},
		Roots:   []string{work},
	}
	rec := &recorder{}
	exec.SetSender(rec.send)

	dispatch := testDispatch(work)
	dispatch.Prompt = "see\n\nAttached image:\n- shot.png: /hub/uploads/ab12.png"
	dispatch.Attachments = []worker.Attachment{{Path: "/hub/uploads/ab12.png", Stored: "ab12.png"}}
	if err := exec.Handle(context.Background(), dispatchFrame(t, dispatch)); err != nil {
		t.Fatal(err)
	}
	if finish := rec.awaitFinish(t, "turn-1"); finish.Status != worker.TurnOK {
		t.Fatalf("finish = %+v", finish)
	}
	if got := agent.lastSpec(t).Prompt; got != dispatch.Prompt {
		t.Fatalf("prompt = %q, want it unchanged", got)
	}
}

// TestExecutorResumesARunningTurnWhenTheConnectionReturns is the whole point of
// the resume frame: the hub dropped, the agent never stopped, and the machine
// comes back saying which work it still has.
func TestExecutorResumesARunningTurnWhenTheConnectionReturns(t *testing.T) {
	agent := &fakeAgent{block: true}
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}}, Roots: []string{work}}

	// The dispatch arrives while there is no connection at all. The machine
	// takes the work anyway: the hub may be back before the agent is done.
	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	// The agent being up is the signal that the start ack has been written —
	// the ack goes out before the runner is asked for an agent.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		agent.mu.Lock()
		started := agent.starts
		agent.mu.Unlock()
		if started == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(exec.Running()) != 1 {
		t.Fatal("the turn never started")
	}

	rec := &recorder{}
	exec.SetSender(rec.send)
	frames := rec.collected(t)
	if len(frames) < 2 || frames[0].Kind != "turn.resume" || frames[1].Kind != "turn.started" {
		t.Fatalf("frames = %+v", frames)
	}
	resume, err := Decode[worker.TurnResume](frames[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(resume.TurnIDs) != 1 || resume.TurnIDs[0] != "turn-1" {
		t.Fatalf("resume = %+v, want the running turn", resume)
	}
	resumed, err := Decode[worker.TurnStarted](frames[1])
	if err != nil {
		t.Fatal(err)
	}
	if resumed.TurnID != "turn-1" {
		t.Fatalf("start ack after the resume = %+v", resumed)
	}

	// The turn still answers a stop on the new connection, which is how the
	// hub learns it ended.
	cancel, err := worker.NewFrame("turn.cancel", worker.TurnCancel{TurnID: "turn-1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := exec.Handle(context.Background(), cancel); err != nil {
		t.Fatal(err)
	}
	if finish := rec.awaitFinish(t, "turn-1"); finish.Status != worker.TurnCanceled {
		t.Fatalf("finish = %+v", finish)
	}
}

// TestExecutorHoldsAFinishedTurnUntilTheConnectionReturns: an agent that runs to
// completion while the hub is away still gets its transcript delivered. The
// events and the ending wait for the connection instead of being dropped —
// which is exactly how the run that started all this was lost.
func TestExecutorHoldsAFinishedTurnUntilTheConnectionReturns(t *testing.T) {
	agent := &fakeAgent{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s-1"}`)},
			{Type: "message", Payload: json.RawMessage(`{"text":"working"}`)},
			{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)},
		},
		finished: make(chan struct{}),
	}
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}}, Roots: []string{work}}

	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	select {
	case <-agent.finished:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent never produced its events")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && len(exec.Running()) != 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if running := exec.Running(); len(running) != 0 {
		t.Fatalf("the turn is still running: %v", running)
	}

	rec := &recorder{}
	exec.SetSender(rec.send)
	frames := rec.collected(t)
	if len(frames) < 2 || frames[0].Kind != "turn.resume" {
		t.Fatalf("frames = %+v", frames)
	}
	resume, err := Decode[worker.TurnResume](frames[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(resume.TurnIDs) != 1 || resume.TurnIDs[0] != "turn-1" {
		t.Fatalf("resume = %+v, want the turn whose ending was never delivered", resume)
	}
	var kinds []string
	var seqs []int
	for _, frame := range frames[1:] {
		switch frame.Kind {
		case "turn.started":
			kinds = append(kinds, frame.Kind)
		case "turn.event":
			event, err := Decode[worker.TurnEvent](frame)
			if err != nil {
				t.Fatal(err)
			}
			kinds = append(kinds, frame.Kind)
			seqs = append(seqs, event.Seq)
		case "turn.finish":
			kinds = append(kinds, frame.Kind)
		}
	}
	if strings.Join(kinds, ",") != "turn.started,turn.event,turn.event,turn.event,turn.finish" {
		t.Fatalf("frames after the resume = %v", kinds)
	}
	if len(seqs) != 3 || seqs[0] != 1 || seqs[1] != 2 || seqs[2] != 3 {
		t.Fatalf("event sequences = %v, want 1..3 with no holes", seqs)
	}
	if finish, err := Decode[worker.TurnFinish](frames[len(frames)-1]); err != nil || finish.Status != worker.TurnOK {
		t.Fatalf("finish = %+v (%v)", finish, err)
	}
}

// TestExecutorReplaysTheTailOfATurnAfterAReconnect covers the frame that was
// written but lost with the socket. The hub drops a duplicate event by its
// sequence and accepts a repeated start ack for a live turn, so writing the
// tail again is how the machine makes sure the transcript has no hole.
func TestExecutorReplaysTheTailOfATurnAfterAReconnect(t *testing.T) {
	agent := &fakeAgent{events: []adapter.Event{
		{Type: "message", Payload: json.RawMessage(`{"text":"one"}`)},
		{Type: "message", Payload: json.RawMessage(`{"text":"two"}`)},
	}}
	work := t.TempDir()
	exec := &Executor{Runners: runners{agents: map[string]*fakeAgent{"claude-code": agent}}, Roots: []string{work}}
	first := &recorder{}
	exec.SetSender(first.send)

	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	if finish := first.awaitFinish(t, "turn-1"); finish.Status != worker.TurnOK {
		t.Fatalf("finish = %+v", finish)
	}

	// The socket is replaced. Nothing was waiting in the outbox, but the last
	// frames written may have died with the old connection.
	exec.SetSender(nil)
	second := &recorder{}
	exec.SetSender(second.send)

	frames := second.collected(t)
	if len(frames) < 2 || frames[0].Kind != "turn.resume" {
		t.Fatalf("frames = %+v", frames)
	}
	resume, err := Decode[worker.TurnResume](frames[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(resume.TurnIDs) != 1 || resume.TurnIDs[0] != "turn-1" {
		t.Fatalf("resume = %+v, want the turn whose tail is replayed", resume)
	}
	var replayed []string
	for _, frame := range frames[1:] {
		switch frame.Kind {
		case "turn.started", "turn.event", "turn.finish":
			replayed = append(replayed, frame.Kind)
		default:
			t.Fatalf("replayed a frame the hub does not deduplicate: %s", frame.Kind)
		}
	}
	if len(replayed) < 2 || replayed[0] != "turn.started" || replayed[len(replayed)-1] != "turn.finish" {
		t.Fatalf("replayed = %v, want the tail from the start ack to the finish", replayed)
	}
	if finish, err := Decode[worker.TurnFinish](frames[len(frames)-1]); err != nil || finish.TurnID != "turn-1" {
		t.Fatalf("finish = %+v (%v)", finish, err)
	}
}

// TestExecutorStopsATurnItsOutboxCannotHold: an agent can produce faster than a
// dead hub can drain, and the holding area is bounded. The turn is stopped and
// reported with the real reason instead of growing the process until it dies.
func TestExecutorStopsATurnItsOutboxCannotHold(t *testing.T) {
	agent := &fakeAgent{
		events: []adapter.Event{
			{Type: "message", Payload: json.RawMessage(`{"text":"one"}`)},
			{Type: "message", Payload: json.RawMessage(`{"text":"two"}`)},
			{Type: "message", Payload: json.RawMessage(`{"text":"three"}`)},
		},
		finished: make(chan struct{}),
	}
	work := t.TempDir()
	exec := &Executor{
		Runners:     runners{agents: map[string]*fakeAgent{"claude-code": agent}},
		Roots:       []string{work},
		OutboxLimit: 1,
	}

	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	select {
	case <-agent.finished:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent never produced its events")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && len(exec.Running()) != 0 {
		time.Sleep(5 * time.Millisecond)
	}

	rec := &recorder{}
	exec.SetSender(rec.send)
	frames := rec.collected(t)
	if len(frames) != 2 || frames[0].Kind != "turn.resume" || frames[1].Kind != "turn.finish" {
		t.Fatalf("frames = %+v, want a resume and one ending", frames)
	}
	resume, err := Decode[worker.TurnResume](frames[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(resume.TurnIDs) != 1 || resume.TurnIDs[0] != "turn-1" {
		t.Fatalf("resume = %+v", resume)
	}
	finish, err := Decode[worker.TurnFinish](frames[1])
	if err != nil {
		t.Fatal(err)
	}
	if finish.Status != worker.TurnError || !strings.Contains(finish.Error, "fell behind") {
		t.Fatalf("finish = %+v, want the overflow reason", finish)
	}
}

// TestExecutorBoundsTheResumeToTheProtocolLimit: a Hub refuses a resume that
// names more turns than the protocol allows, and a refused resume adopts
// nothing. The Node therefore trims its own list instead of sending one the
// peer will throw away.
func TestExecutorBoundsTheResumeToTheProtocolLimit(t *testing.T) {
	exec := &Executor{running: make(map[string]*execution)}
	for i := 0; i < worker.MaxResumeTurns+5; i++ {
		id := fmt.Sprintf("turn-%03d", i)
		exec.running[id] = &execution{turnID: id}
	}
	rec := &recorder{}
	exec.SetSender(rec.send)

	frames := rec.collected(t)
	if len(frames) == 0 || frames[0].Kind != "turn.resume" {
		t.Fatalf("frames = %+v", frames)
	}
	resume, err := Decode[worker.TurnResume](frames[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := resume.Validate(); err != nil {
		t.Fatalf("the node sent a resume its hub would refuse: %v", err)
	}
	if len(resume.TurnIDs) != worker.MaxResumeTurns {
		t.Fatalf("resume names %d turns, want the bound %d", len(resume.TurnIDs), worker.MaxResumeTurns)
	}
	if resume.TurnIDs[0] != "turn-000" {
		t.Fatalf("resume starts at %q, want the first held turn", resume.TurnIDs[0])
	}
}

// TestExecutorReplaysABurstOfFrames: a reset socket loses everything written
// since the last data the peer acknowledged, which for a chatty agent is far
// more than a handful of frames. The replay bound is bytes, not a small frame
// count, or a routine flap still reaches the hub as a sequence hole.
func TestExecutorReplaysABurstOfFrames(t *testing.T) {
	exec := &Executor{}
	const frames = 40
	for i := 1; i <= frames; i++ {
		frame, err := worker.NewFrame("turn.event", worker.TurnEvent{
			TurnID: "turn-1", Seq: i, Event: json.RawMessage(`{"type":"delta","text":"x"}`),
		})
		if err != nil {
			t.Fatal(err)
		}
		exec.rememberLocked("turn-1", frame)
	}
	rec := &recorder{}
	exec.SetSender(rec.send)

	replayed := rec.collected(t)
	if len(replayed) == 0 || replayed[0].Kind != "turn.resume" {
		t.Fatalf("frames = %+v", replayed)
	}
	var seqs []int
	for _, frame := range replayed[1:] {
		if frame.Kind != "turn.event" {
			continue
		}
		event, err := Decode[worker.TurnEvent](frame)
		if err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, event.Seq)
	}
	if len(seqs) != frames || seqs[0] != 1 || seqs[len(seqs)-1] != frames {
		first, last := 0, 0
		if len(seqs) > 0 {
			first, last = seqs[0], seqs[len(seqs)-1]
		}
		t.Fatalf("replayed %d frames (first %d, last %d), want all %d", len(seqs), first, last, frames)
	}
}

// TestExecutorForgetsAnAbortedTurnItIsToldToCancel: the overflow marker outlives
// its turn if the ending never got out and the Hub then cancels the id. Nothing
// is held for the turn any more, and the marker must go with it rather than
// being kept for the life of the process.
func TestExecutorForgetsAnAbortedTurnItIsToldToCancel(t *testing.T) {
	agent := &fakeAgent{
		events: []adapter.Event{
			{Type: "message", Payload: json.RawMessage(`{"text":"one"}`)},
			{Type: "message", Payload: json.RawMessage(`{"text":"two"}`)},
		},
		finished: make(chan struct{}),
	}
	work := t.TempDir()
	exec := &Executor{
		Runners:     runners{agents: map[string]*fakeAgent{"claude-code": agent}},
		Roots:       []string{work},
		OutboxLimit: 1,
	}
	if err := exec.Handle(context.Background(), dispatchFrame(t, testDispatch(work))); err != nil {
		t.Fatal(err)
	}
	select {
	case <-agent.finished:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent never produced its events")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && len(exec.Running()) != 0 {
		time.Sleep(5 * time.Millisecond)
	}

	exec.sendMu.Lock()
	marked := exec.aborted["turn-1"]
	exec.sendMu.Unlock()
	if !marked {
		t.Fatal("the overflow did not mark the turn it stopped")
	}

	cancel, err := worker.NewFrame("turn.cancel", worker.TurnCancel{TurnID: "turn-1", Reason: "the hub is no longer running this turn"})
	if err != nil {
		t.Fatal(err)
	}
	if err := exec.Handle(context.Background(), cancel); err != nil {
		t.Fatal(err)
	}
	exec.sendMu.Lock()
	_, still := exec.aborted["turn-1"]
	exec.sendMu.Unlock()
	if still {
		t.Fatal("the abort marker outlived everything held for the turn")
	}
}
