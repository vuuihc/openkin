package store

import (
	"context"
	"path/filepath"
	"testing"
)

// A routine's conversation mode, stored beside its schedule.
//
// The column is additive and empty on every row that predates it. Empty is not
// a third mode: those routines ran one fresh session per run, and the console's
// signed default for new routines is "continue", so empty has to read as the
// same default rather than as an unknown spelling that skips the carry.

func TestRoutineKeepsItsConversationMode(t *testing.T) {
	s := openRoutineStore(t)
	ctx := context.Background()
	insertRoutine(t, s, "routine-mode", "")

	got, err := s.GetRoutine(ctx, "routine-mode")
	if err != nil {
		t.Fatal(err)
	}
	if got.ConversationMode != ConversationContinue {
		t.Fatalf("mode after insert = %q, want %q", got.ConversationMode, ConversationContinue)
	}

	fresh := ConversationFresh
	if err := s.UpdateRoutine(ctx, "routine-mode", RoutinePatch{ConversationMode: &fresh}); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetRoutine(ctx, "routine-mode")
	if err != nil {
		t.Fatal(err)
	}
	if got.ConversationMode != ConversationFresh {
		t.Fatalf("mode after patch = %q, want %q", got.ConversationMode, ConversationFresh)
	}

	// The list carries it too: the editor opens from the list row, and a mode
	// missing there would silently show "continue" for a routine that starts
	// over every run.
	page, err := s.ListRoutinesPage(ctx, ListRoutinesOpts{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Routines) != 1 || page.Routines[0].ConversationMode != ConversationFresh {
		t.Fatalf("listed = %+v, want the stored mode", page.Routines)
	}

	back := ConversationContinue
	if err := s.UpdateRoutine(ctx, "routine-mode", RoutinePatch{ConversationMode: &back}); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetRoutine(ctx, "routine-mode")
	if err != nil {
		t.Fatal(err)
	}
	if got.ConversationMode != ConversationContinue {
		t.Fatalf("mode after clearing = %q, want %q", got.ConversationMode, ConversationContinue)
	}
}

// Create writes the mode in the same INSERT as the rest of the routine. The
// HTTP handler answers with the struct it built, so only a read-back proves
// the column was actually filled.
func TestRoutineStoresFreshModeOnInsert(t *testing.T) {
	s := openRoutineStore(t)
	ctx := context.Background()
	if err := s.InsertRoutine(ctx, Routine{
		ID: "routine-fresh", Cwd: "/work/app", Agent: "claude-code",
		Prompt: "go", IntervalSecs: 3600, Enabled: true, CreatedAt: 1, NextDueAt: 1,
		Title: "Fresh", ConversationMode: ConversationFresh,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetRoutine(ctx, "routine-fresh")
	if err != nil {
		t.Fatal(err)
	}
	if got.ConversationMode != ConversationFresh {
		t.Fatalf("mode after insert = %q, want %q", got.ConversationMode, ConversationFresh)
	}
}

func TestConversationModeNormalization(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want string
	}{
		{"", ConversationContinue},
		{"continue", ConversationContinue},
		{"  CONTINUE  ", ConversationContinue},
		{"fresh", ConversationFresh},
		{" FRESH ", ConversationFresh},
		{"whatever-a-future-build-writes", ConversationContinue},
	} {
		if got := NormalizeConversationMode(tc.in); got != tc.want {
			t.Fatalf("NormalizeConversationMode(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if RoutineStartsFreshConversation("") {
		t.Fatal("an empty mode must not start a fresh session")
	}
	if !RoutineStartsFreshConversation(ConversationFresh) {
		t.Fatal("fresh must start a fresh session")
	}
}

// A database written before the column existed must still open, keep its
// routines, and read them as the continue default.
func TestRoutinesFromBeforeTheConversationColumnReadAsContinue(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertRoutine(t, s, "routine-old", "")
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE routines DROP COLUMN conversation_mode`); err != nil {
		t.Fatalf("simulate a pre-conversation database: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen a database whose routines have no conversation mode: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	got, err := reopened.GetRoutine(ctx, "routine-old")
	if err != nil {
		t.Fatalf("the repaired routine cannot be read: %v", err)
	}
	if got.ConversationMode != ConversationContinue {
		t.Fatalf("mode after the repair = %q, want %q", got.ConversationMode, ConversationContinue)
	}
	if got.Agent != "claude-code" || got.Title != "Nightly" || got.IntervalSecs != 3600 {
		t.Fatalf("routine after the repair = %+v, want its other fields intact", got)
	}
}

// The ordered upgrade path: a populated version-47 database gains the column
// from migration 048 and records the new version, so the next open does not
// migrate it again.
func TestRoutinesGainTheirConversationColumnOnTheVersion48Upgrade(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertRoutine(t, s, "routine-upgrade", "")
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE routines DROP COLUMN conversation_mode`); err != nil {
		t.Fatalf("simulate a version-47 database: %v", err)
	}
	if _, err := s.db.ExecContext(ctx, `PRAGMA user_version = 47`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("upgrade a version-47 database: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	got, err := reopened.GetRoutine(ctx, "routine-upgrade")
	if err != nil {
		t.Fatalf("the upgraded routine cannot be read: %v", err)
	}
	if got.ConversationMode != ConversationContinue {
		t.Fatalf("mode after the upgrade = %q, want %q", got.ConversationMode, ConversationContinue)
	}
	var version int
	if err := reopened.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != schemaVersion {
		t.Fatalf("user_version = %d, want %d after the upgrade", version, schemaVersion)
	}
}
