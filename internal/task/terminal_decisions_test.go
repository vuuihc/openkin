package task

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

// A decision offered just before a task ends must not outlive the task it
// belongs to. Cancel has always settled what was waiting on it; failure and
// success did not, so a failed task kept offering 批准/拒绝 for the approval TTL
// and kept counting in the row's pending number. These tests drive the real
// terminal writers, not a hand-placed settle call, so a writer that skips the
// settle fails here.

// startedTask returns a task whose run is live and whose handle is registered,
// so the production terminal writers can end it the way a turn ending does.
func startedTask(t *testing.T) (e *Engine, st *store.Store, taskID, executionID string) {
	t.Helper()
	ctx := context.Background()
	e, st = testEngine(t, 4, longRunningAdapter())
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 5*time.Second)
	waitHandle(t, e, task.ID, 5*time.Second)
	return e, st, task.ID, waitActiveRun(t, e, task.ID)
}

func requestPendingApproval(t *testing.T, e *Engine, taskID string) store.Approval {
	t.Helper()
	a, err := e.RequestApproval(context.Background(), CreateApprovalRequest{
		TaskID:  taskID,
		Kind:    "tool_use",
		Payload: json.RawMessage(`{"tool_name":"Write","input":{"file_path":"/tmp/x"}}`),
	})
	if err != nil {
		t.Fatalf("request approval: %v", err)
	}
	return a
}

func requestPendingQuestion(t *testing.T, e *Engine, taskID string) store.UserQuestion {
	t.Helper()
	q, err := e.RequestUserQuestion(context.Background(), CreateUserQuestionRequest{
		TaskID:   taskID,
		Question: "Which auth method?",
		Header:   "Auth method",
		Options:  []UserQuestionOption{{Label: "JWT"}, {Label: "Session"}},
	})
	if err != nil {
		t.Fatalf("request user question: %v", err)
	}
	return q
}

// wantNoPendingDecisions is the store-level half of every test here: nothing is
// offered for the task, and the two list reads stop returning it.
func wantNoPendingDecisions(t *testing.T, e *Engine, st *store.Store, taskID string) {
	t.Helper()
	ctx := context.Background()
	if pending, err := st.ListPendingForTask(ctx, taskID); err != nil {
		t.Fatalf("list pending approvals: %v", err)
	} else if len(pending) != 0 {
		t.Fatalf("pending approvals after the task ended = %+v, want none", pending)
	}
	if pending, err := st.ListPendingUserQuestionsForTask(ctx, taskID); err != nil {
		t.Fatalf("list pending questions: %v", err)
	} else if len(pending) != 0 {
		t.Fatalf("pending user questions after the task ended = %+v, want none", pending)
	}
	approvals, err := e.ListApprovals(ctx, store.ListApprovalsOpts{
		Status: store.DecisionPending,
		Scope:  store.Unscoped(),
	})
	if err != nil {
		t.Fatalf("list approvals: %v", err)
	}
	for _, a := range approvals {
		if a.TaskID == taskID {
			t.Fatalf("GET /api/approvals?status=pending still offers %s for the ended task", a.ID)
		}
	}
	questions, err := e.ListUserQuestions(ctx, store.ListUserQuestionsOpts{
		Status: store.UQStatusPending,
		Scope:  store.Unscoped(),
	})
	if err != nil {
		t.Fatalf("list user questions: %v", err)
	}
	for _, q := range questions {
		if q.TaskID == taskID {
			t.Fatalf("GET /api/user-questions?status=pending still offers %s for the ended task", q.ID)
		}
	}
}

func TestFinishFailedResolvesPendingApproval(t *testing.T) {
	ctx := context.Background()
	e, st, taskID, execID := startedTask(t)
	a := requestPendingApproval(t, e, taskID)

	if _, err := e.finishRun(ctx, taskID, execID, StatusFailed, nil, nil); err != nil {
		t.Fatalf("finish failed: %v", err)
	}

	got, err := st.GetApproval(ctx, a.ID)
	if err != nil {
		t.Fatalf("get approval: %v", err)
	}
	if got.Decision != store.DecisionExpired {
		t.Fatalf("decision after the task failed = %q, want %q", got.Decision, store.DecisionExpired)
	}
	if got.DecidedVia == nil || *got.DecidedVia != "interrupt" {
		t.Fatalf("decided_via after the task failed = %v, want %q", got.DecidedVia, "interrupt")
	}
	wantNoPendingDecisions(t, e, st, taskID)
}

func TestFinishSucceededResolvesPendingQuestion(t *testing.T) {
	ctx := context.Background()
	e, st, taskID, execID := startedTask(t)
	q := requestPendingQuestion(t, e, taskID)

	if _, err := e.finishRun(ctx, taskID, execID, StatusSucceeded, nil, nil); err != nil {
		t.Fatalf("finish succeeded: %v", err)
	}

	got, err := st.GetUserQuestion(ctx, q.ID)
	if err != nil {
		t.Fatalf("get user question: %v", err)
	}
	if got.Status != store.UQStatusAnswered {
		t.Fatalf("status after the task succeeded = %q, want %q", got.Status, store.UQStatusAnswered)
	}
	if got.AnsweredVia == nil || *got.AnsweredVia != "interrupt" {
		t.Fatalf("answered_via after the task succeeded = %v, want %q", got.AnsweredVia, "interrupt")
	}
	wantNoPendingDecisions(t, e, st, taskID)
}

// The orchestrated turn end is a different terminal writer. It must not be able
// to skip the settle that the adapter run loop performs.
func TestFinishOrchestratedResolvesPending(t *testing.T) {
	ctx := context.Background()
	e, st, taskID, execID := startedTask(t)
	a := requestPendingApproval(t, e, taskID)
	q := requestPendingQuestion(t, e, taskID)

	e.finishOrchestrated(ctx, taskID, execID, false)

	final, err := e.Get(ctx, taskID)
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if final.Status != StatusSucceeded {
		t.Fatalf("orchestrated task status = %s, want %s", final.Status, StatusSucceeded)
	}
	gotApproval, err := st.GetApproval(ctx, a.ID)
	if err != nil {
		t.Fatalf("get approval: %v", err)
	}
	if gotApproval.Decision != store.DecisionExpired {
		t.Fatalf("decision after the orchestrated turn = %q, want %q", gotApproval.Decision, store.DecisionExpired)
	}
	gotQuestion, err := st.GetUserQuestion(ctx, q.ID)
	if err != nil {
		t.Fatalf("get user question: %v", err)
	}
	if gotQuestion.Status != store.UQStatusAnswered {
		t.Fatalf("question status after the orchestrated turn = %q, want %q",
			gotQuestion.Status, store.UQStatusAnswered)
	}
	wantNoPendingDecisions(t, e, st, taskID)
}

// A person who decided just before the task ended keeps their answer. The settle
// is the task-end sibling of expiry, not a second write over whatever is there.
func TestFinishKeepsAHumanDecision(t *testing.T) {
	ctx := context.Background()
	e, st, taskID, execID := startedTask(t)
	human := requestPendingApproval(t, e, taskID)
	if _, err := e.Decide(ctx, human.ID, store.DecisionApproved, "web"); err != nil {
		t.Fatalf("human decision: %v", err)
	}
	// The approval above resumed the task; a second one is still pending when the
	// turn ends, so both halves of "only pending rows are settled" are observed.
	stillPending := requestPendingApproval(t, e, taskID)

	if _, err := e.finishRun(ctx, taskID, execID, StatusFailed, nil, nil); err != nil {
		t.Fatalf("finish failed: %v", err)
	}

	kept, err := st.GetApproval(ctx, human.ID)
	if err != nil {
		t.Fatalf("get human approval: %v", err)
	}
	if kept.Decision != store.DecisionApproved {
		t.Fatalf("the human decision after the task ended = %q, want %q", kept.Decision, store.DecisionApproved)
	}
	if kept.DecidedVia == nil || *kept.DecidedVia != "web" {
		t.Fatalf("the human decision's via = %v, want %q", kept.DecidedVia, "web")
	}
	settled, err := st.GetApproval(ctx, stillPending.ID)
	if err != nil {
		t.Fatalf("get still-pending approval: %v", err)
	}
	if settled.Decision != store.DecisionExpired {
		t.Fatalf("the still-pending approval after the task ended = %q, want %q",
			settled.Decision, store.DecisionExpired)
	}
	wantNoPendingDecisions(t, e, st, taskID)
}

// Control: the cancel path already settled what was waiting on it before this
// change. The same fixture through Cancel stays green on both trees and is what
// shows the two tests above are about the missing end states, not the fixture.
func TestCancelAlreadyResolvesPending(t *testing.T) {
	ctx := context.Background()
	e, st, taskID, _ := startedTask(t)
	a := requestPendingApproval(t, e, taskID)
	q := requestPendingQuestion(t, e, taskID)

	if _, err := e.Cancel(ctx, taskID); err != nil {
		t.Fatalf("cancel: %v", err)
	}

	gotApproval, err := st.GetApproval(ctx, a.ID)
	if err != nil {
		t.Fatalf("get approval: %v", err)
	}
	if gotApproval.Decision == store.DecisionPending {
		t.Fatal("the approval is still pending after the task was canceled")
	}
	gotQuestion, err := st.GetUserQuestion(ctx, q.ID)
	if err != nil {
		t.Fatalf("get user question: %v", err)
	}
	if gotQuestion.Status == store.UQStatusPending {
		t.Fatal("the user question is still pending after the task was canceled")
	}
	wantNoPendingDecisions(t, e, st, taskID)
}
