package task

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
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
	var told bool
	for _, ev := range evs {
		if ev.Type == "error" && strings.Contains(string(ev.Payload), "queued prompt") {
			told = true
		}
	}
	if !told {
		t.Fatal("the discarded prompts were not reported in the transcript")
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
