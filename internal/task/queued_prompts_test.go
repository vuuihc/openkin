package task

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// A prompt sent to a task that is still working waits its turn.
//
// The costs this replaces are the reason the queue exists: interrupting used to
// cancel the work in flight, deny every pending approval and answer every pending
// question on the user's behalf. Everything asserted below was destroyed by
// sending one sentence, and a phone user has no way to see that coming.

func runningTaskWithPendingApproval(t *testing.T, e *Engine, st *store.Store) store.Task {
	t.Helper()
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	if _, err := e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID:  task.ID,
		Kind:    "tool_use",
		Payload: json.RawMessage(`{"tool_name":"Write","input":{"file_path":"/tmp/x","content":"hi"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	return waitStatus(t, e, task.ID, StatusWaitingApproval, 2*time.Second)
}

func TestAPromptSentToABusyTaskLeavesTheWorkAlone(t *testing.T) {
	ctx := context.Background()
	// Long enough that nothing ends on its own: every assertion below is about
	// what queuing did *not* do to a live turn.
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)},
		},
		runFor: 30 * time.Second,
	}
	e, st := testEngine(t, 4, ad)
	task := runningTaskWithPendingApproval(t, e, st)

	question, err := e.RequestUserQuestion(ctx, CreateUserQuestionRequest{
		TaskID: task.ID, Question: "Still?",
		Options: []UserQuestionOption{{Label: "A"}, {Label: "B"}},
	})
	if err != nil {
		t.Fatal(err)
	}

	before, err := st.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.FollowUp(ctx, task.ID, "also check the logs"); err != nil {
		t.Fatalf("a prompt sent to a waiting task should be accepted: %v", err)
	}

	// The three things the interrupt path used to do, none of which happened.
	pending, err := st.ListPendingForTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].Decision != store.DecisionPending {
		t.Fatalf("pending approvals = %+v, want the one approval still undecided", pending)
	}
	questions, err := st.ListPendingUserQuestionsForTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(questions) != 1 || questions[0].ID != question.ID {
		t.Fatalf("pending questions = %+v, want the question still waiting for the user", questions)
	}
	after, err := st.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != before.Status {
		t.Fatalf("task status = %s, want %s: the queued prompt moved a turn it is supposed to leave alone",
			after.Status, before.Status)
	}

	// What did happen: the message is in the chat, and it is in the queue.
	queued, err := st.ListPendingPrompts(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(queued) != 1 || queued[0].Prompt != "also check the logs" {
		t.Fatalf("queue = %+v, want the message that was just sent", queued)
	}
	if queued[0].UserSeq <= 0 {
		t.Fatalf("queued message has no user event seq: %+v", queued[0])
	}
	evs, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var visible bool
	for _, ev := range evs {
		if ev.Type != "message" || ev.Seq != queued[0].UserSeq {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if m["role"] != "user" {
			continue
		}
		visible = strings.Contains(string(ev.Payload), "also check the logs")
	}
	if !visible {
		t.Fatal("the queued message is not in the transcript: the sender would see nothing")
	}
}

func TestQueuedPromptsAreDeliveredOnePerTurnInOrder(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)},
		},
		runFor: 80 * time.Millisecond,
	}
	e, st := testEngine(t, 4, ad)
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "alpha"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	for _, text := range []string{"beta", "gamma"} {
		if _, err := e.FollowUp(ctx, task.ID, text); err != nil {
			t.Fatal(err)
		}
	}

	specs := waitForStarts(t, ad, 3, 5*time.Second)
	for i, want := range []string{"alpha", "beta", "gamma"} {
		if !strings.Contains(specs[i].Prompt, want) {
			t.Fatalf("run %d was asked for %q, want the %q turn", i, specs[i].Prompt, want)
		}
	}
	// One message per turn: by the time all three have run, the queue is empty
	// rather than having been folded into a single prompt.
	if left, err := st.ListPendingPrompts(ctx, task.ID); err != nil || len(left) != 0 {
		t.Fatalf("queue after delivery = %+v (err %v), want empty", left, err)
	}
}

// Cancel means stop, including the messages that were waiting for a turn that is
// never coming. They are reported rather than dropped in silence.
func TestCancelDiscardsQueuedPromptsAndSaysSo(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)},
		},
		runFor: 30 * time.Second,
	}
	e, st := testEngine(t, 4, ad)
	task := runningTaskWithPendingApproval(t, e, st)
	if _, err := e.FollowUp(ctx, task.ID, "never mind"); err != nil {
		t.Fatal(err)
	}
	live := e.bus.Subscribe()
	defer e.bus.Unsubscribe(live)

	if _, err := e.Cancel(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	left, err := st.ListPendingPrompts(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 0 {
		t.Fatalf("queue survived the cancel: %+v", left)
	}
	evs, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var told, streamed bool
	for _, ev := range evs {
		if ev.Type == "error" && strings.Contains(string(ev.Payload), "queued prompt") {
			told = true
		}
	}
	if !told {
		t.Fatal("the discarded prompts were not reported in the transcript")
	}
	deadline := time.Now().Add(2 * time.Second)
	for !streamed && time.Now().Before(deadline) {
		select {
		case msg := <-live:
			ev, ok := msg.Data.(store.Event)
			if ok && ev.Type == "error" && strings.Contains(string(ev.Payload), "queued prompt") {
				streamed = true
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !streamed {
		t.Fatal("the reported drop was written to the transcript but never sent to a watching console")
	}
}

// The turn a queued message was waiting for can die with the process. The message
// outlives it, and recovery is what delivers it -- the sender is a phone that has
// already been put away and will not resend.
func TestAQueuedPromptOutlivesARestart(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	holding := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)},
		},
		runFor: 30 * time.Second,
	}
	e1 := NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": holding}, NewBus(), 2)
	task, err := e1.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e1, task.ID, StatusRunning, 2*time.Second)
	if _, err := e1.FollowUp(ctx, task.ID, "still there after a restart?"); err != nil {
		t.Fatal(err)
	}
	e1.Close() // the process dies mid-turn

	// A new daemon over the same database, with an adapter that finishes.
	answering := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s2","subtype":"init"}`)},
		},
		runFor: 10 * time.Millisecond,
	}
	e2 := NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": answering}, NewBus(), 2)
	defer e2.Close()
	if err := e2.Recover(ctx); err != nil {
		t.Fatal(err)
	}

	specs := waitForStarts(t, answering, 1, 5*time.Second)
	if !strings.Contains(specs[0].Prompt, "still there after a restart?") {
		t.Fatalf("after recovery the agent was asked for %q, want the queued message", specs[0].Prompt)
	}
	if left, err := st.ListPendingPrompts(ctx, task.ID); err != nil || len(left) != 0 {
		t.Fatalf("queue after recovery = %+v (err %v), want empty", left, err)
	}
}

// A queue that cannot be read is not an empty queue. The distinction decides
// whether a message the user can see is reported as undeliverable or silently
// stops existing, so the failure has to reach the transcript.
func TestAQueueThatCannotBeReadIsReportedNotTreatedAsEmpty(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		},
		runFor: 400 * time.Millisecond,
	}
	e, st := testEngine(t, 4, ad)
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	if _, err := e.FollowUp(ctx, task.ID, "answer this"); err != nil {
		t.Fatal(err)
	}
	// The queue becomes unreadable before the turn boundary reaches it. Dropping the
	// table is the cheapest way to produce the read failure every delivery path has
	// to survive; the boundary cannot tell this apart from a busy or closed database.
	if _, err := st.DB().ExecContext(ctx, `DROP TABLE task_pending_prompts`); err != nil {
		t.Fatal(err)
	}

	waitStatus(t, e, task.ID, StatusFailed, 5*time.Second)
	evs, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var told bool
	for _, ev := range evs {
		if ev.Type == "error" && strings.Contains(string(ev.Payload), "could not be delivered") {
			told = true
		}
	}
	if !told {
		t.Fatal("a failed delivery was not reported: the message stopped existing silently")
	}
}

// The label is one line and one line only: a pasted stack trace must not turn the
// error into a wall of text in the chat, and a message with no words left after
// trimming still has to be named as something.
func TestAQueuedMessageIsNamedInOneLine(t *testing.T) {
	label := func(prompt string) string {
		return messageLabel(prompt)
	}

	if got := label("  and the docs too\n"); got != `"and the docs too"` {
		t.Fatalf("label = %s", got)
	}
	if got := label("line one\nline two"); got != `"line one line two"` {
		t.Fatalf("label = %s", got)
	}
	long := strings.Repeat("x", 60)
	if got := label(long); got != `"`+strings.Repeat("x", 48)+`…"` {
		t.Fatalf("label = %s", got)
	}
	if got := label("   "); !strings.Contains(got, "no text") {
		t.Fatalf("a message with no words was named %s", got)
	}
}

// A delivery failure names the message it lost. Several can be waiting at once and
// "a queued prompt" does not tell the user which one to write again -- the message
// is gone from the queue by then, so the report is all they have to go on.
func TestAFailedDeliveryNamesTheMessageItLost(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		},
		runFor: 400 * time.Millisecond,
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{
		"claude-code": ad, "kin": ad,
	}, NewBus(), 4)
	t.Cleanup(e.Close)
	if err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	// A hand-off, accepted while the task is busy: the message is queued, and the
	// boundary that hands it over is the one that fails.
	if _, err := e.FollowUpWith(ctx, task.ID, FollowUpRequest{
		Prompt: "send it to the other one", Agent: "kin",
	}); err != nil {
		t.Fatal(err)
	}
	// The write the hand-off needs is the one that fails. Dropping a table is the
	// cheapest way to fail a store write the way a busy or closed database does;
	// what matters here is that the failure happens after the message was taken
	// off the queue, which is why the report is the only trace of it left.
	if _, err := st.DB().ExecContext(ctx, `DROP TABLE task_agent_sessions`); err != nil {
		t.Fatal(err)
	}

	// The report is what is left of the message: it came off the queue before the
	// hand-off failed, so nothing else in the system knows it existed.
	var told string
	deadline := time.Now().Add(5 * time.Second)
	for told == "" && time.Now().Before(deadline) {
		evs, err := e.Events(ctx, task.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, ev := range evs {
			if ev.Type == "error" && strings.Contains(string(ev.Payload), "could not be delivered") {
				told = string(ev.Payload)
			}
		}
		if told == "" {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if !strings.Contains(told, "send it to the other one") {
		t.Fatalf("the failed delivery does not say which message was lost: %s", told)
	}
}

// A run that ends with the workspace unmerged delivers nothing, and says so: the
// messages stay queued for whatever the user does next (a prompt, a retry), but
// nothing should look like it is still on its way.
func TestAWorkspaceFailureReportsThePromptsItCouldNotDeliver(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		},
		runFor: 400 * time.Millisecond,
	}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{failInspectFinalizable: errors.New("worktree is dirty")}
	e.SetWorkspaceRuntime(rt)

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
	// The turn asks to finalize while the message is still queued behind it, so the
	// boundary that would have delivered it is the one whose finalization fails.
	ws, err := st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.CompleteWorkspace(ctx, WorkspaceIntentRequest{
		TaskID: task.ID, ExecutionID: ws.RequestedExecutionID,
	}); err != nil {
		t.Fatal(err)
	}

	_ = waitStatus(t, e, task.ID, StatusFailed, 5*time.Second)
	evs, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var told bool
	for _, ev := range evs {
		if ev.Type == "error" && strings.Contains(string(ev.Payload), "not delivered") {
			told = true
		}
	}
	if !told {
		t.Fatal("the queue was stranded by a workspace failure without being reported")
	}
	// Stranded, not discarded: the message is still the user's to have answered, and
	// the next prompt this task accepts delivers from the head.
	if left, err := st.ListPendingPrompts(ctx, task.ID); err != nil || len(left) != 1 {
		t.Fatalf("queue after the workspace failure = %+v (err %v), want the message kept", left, err)
	}
}

// A retry rewinds the transcript. A queued message whose own user event the rewind
// deletes has nothing left to be answered against, so it goes -- reported, the way
// cancel reports its drops.
func TestRetryDropsQueuedPromptsWhoseMessageItDeleted(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "first turn"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	// The state a failed finalization (or a failed start) leaves behind: a message
	// that was accepted, written to the transcript, and never answered.
	payload, _ := json.Marshal(map[string]any{
		"role": "user", "content": []map[string]string{{"type": "text", "text": "never answered"}},
		"partial": false, "agent": "user", "speaker": "user", "source": "follow_up",
	})
	ev, err := st.AppendEvent(ctx, task.ID, "message", payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "never answered", UserSeq: ev.Seq,
	}); err != nil {
		t.Fatal(err)
	}

	// A console watching this task is told, not left to notice on its next fetch
	// that a sequence number went by without a message.
	live := e.bus.Subscribe()
	defer e.bus.Unsubscribe(live)

	// Retrying from the first turn deletes that message along with everything after it.
	firstSeq := firstUserSeq(t, st, task.ID)
	if _, err := e.Retry(ctx, task.ID, RetryRequest{FromSeq: firstSeq}); err != nil {
		t.Fatal(err)
	}

	if left, err := st.ListPendingPrompts(ctx, task.ID); err != nil || len(left) != 0 {
		t.Fatalf("queue after the retry = %+v (err %v), want the orphaned message gone", left, err)
	}
	evs, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var told, streamed bool
	for _, ev := range evs {
		if ev.Type == "error" && strings.Contains(string(ev.Payload), "queued prompt(s) discarded") {
			told = true
		}
	}
	if !told {
		t.Fatal("the retry dropped a queued message without saying so")
	}
	deadline := time.Now().Add(2 * time.Second)
	for !streamed && time.Now().Before(deadline) {
		select {
		case msg := <-live:
			ev, ok := msg.Data.(store.Event)
			if ok && ev.Type == "error" &&
				strings.Contains(string(ev.Payload), "queued prompt(s) discarded") {
				streamed = true
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !streamed {
		t.Fatal("the reported drop was written to the transcript but never sent to a watching console")
	}
}

// The retry's report that it dropped a queued message is written with the drop, in
// the same transaction. Writing it afterwards leaves a window where the process can
// die having taken the user's message and said nothing about it -- and the window is
// unclosable from outside, because the count of what was dropped exists only inside
// that transaction. A restart cannot reconstruct it; it can only find it, which is
// what this test does.
func TestTheRetryDiscardReportSurvivesAProcessThatDiesBeforePublishingIt(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	task := store.Task{
		ID: "01RETRYDISCARDREPORT0001", Title: "retry", Agent: "kin",
		Cwd: t.TempDir(), Prompt: "first turn", Status: StatusFailed,
		CreatedAt: store.NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	first, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(
		`{"role":"user","content":[{"type":"text","text":"first turn"}],"speaker":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	// The state a failed finalization leaves behind: a message that was accepted,
	// written to the transcript, and never answered -- so it is still queued.
	payload, _ := json.Marshal(map[string]any{
		"role": "user", "content": []map[string]string{{"type": "text", "text": "never answered"}},
		"partial": false, "agent": "user", "speaker": "user", "source": "follow_up",
	})
	queued, err := st.AppendEvent(ctx, task.ID, "message", payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "never answered", UserSeq: queued.Seq,
	}); err != nil {
		t.Fatal(err)
	}

	intent := store.RetryRestoreIntent{
		TaskID: task.ID, FromSeq: first.Seq, Prompt: "after",
		UserPayload: json.RawMessage(`{"role":"user","content":[{"type":"text","text":"after"}]}`),
	}
	if err := st.BeginRetryRestore(ctx, intent); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CompleteRetryRestore(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	// The process dies here: the retry committed, and nothing has published it.

	if left, err := st.ListPendingPrompts(ctx, task.ID); err != nil || len(left) != 0 {
		t.Fatalf("queue after the retry = %+v (err %v), want it cleared", left, err)
	}

	// A new process comes up on the same database and replays the retry.
	ad := &fakeAdapter{events: successEvents()}
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": ad}, NewBus(), 1)
	defer e.Close()
	if err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	evs, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var told bool
	for _, ev := range evs {
		if ev.Type == "error" && strings.Contains(string(ev.Payload), "queued prompt(s) discarded") {
			told = true
		}
	}
	if !told {
		t.Fatal("the transcript lost the message and the record of why, across the restart")
	}
}

// The delivery of a queued message is a normal turn: it resumes the session, it
// does not pretend the previous turn was interrupted, it answers the message
// exactly once, and it anchors its checkpoint at that message rather than at
// whatever happens to be newest.
func TestADeliveredPromptIsAnsweredOnceAndAnchoredAtItsOwnMessage(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		},
		runFor: 80 * time.Millisecond,
	}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "alpha", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	if _, err := e.FollowUp(ctx, task.ID, "beta"); err != nil {
		t.Fatal(err)
	}
	queued, err := st.ListPendingPrompts(ctx, task.ID)
	if err != nil || len(queued) != 1 {
		t.Fatalf("queue = %+v (err %v), want the message just sent", queued, err)
	}
	target := queued[0].UserSeq
	specs := waitForStarts(t, ad, 2, 5*time.Second)

	// The delivered turn continues the same session. Saying "interrupted" instead
	// would make it re-read context it does not need and drop the session it can
	// resume -- which is the whole reason the queue is not the interrupt path.
	if specs[1].SessionRef == "" {
		t.Fatalf("delivered turn did not resume the session: %+v", specs[1])
	}
	if strings.Contains(specs[1].Prompt, "interrupted") {
		t.Fatalf("delivered turn was told it interrupted the user: %q", specs[1].Prompt)
	}
	if strings.Contains(specs[1].Prompt, "beta") == false {
		t.Fatalf("delivered turn was not asked the queued message: %q", specs[1].Prompt)
	}

	// One visible message, not two: the delivery must not write the user event again.
	evs, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	copies := 0
	for _, ev := range evs {
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if m["role"] != "user" && m["speaker"] != "user" {
			continue
		}
		if strings.Contains(string(ev.Payload), "beta") {
			copies++
		}
	}
	if copies != 1 {
		t.Fatalf("the queued message appears %d times in the transcript, want once", copies)
	}

	// And the checkpoint the delivery captured belongs to that message.
	rt.mu.Lock()
	captures := append([]captureCall(nil), rt.captures...)
	rt.mu.Unlock()
	var anchored bool
	for _, c := range captures {
		if c.EventSeq == target {
			anchored = true
		}
	}
	if !anchored {
		t.Fatalf("no checkpoint anchored at the delivered message (seq %d): captures = %+v", target, captures)
	}
}

// An interrupt is anchored at the message it answers, not at the newest one. A
// message the user sends while the interrupt winds down is queued and writes a
// newer user event, and a turn that claims a newer message than the one it is
// answering restores to the wrong point.
func TestAnInterruptIsAnchoredAtItsOwnMessageNotTheNewest(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "the one being interrupted into",
		WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	interruptedSeq := firstUserSeq(t, st, task.ID)

	// The newer message: sent while the interrupt was still winding down, so it waits
	// in the queue and its event is the newest user message in the stream.
	payload, _ := json.Marshal(map[string]any{
		"role": "user", "content": []map[string]string{{"type": "text", "text": "sent while winding down"}},
		"partial": false, "agent": "user", "speaker": "user", "source": "follow_up",
	})
	newer, err := st.AppendEvent(ctx, task.ID, "message", payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "sent while winding down", UserSeq: newer.Seq,
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := e.applyPendingFollowUp(ctx, task.ID, pendingFollowUp{
		req:         FollowUpRequest{Prompt: "stop and do this instead"},
		fromAgent:   "claude-code",
		interrupted: true,
		userSeq:     interruptedSeq,
	}); err != nil {
		t.Fatal(err)
	}

	rt.mu.Lock()
	captures := append([]captureCall(nil), rt.captures...)
	rt.mu.Unlock()
	var atOwn, atNewer bool
	for _, c := range captures {
		if c.EventSeq == interruptedSeq {
			atOwn = true
		}
		if c.EventSeq == newer.Seq {
			atNewer = true
		}
	}
	if !atOwn {
		t.Fatalf("interrupt anchored nowhere near its own message (seq %d): captures = %+v", interruptedSeq, captures)
	}
	if atNewer {
		t.Fatalf("interrupt anchored at a message queued after it (seq %d): captures = %+v", newer.Seq, captures)
	}
}

// A task waiting on a user question is not failed by recovery, so its queue needs a
// deliverer that does not come from the orphan list. Without one the message waits
// for a turn boundary that only the answer would produce.
func TestAQueuedPromptOnAWaitingTaskOutlivesARestart(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	holding := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		},
		runFor: 30 * time.Second,
	}
	e1 := NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": holding}, NewBus(), 2)
	task, err := e1.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e1, task.ID, StatusRunning, 2*time.Second)
	if _, err := e1.RequestUserQuestion(ctx, CreateUserQuestionRequest{
		TaskID: task.ID, Question: "Which file?",
		Options: []UserQuestionOption{{Label: "A"}, {Label: "B"}},
	}); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e1, task.ID, StatusWaitingInput, 2*time.Second)
	if _, err := e1.FollowUp(ctx, task.ID, "here is more context"); err != nil {
		t.Fatal(err)
	}
	e1.Close() // the process dies while the question is still open

	answering := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s2"}`)},
		},
		runFor: 10 * time.Millisecond,
	}
	e2 := NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": answering}, NewBus(), 2)
	defer e2.Close()
	if err := e2.Recover(ctx); err != nil {
		t.Fatal(err)
	}

	specs := waitForStarts(t, answering, 1, 5*time.Second)
	if !strings.Contains(specs[0].Prompt, "here is more context") {
		t.Fatalf("after recovery the agent was asked for %q, want the queued message", specs[0].Prompt)
	}
}

// waitForStarts waits until the adapter has been started at least want times and
// returns the specs it was started with, oldest first.
func waitForStarts(t *testing.T, ad *fakeAdapter, want int, timeout time.Duration) []adapter.TaskSpec {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		ad.mu.Lock()
		specs := append([]adapter.TaskSpec(nil), ad.specs...)
		ad.mu.Unlock()
		if len(specs) >= want {
			return specs
		}
		if time.Now().After(deadline) {
			t.Fatalf("adapter started %d run(s), want %d", len(specs), want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A restart can want the same task twice: the retry it is resuming, and the
// message that was queued while the task was away. However many of those arrive,
// the run queue has to end up holding one copy of the task.
//
// A second copy is not a second turn -- a turn is claimed by one queued-to-running
// update, so the later start loses the claim and aborts -- but the loser still
// runs its exit path with its own execution id, and that path clears the active-run
// entry. Clearing the winner's entry is the harm: a run with no active-run entry
// cannot persist its own events or its terminal status.
func TestARestartQueuesATaskOnceWhenBothRecoveriesWantIt(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	task := store.Task{
		ID: "01ONERECOVERYQUEUE00000001", Title: "retry", Agent: "kin",
		Cwd: t.TempDir(), Prompt: "first turn", Status: StatusFailed,
		CreatedAt: store.NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(
		`{"role":"user","content":[{"type":"text","text":"first turn"}],"speaker":"user"}`)); err != nil {
		t.Fatal(err)
	}
	// A message the user sent while that first turn was still going. Its own event
	// is anchored before the retry point, so the retry leaves the row alone: it is
	// still waiting after the restart, and it is the second recovery's reason to
	// want this task.
	queued, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(
		`{"role":"user","content":[{"type":"text","text":"never answered"}],"partial":false,"agent":"user","speaker":"user","source":"follow_up"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "never answered", UserSeq: queued.Seq,
	}); err != nil {
		t.Fatal(err)
	}

	// A retry that got as far as committing and no further: the intent is still
	// recorded, the task is queued, and the process died before publishing it.
	intent := store.RetryRestoreIntent{
		TaskID: task.ID, FromSeq: queued.Seq + 1, Prompt: "after",
		UserPayload: json.RawMessage(`{"role":"user","content":[{"type":"text","text":"after"}]}`),
	}
	if err := st.BeginRetryRestore(ctx, intent); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CompleteRetryRestore(ctx, task.ID); err != nil {
		t.Fatal(err)
	}

	// The adapter holds the turn open, so the queue can be read while the run the
	// restart decided on is still in flight.
	ad := &fakeAdapter{gate: make(chan struct{}), events: successEvents()}
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": ad}, NewBus(), 1)
	defer e.Close()
	if err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}

	e.mu.Lock()
	copies := 0
	for _, qid := range e.queue {
		if qid == task.ID {
			copies++
		}
	}
	e.mu.Unlock()
	if copies != 0 {
		t.Fatalf("the run queue holds %d copies of the task, want none: the run already going owns it", copies)
	}

	close(ad.gate)
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 5*time.Second)
	specs := waitForStarts(t, ad, 1, 5*time.Second)
	if len(specs) != 1 {
		t.Fatalf("adapter started %d run(s), want 1", len(specs))
	}
	if !strings.Contains(specs[0].Prompt, "never answered") {
		t.Fatalf("the resumed turn was asked for %q, want the message that was still waiting", specs[0].Prompt)
	}
	if left, err := st.ListPendingPrompts(ctx, task.ID); err != nil || len(left) != 0 {
		t.Fatalf("queue after the restart = %+v (err %v), want the message delivered exactly once", left, err)
	}
}

// An orchestrated turn ends at a turn boundary like any other one, so a message
// queued while it ran is delivered to a new turn rather than waiting for the next
// thing the user happens to send.
func TestAnOrchestratedTurnEndDeliversItsQueuedMessage(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{gate: make(chan struct{}), events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	if _, err := e.FollowUp(ctx, task.ID, "also check the logs"); err != nil {
		t.Fatal(err)
	}

	e.mu.Lock()
	executionID := e.activeRuns[task.ID]
	e.mu.Unlock()
	if executionID == "" {
		t.Fatal("no run is active: the setup is wrong, not the delivery")
	}
	e.finishOrchestrated(ctx, task.ID, executionID, false)

	specs := waitForStarts(t, ad, 2, 5*time.Second)
	if !strings.Contains(specs[1].Prompt, "also check the logs") {
		t.Fatalf("the turn started at the boundary was asked for %q, want the queued message", specs[1].Prompt)
	}
	close(ad.gate)
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 5*time.Second)
}

// A cancel and a delivery write the same row and hold no lock against each other,
// so one of them lands second. When the cancel lands first it has to win: a turn
// that starts for a task the console shows as stopped spends tokens and writes
// output nobody asked for.
func TestACancelThatWinsTheRaceIsNotUndoneByTheDelivery(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents(), runFor: 30 * time.Second}
	e, st := testEngine(t, 4, ad)
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	if _, err := e.Cancel(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusCanceled, 2*time.Second)

	// Stand where the delivery stands: the message is off the queue and in hand,
	// and the cancel committed in between.
	userEvent, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(
		`{"role":"user","content":[{"type":"text","text":"are you there?"}],"partial":false,"agent":"user","speaker":"user","source":"follow_up"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "are you there?", UserSeq: userEvent.Seq,
	}); err != nil {
		t.Fatal(err)
	}

	if _, ok, err := e.deliverQueuedPrompt(ctx, task.ID, respectCancel); !ok {
		t.Fatal("nothing was waiting: the setup is wrong, not the guard")
	} else if !errors.Is(err, store.ErrTaskCanceled) {
		t.Fatalf("delivery into a canceled task = %v, want store.ErrTaskCanceled", err)
	}
	if got, err := e.Get(ctx, task.ID); err != nil {
		t.Fatal(err)
	} else if got.Status != StatusCanceled {
		t.Fatalf("status after the refused delivery = %s, want %s", got.Status, StatusCanceled)
	}
	e.mu.Lock()
	queued := len(e.queue)
	e.mu.Unlock()
	if queued != 0 {
		t.Fatalf("the queue holds %d task(s) after the refused delivery, want none", queued)
	}

	// The other half, and the reason the guard is not a blanket refusal: the user's
	// own message is what revives a task they can see is stopped. Refusing that one
	// too would take away the only way back.
	again, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(
		`{"role":"user","content":[{"type":"text","text":"actually, keep going"}],"partial":false,"agent":"user","speaker":"user","source":"follow_up"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "actually, keep going", UserSeq: again.Seq,
	}); err != nil {
		t.Fatal(err)
	}
	revived, ok, err := e.deliverQueuedPrompt(ctx, task.ID, reviveCanceled)
	if err != nil || !ok {
		t.Fatalf("the user's own follow-up to a canceled task = ok %v, err %v, want it delivered", ok, err)
	}
	// Whether the new turn has already claimed the row is a race with the run
	// itself; what matters is that it is no longer stopped.
	if revived.Status == StatusCanceled {
		t.Fatal("the task is still canceled after the user's own follow-up was delivered")
	}
}

// A steer sent with an interrupt is applied at the end of the turn it cut short, and
// the run loop reads it into a value before the workspace finalization window opens.
// A cancel landing in that window therefore has nothing to delete: cancelTask drops
// the pending follow-up so that it does not fire, but the copy in hand is unaffected.
// The guarded write is what makes the cancel win there -- and the refusal has to name
// the message, because the message is in the transcript and nothing else says why it
// went unanswered.
func TestACancelRefusesTheInterruptsDeferredFollowUp(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents(), runFor: 30 * time.Second}
	e, _ := testEngine(t, 4, ad)
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	if _, err := e.Cancel(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusCanceled, 2*time.Second)

	// The steer as the run loop holds it: a value read before the cancel landed.
	_, err = e.applyPendingFollowUp(ctx, task.ID, pendingFollowUp{
		req:         FollowUpRequest{Prompt: "and the tests too"},
		fromAgent:   "claude-code",
		interrupted: true,
	})
	if !errors.Is(err, store.ErrTaskCanceled) {
		t.Fatalf("a deferred follow-up into a canceled task = %v, want store.ErrTaskCanceled", err)
	}
	if !strings.Contains(err.Error(), `"and the tests too"`) {
		t.Fatalf("the refusal does not name the message it dropped: %v", err)
	}
	if got, err := e.Get(ctx, task.ID); err != nil {
		t.Fatal(err)
	} else if got.Status != StatusCanceled {
		t.Fatalf("status after the refused follow-up = %s, want %s", got.Status, StatusCanceled)
	}
	e.mu.Lock()
	queued := len(e.queue)
	e.mu.Unlock()
	if queued != 0 {
		t.Fatalf("the queue holds %d task(s) after the refused follow-up, want none", queued)
	}
}

// The report of a refused delivery cannot go through the run gate. The cancel that
// refuses it is the same write that clears the active-run entry, so a run-scoped
// append returns ErrConflict: the one event that says why the user's message went
// unanswered would be dropped by the very race it describes.
//
// This does not drive the turn boundary -- it pins the two writes that boundary
// chooses between, which is what the choice rests on.
func TestARefusedDeliveryIsReportedAfterTheCancelClearedTheRun(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents(), runFor: 30 * time.Second}
	e, st := testEngine(t, 4, ad)
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	e.mu.Lock()
	execID := e.activeRuns[task.ID]
	e.mu.Unlock()
	if _, err := e.Cancel(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusCanceled, 2*time.Second)

	userEvent, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(
		`{"role":"user","content":[{"type":"text","text":"one more thing"}],"partial":false,"agent":"user","speaker":"user","source":"follow_up"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID: task.ID, Prompt: "one more thing", UserSeq: userEvent.Seq,
	}); err != nil {
		t.Fatal(err)
	}
	_, ok, err := e.deliverQueuedPrompt(ctx, task.ID, respectCancel)
	if !ok || !errors.Is(err, store.ErrTaskCanceled) {
		t.Fatalf("delivery into a canceled task = ok %v, err %v, want a refusal", ok, err)
	}

	// The write the branch must not use: gated on a run entry the cancel deleted.
	payload, _ := json.Marshal(map[string]string{"message": err.Error()})
	if _, gated := e.persistRunEvent(ctx, task.ID, execID, "error", payload); !errors.Is(gated, store.ErrConflict) {
		t.Fatalf("a run-scoped report after the cancel = %v, want store.ErrConflict", gated)
	}

	e.reportUndelivered(ctx, task.ID, err)
	events, err := st.ListEvents(ctx, task.ID, userEvent.Seq)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.Type != "error" {
			continue
		}
		var m map[string]string
		if err := json.Unmarshal(ev.Payload, &m); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(m["message"], `"one more thing"`) {
			return
		}
	}
	t.Fatal("the refused delivery left no report in the transcript saying which message went unanswered")
}
