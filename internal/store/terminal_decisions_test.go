package store

import (
	"context"
	"encoding/json"
	"testing"
)

// A task that ends must not leave a decision pending: the status and the rows
// that were waiting on it commit in one transaction, so a reader that can see
// the task has ended can never read its approval or question as still open.
//
// This drives FinishTaskReportingPending rather than FinishTask because its
// signature is unchanged; both terminal writers share finishTaskTx, so the same
// settle is the one the adapter run loop and the orchestrated turn end get.
func TestFinishTaskReportingPendingSettlesPendingDecisions(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-ended")

	const approvalID = "appr-ended"
	if err := s.InsertApproval(ctx, Approval{
		ID:        approvalID,
		TaskID:    "task-ended",
		Kind:      "tool_use",
		Payload:   json.RawMessage(`{"tool_name":"Write"}`),
		Decision:  DecisionPending,
		CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	const questionID = "question-ended"
	if err := s.InsertUserQuestion(ctx, UserQuestion{
		ID:        questionID,
		TaskID:    "task-ended",
		Payload:   json.RawMessage(`{"question":"Which auth?"}`),
		Status:    UQStatusPending,
		CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}

	settledAt := NowMilli()
	if _, err := s.FinishTaskReportingPending(ctx, "task-ended", "failed", settledAt, nil, nil,
		"the turn ended"); err != nil {
		t.Fatalf("finish task: %v", err)
	}

	task, err := s.GetTask(ctx, "task-ended")
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != "failed" {
		t.Fatalf("task status = %s, want failed", task.Status)
	}
	if pending, err := s.ListPendingForTask(ctx, "task-ended"); err != nil {
		t.Fatal(err)
	} else if len(pending) != 0 {
		t.Fatalf("pending approvals after the task ended = %+v, want none", pending)
	}
	if pending, err := s.ListPendingUserQuestionsForTask(ctx, "task-ended"); err != nil {
		t.Fatal(err)
	} else if len(pending) != 0 {
		t.Fatalf("pending user questions after the task ended = %+v, want none", pending)
	}

	approval, err := s.GetApproval(ctx, approvalID)
	if err != nil {
		t.Fatal(err)
	}
	if approval.Decision != DecisionExpired {
		t.Fatalf("approval decision = %q, want %q", approval.Decision, DecisionExpired)
	}
	if approval.DecidedVia == nil || *approval.DecidedVia != "interrupt" {
		t.Fatalf("approval decided_via = %v, want %q", approval.DecidedVia, "interrupt")
	}
	if approval.DecidedAt == nil || *approval.DecidedAt != settledAt {
		t.Fatalf("approval decided_at = %v, want %d", approval.DecidedAt, settledAt)
	}

	question, err := s.GetUserQuestion(ctx, questionID)
	if err != nil {
		t.Fatal(err)
	}
	if question.Status != UQStatusAnswered {
		t.Fatalf("question status = %q, want %q", question.Status, UQStatusAnswered)
	}
	if question.AnsweredVia == nil || *question.AnsweredVia != "interrupt" {
		t.Fatalf("question answered_via = %v, want %q", question.AnsweredVia, "interrupt")
	}
	if string(question.Response) != `{"selected":[]}` {
		t.Fatalf("question response = %s, want the empty selection an interrupt writes", question.Response)
	}

	approvals, err := s.ListApprovals(ctx, ListApprovalsOpts{
		Status: DecisionPending,
		Scope:  Unscoped(),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range approvals {
		if a.TaskID == "task-ended" {
			t.Fatalf("ListApprovals(pending) still returns %s for the ended task", a.ID)
		}
	}
	questions, err := s.ListUserQuestions(ctx, ListUserQuestionsOpts{
		Status: UQStatusPending,
		Scope:  Unscoped(),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range questions {
		if q.TaskID == "task-ended" {
			t.Fatalf("ListUserQuestions(pending) still returns %s for the ended task", q.ID)
		}
	}
}
