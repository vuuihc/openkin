package store

import (
	"context"
	"testing"
	"time"
)

func TestRoutineCRUDAndDue(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	now := time.Now().UnixMilli()

	r := Routine{
		ID:             "r1",
		Cwd:            "/tmp/proj",
		Agent:          "kin",
		PermissionMode: "default",
		Prompt:         "check PRs",
		IntervalSecs:   3600,
		Enabled:        true,
		NextDueAt:      now - 1000,
		CreatedAt:      now,
		Title:          "Morning PRs",
	}
	if err := s.InsertRoutine(ctx, r); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetRoutine(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Morning PRs" || !got.Enabled || got.IntervalSecs != 3600 {
		t.Fatalf("got %+v", got)
	}

	due, err := s.ListDueRoutines(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 || due[0].ID != "r1" {
		t.Fatalf("due=%+v", due)
	}

	off := false
	if err := s.UpdateRoutine(ctx, "r1", RoutinePatch{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	due, err = s.ListDueRoutines(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 0 {
		t.Fatalf("disabled still due: %+v", due)
	}

	list, err := s.ListRoutines(ctx, ListRoutinesOpts{})
	if err != nil || len(list) != 1 {
		t.Fatalf("list=%v err=%v", list, err)
	}

	if err := s.DeleteRoutine(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetRoutine(ctx, "r1"); err != ErrNotFound {
		t.Fatalf("want not found, got %v", err)
	}
}

func TestTaskRoutineFieldsAndUnread(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	now := time.Now().UnixMilli()

	if err := s.InsertRoutine(ctx, Routine{
		ID: "r1", Cwd: "/tmp", Agent: "kin", Prompt: "p",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	task := Task{
		ID: "t1", Title: "run", Agent: "kin", Cwd: "/tmp", Prompt: "p",
		Status: "succeeded", CreatedAt: now, RoutineID: "r1",
		RoutineUnread: true, RoutineNoteworthy: true, RoutineTLDR: "PR landed",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	// Interactive task without routine should still insert.
	if err := s.InsertTask(ctx, Task{
		ID: "t2", Title: "chat", Agent: "kin", Cwd: "/tmp", Prompt: "hi",
		Status: "queued", CreatedAt: now + 1,
	}); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetTask(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}
	if got.RoutineID != "r1" || !got.RoutineUnread || !got.RoutineNoteworthy || got.RoutineTLDR != "PR landed" {
		t.Fatalf("got %+v", got)
	}

	n, err := s.CountUnreadRoutineRuns(ctx)
	if err != nil || n != 1 {
		t.Fatalf("unread=%d err=%v", n, err)
	}

	runs, err := s.ListTasks(ctx, ListTasksOpts{RoutineID: "*", Limit: 10})
	if err != nil || len(runs) != 1 || runs[0].ID != "t1" {
		t.Fatalf("runs=%+v err=%v", runs, err)
	}

	if err := s.MarkRoutineRunRead(ctx, "t1"); err != nil {
		t.Fatal(err)
	}
	n, _ = s.CountUnreadRoutineRuns(ctx)
	if n != 0 {
		t.Fatalf("unread after mark=%d", n)
	}
}
