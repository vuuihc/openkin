package task

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// terminalPush is what the notifier saw at the moment it was told the task
// ended: the status it announced, and the "not delivered" reports already in the
// task's transcript. A reader of the status is the earliest external observer of
// a transition, so it is the one that must not have to wait for the explanation
// to be written afterwards.
type terminalPush struct {
	status  string
	reports []string
}

// reportWatchingNotifier lists the task's events inside NotifyTaskTerminal. That
// call is synchronous with the engine's terminal transition, so what it can read
// is exactly what any client reacting to the status can read at that instant.
type reportWatchingNotifier struct {
	store *store.Store
	seen  chan terminalPush
}

func (n *reportWatchingNotifier) NotifyApproval(context.Context, string, string, string) {}

func (n *reportWatchingNotifier) NotifyTaskTerminal(ctx context.Context, id, _ string, status string) {
	var reports []string
	if events, err := n.store.ListEvents(ctx, id, 0); err == nil {
		for _, ev := range events {
			var payload map[string]string
			if ev.Type != "error" || json.Unmarshal(ev.Payload, &payload) != nil {
				continue
			}
			if strings.Contains(payload["message"], "not delivered") {
				reports = append(reports, payload["message"])
			}
		}
	}
	select {
	case n.seen <- terminalPush{status: status, reports: reports}:
	default:
	}
}

func waitForTerminalPush(t *testing.T, n *reportWatchingNotifier, timeout time.Duration) terminalPush {
	t.Helper()
	select {
	case push := <-n.seen:
		return push
	case <-time.After(timeout):
		t.Fatal("the task ended without a terminal notification")
		return terminalPush{}
	}
}

// A turn that fails to finalize its workspace ends `failed` and leaves the
// message it could not answer in the queue. The sentence naming that message
// must already be committed when the terminal notification fires: the phone's
// failure push, a ws task message, and a client that reads the events once all
// react to the status, and none of them should be able to see a failed task with
// no reason in its transcript.
//
// On the old two-step order this is red by construction, not by scheduling: the
// notification fires inside publishFinishedTask, before the report was appended.
func TestTerminalNotificationFindsTheUndeliveredReport(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		},
		runFor: 400 * time.Millisecond,
	}
	e, st := testEngine(t, 4, ad)
	e.SetWorkspaceRuntime(&fakeWorkspaceRuntime{failInspectFinalizable: errors.New("worktree is dirty")})
	n := &reportWatchingNotifier{store: st, seen: make(chan terminalPush, 4)}
	e.SetNotifier(n)

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "start", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	if _, err := e.FollowUp(ctx, task.ID, "also update the changelog"); err != nil {
		t.Fatal(err)
	}
	ws, err := st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.CompleteWorkspace(ctx, WorkspaceIntentRequest{
		TaskID: task.ID, ExecutionID: ws.RequestedExecutionID,
	}); err != nil {
		t.Fatal(err)
	}

	push := waitForTerminalPush(t, n, 5*time.Second)
	if push.status != StatusFailed {
		t.Fatalf("notification status = %q, want failed", push.status)
	}
	want := "1 queued prompt(s) not delivered: workspace finalization failed"
	if len(push.reports) != 1 || push.reports[0] != want {
		t.Fatalf("the terminal notification saw reports %q, want %q: a reader of the status must be able to see the reason it stranded a message",
			push.reports, want)
	}
	_ = waitStatus(t, e, task.ID, StatusFailed, 5*time.Second)
}

// The canceled twin. A message accepted during the commit window is not handed
// to a new run -- the user ended the work -- so it is reported. The cancel this
// turn writes and that report are one transition, so the notification fired with
// the status already carries the sentence.
func TestCancelNotificationFindsTheUndeliveredReport(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{gate: make(chan struct{}), events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{
		finalizeStarted: make(chan struct{}),
		finalizeRelease: make(chan struct{}),
	}
	e.SetWorkspaceRuntime(rt)
	releaseFinalize := releaseOnce(rt.finalizeRelease)
	t.Cleanup(releaseFinalize)
	n := &reportWatchingNotifier{store: st, seen: make(chan terminalPush, 4)}
	e.SetNotifier(n)

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "start", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	execID := waitActiveRun(t, e, task.ID)
	// The canceled state is set the way the other adapter-loop cancel tests set
	// it: the cancel itself is not the behaviour under test, the turn end that
	// finds it is. It goes in before the run ends, because the turn end reads and
	// deletes it under e.mu as one of its first acts.
	e.mu.Lock()
	e.canceled[task.ID] = true
	e.mu.Unlock()
	if _, err := e.CompleteWorkspace(ctx, WorkspaceIntentRequest{
		TaskID: task.ID, ExecutionID: execID,
	}); err != nil {
		t.Fatal(err)
	}
	close(ad.gate)

	select {
	case <-rt.finalizeStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("workspace finalization did not start")
	}
	if _, err := e.FollowUp(ctx, task.ID, "sent during finalization"); err != nil {
		t.Fatalf("follow-up during a canceled turn's finalization: %v", err)
	}
	releaseFinalize()

	push := waitForTerminalPush(t, n, 5*time.Second)
	if push.status != StatusCanceled {
		t.Fatalf("notification status = %q, want canceled", push.status)
	}
	want := "1 queued prompt(s) not delivered: the task was canceled"
	if len(push.reports) != 1 || push.reports[0] != want {
		t.Fatalf("the terminal notification saw reports %q, want %q: a reader of the status must be able to see the reason it stranded a message",
			push.reports, want)
	}
	_ = waitStatus(t, e, task.ID, StatusCanceled, 5*time.Second)
}

// The report is written once, not once by the transition and again by the tail
// settle. The settle runs after the commit flag clears, so a single read right
// after the status row changes cannot see a duplicate; the happens-after here is
// a sentinel task. The engine runs one task at a time in this test, so the
// sentinel cannot start until the failed turn's final pump -- which is after the
// settle. Reading the transcript once at that point is deterministic.
func TestAWorkspaceFailureReportsItsQueuedPromptsExactlyOnce(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{gate: make(chan struct{}), events: successEvents()}
	e, st := testEngine(t, 1, ad)
	e.SetWorkspaceRuntime(&fakeWorkspaceRuntime{failInspectFinalizable: errors.New("worktree is dirty")})

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "start", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	execID := waitActiveRun(t, e, task.ID)
	if _, err := e.FollowUp(ctx, task.ID, "also update the changelog"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.CompleteWorkspace(ctx, WorkspaceIntentRequest{
		TaskID: task.ID, ExecutionID: execID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "sentinel"}); err != nil {
		t.Fatal(err)
	}
	close(ad.gate)

	_ = waitStatus(t, e, task.ID, StatusFailed, 5*time.Second)
	waitForStarts(t, ad, 2, 5*time.Second)

	n := reportsNaming(t, st, task.ID, 0,
		"queued prompt(s) not delivered: workspace finalization failed")
	if n != 1 {
		t.Fatalf("reports=%d want exactly 1: the transition and the tail settle must not both name the same message", n)
	}
}

// The canceled twin of the exactly-once guard.
func TestACanceledTurnReportsItsQueuedPromptsExactlyOnce(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{gate: make(chan struct{}), events: successEvents()}
	e, st := testEngine(t, 1, ad)
	e.SetWorkspaceRuntime(&fakeWorkspaceRuntime{})

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "start", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	execID := waitActiveRun(t, e, task.ID)
	e.mu.Lock()
	e.canceled[task.ID] = true
	e.mu.Unlock()
	if _, err := e.FollowUp(ctx, task.ID, "also update the changelog"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.CompleteWorkspace(ctx, WorkspaceIntentRequest{
		TaskID: task.ID, ExecutionID: execID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "sentinel"}); err != nil {
		t.Fatal(err)
	}
	close(ad.gate)

	_ = waitStatus(t, e, task.ID, StatusCanceled, 5*time.Second)
	waitForStarts(t, ad, 2, 5*time.Second)

	n := reportsNaming(t, st, task.ID, 0,
		"queued prompt(s) not delivered: the task was canceled")
	if n != 1 {
		t.Fatalf("reports=%d want exactly 1: the transition and the tail settle must not both name the same message", n)
	}
}

// The tail settle identifies what it still owes by queue id, not by count. A
// named message withdrawn from the head in the window between the transition and
// the settle must not make the later message invisible: a count would see one
// row, call it the one already reported, and leave the new message parked on a
// terminal task with no report.
func TestTheTailSettleReportsOnlyMessagesAcceptedAfterTheTransition(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	task := finalizingTask(t, e, st, "01SETTLEWATERMARK00000001")

	if _, err := e.FollowUp(ctx, task.ID, "named by the transition"); err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.activeRuns[task.ID] = "execution-1"
	e.mu.Unlock()
	_, reportedThrough, err := e.finishRunWithReport(ctx, task.ID, "execution-1", StatusFailed, nil, nil,
		"workspace finalization failed")
	if err != nil {
		t.Fatal(err)
	}
	if reportedThrough == 0 {
		t.Fatal("the transition named nothing, so the setup is wrong")
	}

	// Accepted while the commit flag is still set, then the named message is
	// withdrawn: the queue now holds one row, and it is the new one.
	if _, err := e.FollowUp(ctx, task.ID, "accepted after the transition"); err != nil {
		t.Fatal(err)
	}
	queued, err := st.ListPendingPrompts(ctx, task.ID)
	if err != nil || len(queued) != 2 {
		t.Fatalf("queue = %+v (err %v), want the named message and the new one", queued, err)
	}
	if _, removed, err := st.WithdrawPendingPrompt(ctx, task.ID, queued[0].ID); err != nil || !removed {
		t.Fatalf("withdraw = (%v, %v), want the named message removed", removed, err)
	}

	e.clearWorkspaceCompletion(task.ID, "execution-1")
	e.settlePromptsQueuedDuringFinalization(ctx, task.ID, "workspace finalization failed", reportedThrough)

	if n := reportsNaming(t, st, task.ID, 0, "not delivered"); n != 2 {
		t.Fatalf("reports=%d want 2: the transition's and the one for the message accepted after it", n)
	}
	if n := reportsNaming(t, st, task.ID, 0,
		"1 queued prompt(s) not delivered: workspace finalization failed"); n != 2 {
		t.Fatalf("reports naming exactly one message=%d want 2", n)
	}
}
