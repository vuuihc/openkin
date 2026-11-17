package store

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRoutineSummaryReadOmitsTextOnlyInProjection(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	r := Routine{ID: "r-summary", Cwd: "/work/alpha", Agent: "kin", Prompt: "persistent original", LastError: "previous failure detail", IntervalSecs: 60, NextDueAt: 12345, Enabled: true, Title: "Sweep", ConversationMode: ConversationFresh, Model: "model-test"}
	if err := s.InsertRoutine(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListRoutinesPage(context.Background(), ListRoutinesOpts{Summary: true})
	if err != nil || len(page.Routines) != 1 {
		t.Fatalf("summary: %+v, %v", page, err)
	}
	got := page.Routines[0]
	if got.Prompt != "" || got.LastError != r.LastError {
		t.Fatalf("summary carried the prompt or hid a failure: %+v", got)
	}
	if got.Cwd != r.Cwd || got.NextDueAt != r.NextDueAt || !got.Enabled || got.ConversationMode != r.ConversationMode || got.Model != r.Model {
		t.Fatalf("summary lost scheduling state: %+v", got)
	}
	full, err := s.GetRoutine(context.Background(), r.ID)
	if err != nil || full.Prompt != r.Prompt || full.LastError != r.LastError {
		t.Fatalf("detail changed durable text: %+v, %v", full, err)
	}
	plain, err := s.ListRoutines(context.Background(), ListRoutinesOpts{})
	if err != nil || len(plain) != 1 || plain[0].Prompt != r.Prompt {
		t.Fatalf("legacy read was projected: %+v, %v", plain, err)
	}
}

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

	runs, err := s.ListTasks(ctx, ListTasksOpts{Scope: Unscoped(), RoutineID: "*", Limit: 10})
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

func TestCountRoutineInFlightDeduplicatesEvalRunAndCases(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	now := NowMilli()

	if err := s.InsertRoutine(ctx, Routine{
		ID: "eval-routine", Cwd: "/tmp", Agent: "kin", Prompt: "eval",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now,
		Lane: "eval",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertEvalRun(ctx, EvalRun{
		ID: "eval-run", Suite: "smoke", SuiteVersion: "v1",
		RoutineID: "eval-routine", NReps: 1, Status: "running", StartedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"eval-case-1", "eval-case-2"} {
		if err := s.InsertTask(ctx, Task{
			ID: id, Title: "eval/" + id, Agent: "kin", Cwd: "/tmp", Prompt: "p",
			Status: "queued", CreatedAt: now, RoutineID: "eval-routine",
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.AppendEvent(ctx, id, "eval_metadata", []byte(`{"run_id":"eval-run"}`)); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := s.CountRoutineInFlight(ctx); err != nil || got != 1 {
		t.Fatalf("in-flight=%d err=%v, want one logical eval routine", got, err)
	}
	if err := s.FinishEvalRun(ctx, "eval-run", "succeeded", "", now+1); err != nil {
		t.Fatal(err)
	}
	status := "succeeded"
	for _, id := range []string{"eval-case-1", "eval-case-2"} {
		if err := s.UpdateTask(ctx, id, TaskPatch{Status: &status}); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"ordinary-1", "ordinary-2"} {
		if err := s.InsertTask(ctx, Task{
			ID: id, Title: "ordinary", Agent: "kin", Cwd: "/tmp", Prompt: "p",
			Status: "queued", CreatedAt: now, RoutineID: "eval-routine",
		}); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := s.CountRoutineInFlight(ctx); err != nil || got != 2 {
		t.Fatalf("in-flight=%d err=%v, want two ordinary routine tasks", got, err)
	}
	for _, id := range []string{"ordinary-1", "ordinary-2"} {
		if err := s.UpdateTask(ctx, id, TaskPatch{Status: &status}); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := s.CountRoutineInFlight(ctx); err != nil || got != 0 {
		t.Fatalf("in-flight=%d err=%v, want no active routine work", got, err)
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

func TestListRoutinesPageFiltersByDirectory(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	now := time.Now().UnixMilli()
	// Longer than any defensive cap on a query parameter: the filter must
	// compare the directory exactly as stored, not a truncated prefix.
	longCwd := "/work/" + strings.Repeat("nested/", 40) + "leaf"
	rows := []Routine{
		{ID: "alpha-old", Cwd: "/work/alpha", Enabled: true, CreatedAt: now},
		{ID: "alpha-new", Cwd: "/work/alpha", Enabled: false, CreatedAt: now + 1},
		{ID: "beta", Cwd: "/work/beta", Enabled: true, CreatedAt: now + 2},
		{ID: "long", Cwd: longCwd, Enabled: true, CreatedAt: now + 3},
	}
	for _, r := range rows {
		r.Agent, r.Prompt, r.IntervalSecs, r.NextDueAt = "kin", "sweep", 60, now
		if err := s.InsertRoutine(ctx, r); err != nil {
			t.Fatal(err)
		}
	}

	page, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{Cwd: "/work/alpha"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Routines) != 2 {
		t.Fatalf("alpha page = %+v", page.Routines)
	}
	for _, r := range page.Routines {
		if r.Cwd != "/work/alpha" {
			t.Fatalf("directory filter leaked %q", r.Cwd)
		}
	}

	// The directory filter composes with the enabled filter instead of
	// replacing it: a paused row in the same directory is still excluded.
	enabled := true
	page, err = s.ListRoutinesPage(ctx, ListRoutinesOpts{Cwd: "/work/alpha", Enabled: &enabled})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Routines) != 1 || page.Routines[0].ID != "alpha-old" {
		t.Fatalf("alpha enabled page = %+v", page.Routines)
	}

	// A cursor stays inside the filter: the second page is the older alpha
	// row, never the newer beta one that sorts between them globally.
	first, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{Cwd: "/work/alpha", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Routines) != 1 || first.Routines[0].ID != "alpha-new" || !first.HasMore {
		t.Fatalf("first filtered page = %+v", first)
	}
	second, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{
		Cwd: "/work/alpha", Limit: 1, Before: first.NextCursor,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Routines) != 1 || second.Routines[0].ID != "alpha-old" || second.HasMore {
		t.Fatalf("second filtered page = %+v", second)
	}

	// A directory no routine uses is an empty answer, not an error.
	empty, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{Cwd: "/work/missing"})
	if err != nil {
		t.Fatalf("unknown cwd errored: %v", err)
	}
	if len(empty.Routines) != 0 {
		t.Fatalf("unknown cwd page = %+v", empty.Routines)
	}

	// A path longer than any defensive query cap is still an exact filter: a
	// truncated comparison would answer empty for a directory that exists.
	long, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{Cwd: longCwd})
	if err != nil {
		t.Fatal(err)
	}
	if len(long.Routines) != 1 || long.Routines[0].ID != "long" {
		t.Fatalf("long cwd page = %+v", long.Routines)
	}
}

func TestListRoutinesPageFiltersFailedOnly(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	now := time.Now().UnixMilli()
	rows := []Routine{
		{ID: "failed", Cwd: "/work/a", Enabled: true, CreatedAt: now, LastOutcome: "failed"},
		{ID: "succeeded", Cwd: "/work/a", Enabled: true, CreatedAt: now + 1, LastOutcome: "succeeded"},
		// Never ran: no outcome at all, so it is not a recent failure.
		{ID: "never", Cwd: "/work/a", Enabled: true, CreatedAt: now + 2},
	}
	for _, r := range rows {
		r.Agent, r.Prompt, r.IntervalSecs, r.NextDueAt = "kin", "sweep", 60, now
		if err := s.InsertRoutine(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{FailedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Routines) != 1 || page.Routines[0].ID != "failed" {
		t.Fatalf("failed-only page = %+v", page.Routines)
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
