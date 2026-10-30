package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func newArchiveTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func insertArchiveTask(t *testing.T, s *Store, id, cwd string) {
	t.Helper()
	err := s.InsertTask(context.Background(), Task{
		ID: id, Title: id, Agent: "claude-code", Cwd: cwd,
		Prompt: "do the thing", Status: "succeeded",
		CreatedAt: time.Now().UnixMilli(),
	})
	if err != nil {
		t.Fatalf("insert %s: %v", id, err)
	}
}

func archiveIDs(t *testing.T, s *Store, filter ArchivedFilter) []string {
	t.Helper()
	tasks, err := s.ListTasks(context.Background(), ListTasksOpts{
		Limit: 50, Scope: Unscoped(), Archived: filter,
	})
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
	}
	return ids
}

// Archiving is per conversation. The row leaves the list; the two chats filed
// under the same project stay, which is the part the project-level archive got
// wrong: one swipe used to hide the whole project.
func TestArchivingOneConversationLeavesItsNeighbours(t *testing.T) {
	s := newArchiveTestStore(t)
	ctx := context.Background()
	insertArchiveTask(t, s, "01TASKA", "/tmp/project")
	insertArchiveTask(t, s, "01TASKB", "/tmp/project")
	insertArchiveTask(t, s, "01TASKC", "/tmp/other")

	at := time.Now().UnixMilli()
	if err := s.UpdateTask(ctx, "01TASKB", TaskPatch{ArchivedAt: &at}); err != nil {
		t.Fatalf("archive: %v", err)
	}

	if got := archiveIDs(t, s, ArchivedExclude); !sameIDs(got, []string{"01TASKA", "01TASKC"}) {
		t.Fatalf("live list = %v, want the two neighbours", got)
	}
	if got := archiveIDs(t, s, ArchivedOnly); !sameIDs(got, []string{"01TASKB"}) {
		t.Fatalf("archive view = %v, want only the archived row", got)
	}
	// The reconcilers are not showing a list; they must keep seeing everything,
	// or a workspace held by an archived task is never released.
	if got := archiveIDs(t, s, ArchivedAny); !sameIDs(got, []string{"01TASKA", "01TASKB", "01TASKC"}) {
		t.Fatalf("unfiltered list = %v, want all three", got)
	}

	task, err := s.GetTask(ctx, "01TASKB")
	if err != nil {
		t.Fatal(err)
	}
	if task.ArchivedAt != at {
		t.Fatalf("archived_at = %d, want %d", task.ArchivedAt, at)
	}
}

func TestUnarchivingPutsTheConversationBack(t *testing.T) {
	s := newArchiveTestStore(t)
	ctx := context.Background()
	insertArchiveTask(t, s, "01TASKA", "/tmp/project")

	at := time.Now().UnixMilli()
	if err := s.UpdateTask(ctx, "01TASKA", TaskPatch{ArchivedAt: &at}); err != nil {
		t.Fatalf("archive: %v", err)
	}
	live := int64(0)
	if err := s.UpdateTask(ctx, "01TASKA", TaskPatch{ArchivedAt: &live}); err != nil {
		t.Fatalf("unarchive: %v", err)
	}

	task, err := s.GetTask(ctx, "01TASKA")
	if err != nil {
		t.Fatal(err)
	}
	if task.ArchivedAt != 0 {
		t.Fatalf("archived_at = %d, want 0", task.ArchivedAt)
	}
	if got := archiveIDs(t, s, ArchivedExclude); !sameIDs(got, []string{"01TASKA"}) {
		t.Fatalf("live list = %v, want the restored row", got)
	}
	if got := archiveIDs(t, s, ArchivedOnly); len(got) != 0 {
		t.Fatalf("archive view = %v, want it empty", got)
	}
}

// A client that is already synced learns about the archive through the change
// cursor: without a new hub_seq the row would change behind a cursor that has
// already passed it, and the phone would keep showing it.
func TestArchivingAdvancesTheChangeCursor(t *testing.T) {
	s := newArchiveTestStore(t)
	ctx := context.Background()
	insertArchiveTask(t, s, "01TASKA", "/tmp/project")

	before, err := s.GetTask(ctx, "01TASKA")
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().UnixMilli()
	if err := s.UpdateTask(ctx, "01TASKA", TaskPatch{ArchivedAt: &at}); err != nil {
		t.Fatalf("archive: %v", err)
	}
	after, err := s.GetTask(ctx, "01TASKA")
	if err != nil {
		t.Fatal(err)
	}
	if before.HubSeq == nil || after.HubSeq == nil {
		t.Fatalf("hub_seq missing: before=%v after=%v", before.HubSeq, after.HubSeq)
	}
	if *after.HubSeq <= *before.HubSeq {
		t.Fatalf("hub_seq did not advance: %d -> %d", *before.HubSeq, *after.HubSeq)
	}
}

// A database that reached this version without the column — an older build
// that bumped the version, or a restore of a dump taken between the two — must
// not fail every list with "no such column".
// The version bump is the path an existing install takes. Migration 044 over a
// database that already has conversations: the column arrives empty, every row
// reads as still filed, and nothing it carried before is lost.
func TestUpgradeAddsTheArchiveColumnAndKeepsRows(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertArchiveTask(t, s, "01TASKA", "/tmp/project")
	// Put the database back to the shape migration 044 upgrades from.
	if _, err := s.db.ExecContext(ctx, `
		ALTER TABLE tasks DROP COLUMN archived_at;
		PRAGMA user_version = 43;`); err != nil {
		t.Fatalf("roll schema back to 43: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen at version 43: %v", err)
	}
	t.Cleanup(func() { _ = upgraded.Close() })

	if got := schemaVersionOf(t, upgraded); got != schemaVersion {
		t.Fatalf("user_version after upgrade = %d, want %d", got, schemaVersion)
	}
	if cols := tableColumns(t, upgraded, "tasks"); !cols["archived_at"] {
		t.Fatalf("upgraded database has no tasks.archived_at: %v", cols)
	}
	task, err := upgraded.GetTask(ctx, "01TASKA")
	if err != nil {
		t.Fatalf("the existing task did not survive the upgrade: %v", err)
	}
	if task.Title != "01TASKA" || task.ArchivedAt != 0 {
		t.Fatalf("row after the upgrade = %+v, want it unchanged and still filed", task)
	}
}

func TestATasksTableFromBeforeTheArchiveColumnIsRepairedOnOpen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertArchiveTask(t, s, "01TASKA", "/tmp/project")
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE tasks DROP COLUMN archived_at`); err != nil {
		t.Fatalf("simulate a pre-archive database: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen a database whose tasks have no archived_at: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	if got := archiveIDs(t, reopened, ArchivedExclude); !sameIDs(got, []string{"01TASKA"}) {
		t.Fatalf("live list after the repair = %v, want the task that predates the column", got)
	}
	task, err := reopened.GetTask(ctx, "01TASKA")
	if err != nil {
		t.Fatal(err)
	}
	if task.ArchivedAt != 0 {
		t.Fatalf("a row from before the column reads as archived: %d", task.ArchivedAt)
	}
}
