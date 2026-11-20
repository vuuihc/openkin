package task

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// releaseOnce returns a function that closes ch exactly once, so a test can
// release a gate at the point it means to and still promise t.Cleanup a release
// when a failure returns first.
func releaseOnce(ch chan struct{}) func() {
	var once sync.Once
	return func() { once.Do(func() { close(ch) }) }
}

// These tests hold an orchestrated turn end inside workspace finalization, the
// one window where a follow-up used to be refused: the adapter run loop settles
// the messages its commit window accepts, and the orchestrated finisher owns the
// same window but had no hook behind it. Everything here runs through
// finishOrchestrated, the production turn end, so removing its settle calls
// fails these tests rather than passing them through a hand-placed seam.

// waitActiveRun waits for the run a created task claimed and returns its
// execution id, which is what CompleteWorkspace and finishOrchestrated name.
func waitActiveRun(t *testing.T, e *Engine, id string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		e.mu.Lock()
		execID := e.activeRuns[id]
		e.mu.Unlock()
		if execID != "" {
			return execID
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("no run is active: the setup is wrong, not the delivery")
	return ""
}

// startOrchestratedTurnFinalizing creates a gated task, marks its workspace
// finalizing, and starts the orchestrated turn end in the background. The caller
// holds the returned runtime's finalize gate to keep the turn inside the commit
// window.
func startOrchestratedTurnFinalizing(
	t *testing.T, e *Engine, ctx context.Context,
) (taskID, executionID string, done chan struct{}) {
	t.Helper()
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 5*time.Second)
	execID := waitActiveRun(t, e, task.ID)
	if _, err := e.CompleteWorkspace(ctx, WorkspaceIntentRequest{
		TaskID: task.ID, ExecutionID: execID,
	}); err != nil {
		t.Fatalf("complete workspace: %v", err)
	}
	done = make(chan struct{})
	go func() {
		defer close(done)
		e.finishOrchestrated(ctx, task.ID, execID, false)
	}()
	return task.ID, execID, done
}

// A message sent while an orchestrated turn finalizes its workspace waits in the
// queue like one sent while it is still working. The turn end that follows
// finalization delivers it, so there is nothing to refuse.
func TestAnOrchestratedFollowUpDuringFinalizationIsQueued(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{gate: make(chan struct{}), events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{
		finalizeStarted: make(chan struct{}),
		finalizeRelease: make(chan struct{}),
	}
	e.SetWorkspaceRuntime(rt)
	releaseGate := releaseOnce(ad.gate)
	t.Cleanup(releaseGate)

	id, execID, done := startOrchestratedTurnFinalizing(t, e, ctx)
	select {
	case <-rt.finalizeStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("workspace finalization did not start")
	}

	if _, err := e.FollowUp(ctx, id, "sent during finalization"); err != nil {
		t.Fatalf("a message sent while an orchestrated turn finalizes should be accepted: %v", err)
	}
	queued, err := st.ListPendingPrompts(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(queued) != 1 || queued[0].Prompt != "sent during finalization" {
		t.Fatalf("queue = %+v, want the message that was just sent", queued)
	}
	ad.mu.Lock()
	started := ad.started
	ad.mu.Unlock()
	if started != 1 {
		t.Fatalf("adapter started %d run(s), want 1 (the turn still finalizing): the message must wait for the boundary", started)
	}
	e.mu.Lock()
	committing := e.workspaceCommitting[id]
	settles := e.workspaceCommitSettles[id]
	e.mu.Unlock()
	if committing != execID {
		t.Fatalf("workspaceCommitting[%s] = %q, want %q: the test is not inside the commit window", id, committing, execID)
	}
	if !settles {
		t.Fatalf("workspaceCommitSettles[%s] = false: the orchestrated turn end must arm the settle hook it now has", id)
	}

	close(rt.finalizeRelease)
	specs := waitForStarts(t, ad, 2, 5*time.Second)
	if !strings.Contains(specs[1].Prompt, "sent during finalization") {
		t.Fatalf("the turn started at the boundary was asked for %q, want the queued message", specs[1].Prompt)
	}
	releaseGate()
	<-done
	_ = waitStatus(t, e, id, StatusSucceeded, 10*time.Second)
	if left, err := st.ListPendingPrompts(ctx, id); err != nil || len(left) != 0 {
		t.Fatalf("queue after delivery = %+v (err %v), want the message delivered exactly once", left, err)
	}
}

// A turn that fails to finalize cannot hand the messages its commit window
// accepted to a new run, so it reports them. They stay in the queue rather than
// vanishing, and the report is the one users already know from the adapter path.
func TestAnOrchestratedFinalizationFailureReportsPromptsQueuedDuringFinalization(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{gate: make(chan struct{}), events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &gatedFailingFinalizeRuntime{
		fakeWorkspaceRuntime: &fakeWorkspaceRuntime{},
		started:              make(chan struct{}),
		release:              make(chan struct{}),
	}
	e.SetWorkspaceRuntime(rt)
	t.Cleanup(func() { close(ad.gate) })

	id, _, done := startOrchestratedTurnFinalizing(t, e, ctx)
	select {
	case <-rt.started:
	case <-time.After(5 * time.Second):
		t.Fatal("workspace finalization did not start")
	}

	if _, err := e.FollowUp(ctx, id, "sent during finalization"); err != nil {
		t.Fatalf("follow-up during finalization: %v", err)
	}
	close(rt.release)
	_ = waitStatus(t, e, id, StatusFailed, 5*time.Second)
	<-done

	needle := "queued prompt(s) not delivered: workspace finalization failed"
	deadline := time.Now().Add(5 * time.Second)
	for {
		if n := reportsNaming(t, st, id, 0, needle); n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reports=%d want 1: a message accepted during a failed orchestrated finalization must be reported, not parked",
				reportsNaming(t, st, id, 0, needle))
		}
		time.Sleep(10 * time.Millisecond)
	}
	queued, err := st.ListPendingPrompts(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(queued) != 1 || queued[0].Prompt != "sent during finalization" {
		t.Fatalf("queue = %+v, want the reported message still stranded for the user to resend", queued)
	}
}

// A canceled turn does not hand its commit-window messages to a new run: the
// reader ended the work, and starting a turn for them is the opposite of what
// they asked. The message is reported instead of silently parked.
func TestAnOrchestratedCancelReportsPromptsQueuedDuringFinalization(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{gate: make(chan struct{}), events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{
		finalizeStarted: make(chan struct{}),
		finalizeRelease: make(chan struct{}),
	}
	e.SetWorkspaceRuntime(rt)
	t.Cleanup(func() { close(ad.gate) })

	id, _, done := startOrchestratedTurnFinalizing(t, e, ctx)
	// The canceled state is set the way the adapter cancel tests set it: the
	// cancel itself is not the behaviour under test, the turn end that finds it is.
	e.mu.Lock()
	e.canceled[id] = true
	e.mu.Unlock()
	select {
	case <-rt.finalizeStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("workspace finalization did not start")
	}

	if _, err := e.FollowUp(ctx, id, "sent during finalization"); err != nil {
		t.Fatalf("follow-up during a canceled turn's finalization: %v", err)
	}
	close(rt.finalizeRelease)
	_ = waitStatus(t, e, id, StatusCanceled, 5*time.Second)
	<-done

	needle := "queued prompt(s) not delivered: the task was canceled"
	deadline := time.Now().Add(5 * time.Second)
	for {
		if n := reportsNaming(t, st, id, 0, needle); n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reports=%d want 1: a message accepted during a canceled turn's finalization must be reported, not parked",
				reportsNaming(t, st, id, 0, needle))
		}
		time.Sleep(10 * time.Millisecond)
	}
	ad.mu.Lock()
	started := ad.started
	ad.mu.Unlock()
	if started != 1 {
		t.Fatalf("adapter started %d run(s), want 1: a canceled turn must not start another", started)
	}
	queued, err := st.ListPendingPrompts(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(queued) != 1 || queued[0].Prompt != "sent during finalization" {
		t.Fatalf("queue = %+v, want the reported message still stranded for the user to resend", queued)
	}
}

// The message can arrive after the boundary drain and the terminal status write,
// before the commit flag clears. The parked notifier holds the turn exactly
// there: finishRun has published the terminal status and retired the run, and
// the commit flag is still set. If the last-chance settle does not take this
// message, nothing does -- and the task stays terminal, so delivering it revives
// the task the same way a follow-up sent a moment later would.
func TestAnOrchestratedTurnEndSettlesAMessageAcceptedAfterTheDrain(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{gate: make(chan struct{}), events: successEvents()}
	e, st := testEngine(t, 4, ad)
	e.SetWorkspaceRuntime(&fakeWorkspaceRuntime{})
	notifier := newParkedNotifier()
	e.SetNotifier(notifier)
	t.Cleanup(notifier.releaseAll)
	releaseGate := releaseOnce(ad.gate)
	t.Cleanup(releaseGate)

	id, execID, done := startOrchestratedTurnFinalizing(t, e, ctx)
	select {
	case <-notifier.reached:
	case <-time.After(5 * time.Second):
		t.Fatal("the turn end never reached its terminal status write")
	}

	got, err := e.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusSucceeded {
		t.Fatalf("status = %s, want %s: the message must arrive after the terminal write", got.Status, StatusSucceeded)
	}
	e.mu.Lock()
	committing := e.workspaceCommitting[id]
	settles := e.workspaceCommitSettles[id]
	e.mu.Unlock()
	if committing != execID || !settles {
		t.Fatalf("commit window = (%q, settles %v), want (%q, true): the test is not inside the window it names",
			committing, settles, execID)
	}

	if _, err := e.FollowUp(ctx, id, "after the drain"); err != nil {
		t.Fatalf("follow-up after the boundary drain: %v", err)
	}
	ad.mu.Lock()
	started := ad.started
	ad.mu.Unlock()
	if started != 1 {
		t.Fatalf("adapter started %d run(s) while the workspace was committing, want 1", started)
	}

	notifier.releaseAll()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the orchestrated turn end did not finish after the notifier was released")
	}

	specs := waitForStarts(t, ad, 2, 5*time.Second)
	if !strings.Contains(specs[1].Prompt, "after the drain") {
		t.Fatalf("the revived turn was asked for %q, want the message accepted after the drain", specs[1].Prompt)
	}
	releaseGate()
	_ = waitStatus(t, e, id, StatusSucceeded, 10*time.Second)
	if left, err := st.ListPendingPrompts(ctx, id); err != nil || len(left) != 0 {
		t.Fatalf("queue after delivery = %+v (err %v), want the message delivered exactly once", left, err)
	}
}
