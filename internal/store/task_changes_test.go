package store

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
)

// The feed is what a client that has been away reads to catch up. It has to
// include every kind of change, in one order, and tell the client where it got
// to even when the page ended on a deletion.
func TestTaskChangeFeedCoversUpdatesAndDeletions(t *testing.T) {
	ctx := context.Background()
	s := openDeviceTestStore(t)
	for _, id := range []string{"task-a", "task-b", "task-c"} {
		insertCursorTestTask(t, s, id)
	}
	if _, err := s.AppendEvent(ctx, "task-a", "agent_message", json.RawMessage(`{"text":"hi"}`)); err != nil {
		t.Fatal(err)
	}
	title := "renamed"
	if err := s.UpdateTask(ctx, "task-b", TaskPatch{Title: &title}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteTask(ctx, "task-c"); err != nil {
		t.Fatal(err)
	}

	page, err := s.ListTaskChangesSince(ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(page.Tasks))
	for _, task := range page.Tasks {
		ids = append(ids, task.ID)
	}
	if fmt.Sprint(ids) != "[task-a task-b]" {
		t.Fatalf("changed tasks = %v, want the two that still exist in change order", ids)
	}
	if fmt.Sprint(page.Deleted) != "[task-c]" {
		t.Fatalf("deleted = %v, want [task-c]", page.Deleted)
	}
	if page.HasMore {
		t.Fatal("has_more on a complete page")
	}
	if page.NextCursor <= 0 {
		t.Fatalf("next_cursor = %d, want the last change", page.NextCursor)
	}

	// A client that already synced to the end sees nothing at all, and its
	// cursor stays where it was rather than moving to some invented value.
	idle, err := s.ListTaskChangesSince(ctx, page.NextCursor, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(idle.Tasks) != 0 || len(idle.Deleted) != 0 || idle.HasMore {
		t.Fatalf("idle feed = %+v, want empty", idle)
	}
	if idle.NextCursor != page.NextCursor {
		t.Fatalf("idle cursor = %d, want %d", idle.NextCursor, page.NextCursor)
	}
}

// Paging must not skip a change: the cursor only ever advances to a change the
// client was actually handed.
func TestTaskChangeFeedPagesWithoutSkipping(t *testing.T) {
	ctx := context.Background()
	s := openDeviceTestStore(t)
	for i := 0; i < 5; i++ {
		insertCursorTestTask(t, s, fmt.Sprintf("task-%d", i))
	}
	if err := s.DeleteTask(ctx, "task-2"); err != nil {
		t.Fatal(err)
	}

	var (
		seen    []string
		cursor  int64
		pages   int
		deleted []string
	)
	for {
		page, err := s.ListTaskChangesSince(ctx, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		if pages > 10 {
			t.Fatal("paging did not terminate")
		}
		for _, task := range page.Tasks {
			seen = append(seen, task.ID)
		}
		deleted = append(deleted, page.Deleted...)
		if page.NextCursor < cursor {
			t.Fatalf("cursor went backwards: %d -> %d", cursor, page.NextCursor)
		}
		cursor = page.NextCursor
		if !page.HasMore {
			break
		}
	}
	if fmt.Sprint(seen) != "[task-0 task-1 task-3 task-4]" {
		t.Fatalf("paged tasks = %v", seen)
	}
	if fmt.Sprint(deleted) != "[task-2]" {
		t.Fatalf("paged deletions = %v", deleted)
	}
	if pages != 3 {
		t.Fatalf("pages = %d, want 3 (five changes, two per page)", pages)
	}
}

// Deleting the newest task must not hand its number to the next writer: a
// client holding that cursor would never see whatever reused it.
func TestDeletingTheNewestTaskDoesNotRewindTheCursor(t *testing.T) {
	ctx := context.Background()
	s := openDeviceTestStore(t)
	insertCursorTestTask(t, s, "task-a")
	insertCursorTestTask(t, s, "task-b")

	newest := *taskHubSeq(t, s, "task-b")
	if err := s.DeleteTask(ctx, "task-b"); err != nil {
		t.Fatal(err)
	}
	insertCursorTestTask(t, s, "task-c")

	if got := taskHubSeq(t, s, "task-c"); got == nil || *got <= newest {
		t.Fatalf("new task cursor = %v, want > %d", got, newest)
	}
}

// A fresh install of an older database has tasks with no cursor. They must be
// numbered, or a client starting from zero would never hear about them.
func TestUpgradeNumbersTasksThatPredateTheCursor(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertCursorTestTask(t, s, "task-a")
	insertCursorTestTask(t, s, "task-b")
	if _, err := s.db.ExecContext(ctx, `DROP TABLE task_tombstones; UPDATE tasks SET hub_seq = NULL; PRAGMA user_version = 34`); err != nil {
		t.Fatalf("roll schema back to 34: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen at version 34: %v", err)
	}
	t.Cleanup(func() { _ = upgraded.Close() })

	page, err := upgraded.ListTaskChangesSince(ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Tasks) != 2 {
		t.Fatalf("tasks after upgrade = %d, want both", len(page.Tasks))
	}
	for _, task := range page.Tasks {
		if task.HubSeq == nil || *task.HubSeq == 0 {
			t.Fatalf("task %s still has no cursor", task.ID)
		}
	}
	// The backfill must not collide with what comes next.
	insertCursorTestTask(t, upgraded, "task-c")
	if got := taskHubSeq(t, upgraded, "task-c"); got == nil || *got <= page.NextCursor {
		t.Fatalf("new task cursor = %v, want > %d", got, page.NextCursor)
	}
}
