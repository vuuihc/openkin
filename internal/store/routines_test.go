package store

import (
	"context"
	"fmt"
	"path/filepath"
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

func TestRoutineCursorSearchScalesBeyondLegacyCap(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	now := time.Now().UnixMilli()
	for i := 0; i < 10000; i++ {
		if err := s.InsertRoutine(ctx, Routine{
			ID:  "routine-" + fmt.Sprintf("%05d", i),
			Cwd: "/tmp/project", Agent: "kin", Prompt: "audit repository",
			IntervalSecs: 3600, Enabled: true, NextDueAt: now + int64(i),
			CreatedAt: now + int64(i), Title: "Audit " + fmt.Sprintf("%05d", i),
		}); err != nil {
			t.Fatal(err)
		}
	}
	var cursor string
	count := 0
	for page := 0; page < 200; page++ {
		result, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{
			Limit: 137, Before: cursor, Query: "audit",
		})
		if err != nil {
			t.Fatal(err)
		}
		count += len(result.Routines)
		if !result.HasMore {
			break
		}
		cursor = result.NextCursor
		if cursor == "" {
			t.Fatal("page reported more without cursor")
		}
	}
	if count != 10000 {
		t.Fatalf("count=%d want 10000", count)
	}
}

func TestListRoutinesPageCursorSurvivesDeletedRow(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	now := time.Now().UnixMilli()
	for i := 0; i < 3; i++ {
		if err := s.InsertRoutine(ctx, Routine{
			ID:  "cursor-routine-" + fmt.Sprintf("%d", i),
			Cwd: "/tmp", Agent: "kin", Prompt: "cursor",
			IntervalSecs: 60, Enabled: true, NextDueAt: now,
			CreatedAt: now + int64(i), Title: "Cursor",
		}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if !first.HasMore || len(first.Routines) != 2 {
		t.Fatalf("first page = %+v", first)
	}
	if err := s.DeleteRoutine(ctx, first.Routines[1].ID); err != nil {
		t.Fatal(err)
	}
	next, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{Limit: 2, Before: first.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Routines) != 1 || next.Routines[0].ID == first.Routines[0].ID {
		t.Fatalf("next page after deletion = %+v", next)
	}
}
