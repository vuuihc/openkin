package store

import (
	"context"
	"path/filepath"
	"testing"
)

// A routine's wall-clock rule, stored beside its interval.
//
// The column is additive and empty by default, so a routine created before it
// existed keeps running on its interval — the behaviour it was created with —
// rather than acquiring a recurrence nobody asked for.

func openRoutineStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func insertRoutine(t *testing.T, s *Store, id, recurrence string) Routine {
	t.Helper()
	r := Routine{
		ID: id, Cwd: "/work/app", Agent: "claude-code", Prompt: "go",
		IntervalSecs: 3600, Enabled: true, CreatedAt: 1, NextDueAt: 1,
		Title: "Nightly", Recurrence: recurrence,
	}
	if err := s.InsertRoutine(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestRoutineKeepsItsRecurrence(t *testing.T) {
	s := openRoutineStore(t)
	rule := `{"kind":"weekdays","hour":9,"minute":0,"time_zone":"Asia/Shanghai"}`
	insertRoutine(t, s, "routine-1", rule)

	got, err := s.GetRoutine(context.Background(), "routine-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Recurrence != rule {
		t.Fatalf("recurrence = %q, want the stored rule", got.Recurrence)
	}
	// The interval is still there: a recurrence routine keeps a fallback pace
	// for its missed-run threshold.
	if got.IntervalSecs != 3600 {
		t.Fatalf("interval = %d, want 3600", got.IntervalSecs)
	}
}

func TestRoutineWithoutARecurrenceReadsAsIntervalOnly(t *testing.T) {
	s := openRoutineStore(t)
	insertRoutine(t, s, "routine-2", "")

	got, err := s.GetRoutine(context.Background(), "routine-2")
	if err != nil {
		t.Fatal(err)
	}
	if got.Recurrence != "" {
		t.Fatalf("recurrence = %q, want empty", got.Recurrence)
	}
	listed, err := s.ListRoutines(context.Background(), ListRoutinesOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].Recurrence != "" {
		t.Fatalf("listed = %+v, want the routine with no recurrence", listed)
	}
}

func TestUpdateRoutineSetsAndClearsTheRecurrence(t *testing.T) {
	s := openRoutineStore(t)
	insertRoutine(t, s, "routine-3", "")
	ctx := context.Background()

	rule := `{"kind":"daily","hour":18,"minute":30}`
	next := int64(99)
	if err := s.UpdateRoutine(ctx, "routine-3", RoutinePatch{Recurrence: &rule, NextDueAt: &next}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetRoutine(ctx, "routine-3")
	if err != nil {
		t.Fatal(err)
	}
	if got.Recurrence != rule || got.NextDueAt != next {
		t.Fatalf("after set = %q / %d", got.Recurrence, got.NextDueAt)
	}

	// Switching back to interval-only has to be expressible: the empty string
	// is a value, not "leave it alone".
	empty := ""
	if err := s.UpdateRoutine(ctx, "routine-3", RoutinePatch{Recurrence: &empty}); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetRoutine(ctx, "routine-3")
	if err != nil {
		t.Fatal(err)
	}
	if got.Recurrence != "" {
		t.Fatalf("after clear = %q, want empty", got.Recurrence)
	}
}

// A database written before the column existed must still open, keep its
// routines, and read their recurrence as "interval only".
func TestRoutinesFromBeforeTheRecurrenceColumnAreRepairedOnOpen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertRoutine(t, s, "routine-old", "")
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE routines DROP COLUMN recurrence`); err != nil {
		t.Fatalf("simulate a pre-recurrence database: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen a database whose routines have no recurrence: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	got, err := reopened.GetRoutine(ctx, "routine-old")
	if err != nil {
		t.Fatalf("the repaired routine cannot be read: %v", err)
	}
	if got.Recurrence != "" {
		t.Fatalf("recurrence after the repair = %q, want empty", got.Recurrence)
	}
	if got.Title != "Nightly" || got.IntervalSecs != 3600 {
		t.Fatalf("routine after the repair = %+v, want its other fields intact", got)
	}
}
