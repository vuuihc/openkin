package store

import (
	"context"
	"encoding/json"
	"testing"
)

// The terminal status and the sentence naming the messages it stranded are one
// committed transition, not two writes that a reader can land between. This is
// the store-level half of that contract: the row and the report are readable
// together, and the queue is left for the user rather than consumed.
func TestFinishTaskReportingPendingCommitsStatusAndReportTogether(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-report")
	for _, text := range []string{"first", "second"} {
		if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-report", Prompt: text}); err != nil {
			t.Fatal(err)
		}
	}
	before, err := s.GetTask(ctx, "task-report")
	if err != nil {
		t.Fatal(err)
	}

	report, err := s.FinishTaskReportingPending(ctx, "task-report", "failed", NowMilli(), nil, nil,
		"workspace finalization failed")
	if err != nil {
		t.Fatal(err)
	}
	if !report.Written() || report.Count != 2 {
		t.Fatalf("report = %+v, want two named messages", report)
	}
	if report.Event.Type != "error" || report.Event.Seq != 1 {
		t.Fatalf("report event = %+v, want the task's first event, of type error", report.Event)
	}
	var payload map[string]string
	if err := json.Unmarshal(report.Event.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	want := "2 queued prompt(s) not delivered: workspace finalization failed"
	if payload["message"] != want {
		t.Fatalf("report says %q, want %q", payload["message"], want)
	}

	task, err := s.GetTask(ctx, "task-report")
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != "failed" || task.FinishedAt == nil {
		t.Fatalf("task after finish = %+v, want a finished failed row", task)
	}
	if task.HubSeq == nil || before.HubSeq == nil || *task.HubSeq <= *before.HubSeq {
		t.Fatalf("hub_seq did not advance with the report: before=%v after=%v", before.HubSeq, task.HubSeq)
	}
	events, err := s.ListEvents(ctx, "task-report", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Seq != report.Event.Seq {
		t.Fatalf("the report is not in the transcript: %+v", events)
	}
	// Stranded, not discarded: the messages stay for the user to resend.
	left, err := s.ListPendingPrompts(ctx, "task-report")
	if err != nil || len(left) != 2 {
		t.Fatalf("queue after the report = %+v (err %v), want both messages kept", left, err)
	}
	// The watermark is the highest row the report named, so the caller's tail
	// settle can tell a message accepted afterwards from one already reported --
	// even if one of these is withdrawn in between.
	if report.AfterID != left[len(left)-1].ID {
		t.Fatalf("report watermark = %d, want the last counted queue row %d", report.AfterID, left[len(left)-1].ID)
	}
}

// Nothing queued means nothing to report: the finish commits alone, with no
// stray error event saying a message was lost when none was.
func TestFinishTaskReportingPendingWithAnEmptyQueueWritesNoReport(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-quiet")

	report, err := s.FinishTaskReportingPending(ctx, "task-quiet", "canceled", NowMilli(), nil, nil,
		"the task was canceled")
	if err != nil {
		t.Fatal(err)
	}
	if report.Written() {
		t.Fatalf("an empty queue produced a report: %+v", report)
	}
	task, err := s.GetTask(ctx, "task-quiet")
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != "canceled" {
		t.Fatalf("status = %q, want canceled", task.Status)
	}
	events, err := s.ListEvents(ctx, "task-quiet", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("an empty queue produced events: %+v", events)
	}
}

// Both or neither. When the report cannot be written, the status must not
// commit: a `failed` row with nothing explaining the message it stranded is the
// exact state this transaction exists to prevent.
func TestFinishTaskReportingPendingKeepsTheStatusWhenTheReportCannotBeWritten(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-rollback")
	if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-rollback", Prompt: "still mine"}); err != nil {
		t.Fatal(err)
	}
	failErrorEventWrites(t, s)

	report, err := s.FinishTaskReportingPending(ctx, "task-rollback", "failed", NowMilli(), nil, nil,
		"workspace finalization failed")
	if err == nil {
		t.Fatalf("the finish succeeded (%+v) while its report could not be written", report)
	}
	if report.Written() {
		t.Fatalf("a failed write returned a report: %+v", report)
	}
	task, err := s.GetTask(ctx, "task-rollback")
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != "running" || task.FinishedAt != nil {
		t.Fatalf("the status committed without its report: %+v", task)
	}
	events, err := s.ListEvents(ctx, "task-rollback", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("an event survived the rolled-back finish: %+v", events)
	}
	left, err := s.ListPendingPrompts(ctx, "task-rollback")
	if err != nil || len(left) != 1 {
		t.Fatalf("queue after the rolled-back finish = %+v (err %v), want the message kept", left, err)
	}
}
