package store

import (
	"context"
	"path/filepath"
	"testing"
)

// A routine's model, stored beside its agent.
//
// Empty is the agent's own default — the state every routine was in before the
// column existed — so a row that predates it must read as "no model picked",
// not as a model with an empty name.

func TestRoutineKeepsItsModel(t *testing.T) {
	s := openRoutineStore(t)
	ctx := context.Background()
	insertRoutine(t, s, "routine-model", "")

	model := "claude-sonnet-5-5"
	if err := s.UpdateRoutine(ctx, "routine-model", RoutinePatch{Model: &model}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetRoutine(ctx, "routine-model")
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != model {
		t.Fatalf("model = %q, want %q", got.Model, model)
	}

	// The list carries it too: the editor opens from the list row, and a model
	// missing there would show every routine as "agent default".
	page, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Routines) != 1 || page.Routines[0].Model != model {
		t.Fatalf("listed = %+v, want the stored model", page.Routines)
	}

	// Clearing means the agent's default, not a model named "".
	empty := ""
	if err := s.UpdateRoutine(ctx, "routine-model", RoutinePatch{Model: &empty}); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetRoutine(ctx, "routine-model")
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != "" {
		t.Fatalf("model after clear = %q, want empty", got.Model)
	}
}

// Create writes the model in the same INSERT as the rest of the routine. The
// HTTP handler answers with the struct it built, so only a read-back proves
// the column was actually filled.
func TestRoutineKeepsItsModelOnInsert(t *testing.T) {
	s := openRoutineStore(t)
	ctx := context.Background()
	seeded := Routine{
		ID: "routine-insert", Cwd: "/work/app", Agent: "claude-code",
		Model: "claude-opus-5-5", Prompt: "go", IntervalSecs: 3600,
		Enabled: true, CreatedAt: 1, NextDueAt: 1, Title: "Seeded",
	}
	if err := s.InsertRoutine(ctx, seeded); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetRoutine(ctx, "routine-insert")
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != "claude-opus-5-5" {
		t.Fatalf("model after insert = %q, want the inserted id", got.Model)
	}
}

// A database written before the column existed must still open, keep its
// routines, and read them as "no model picked".
func TestRoutinesFromBeforeTheModelColumnAreRepairedOnOpen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertRoutine(t, s, "routine-old", "")
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE routines DROP COLUMN model`); err != nil {
		t.Fatalf("simulate a pre-model database: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen a database whose routines have no model: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	got, err := reopened.GetRoutine(ctx, "routine-old")
	if err != nil {
		t.Fatalf("the repaired routine cannot be read: %v", err)
	}
	if got.Model != "" {
		t.Fatalf("model after the repair = %q, want empty", got.Model)
	}
	if got.Agent != "claude-code" || got.Title != "Nightly" || got.IntervalSecs != 3600 {
		t.Fatalf("routine after the repair = %+v, want its other fields intact", got)
	}
}

// The other history: a database that says it is one version short gets the
// column from the ordered migration and records the new version, so the next
// open does not migrate it again. (The test above covers the reconciler — a
// table written without the column by a build that already claimed current.)
func TestRoutinesGainTheirModelColumnOnTheVersion42Upgrade(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertRoutine(t, s, "routine-upgrade", "")
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE routines DROP COLUMN model`); err != nil {
		t.Fatalf("simulate a version-42 database: %v", err)
	}
	if _, err := s.db.ExecContext(ctx, `PRAGMA user_version = 42`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("upgrade a version-42 database: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	got, err := reopened.GetRoutine(ctx, "routine-upgrade")
	if err != nil {
		t.Fatalf("the upgraded routine cannot be read: %v", err)
	}
	if got.Model != "" {
		t.Fatalf("model after the upgrade = %q, want the agent default", got.Model)
	}
	var version int
	if err := reopened.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != schemaVersion {
		t.Fatalf("user_version = %d, want %d after the upgrade", version, schemaVersion)
	}
}
