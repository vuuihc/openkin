package store

import (
	"context"
	"path/filepath"
	"testing"
)

// The version stamp alone does not describe the table. Version 39 was stamped once
// before `user_seq` existed on it, so a database can be current and still lack the
// column -- and then every queue read fails with "no such column", including the
// read the delivery path makes to answer a message the user can see.
func TestAQueueTableFromBeforeTheAnchorColumnIsRepairedOnOpen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertQueueTask(t, s, "task-old")
	// The shape commit d590e87 shipped at version 39, with a row queued by it.
	if _, err := s.db.ExecContext(ctx, `
		DROP TABLE task_pending_prompts;
		CREATE TABLE task_pending_prompts (
		  id              INTEGER PRIMARY KEY AUTOINCREMENT,
		  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
		  prompt          TEXT NOT NULL,
		  agent           TEXT NOT NULL DEFAULT '',
		  model           TEXT,
		  permission_mode TEXT,
		  queued_at       INTEGER NOT NULL
		);
		CREATE INDEX idx_task_pending_prompts_queue ON task_pending_prompts(task_id, id);
		PRAGMA user_version = 39;
		INSERT INTO task_pending_prompts (task_id, prompt, queued_at)
		VALUES ('task-old', 'queued by the older build', 1);`); err != nil {
		t.Fatalf("recreate the shape 39 first shipped: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen a version-39 database whose queue has no anchor column: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	var columns int
	if err := reopened.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pragma_table_info('task_pending_prompts') WHERE name = 'user_seq'`,
	).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 1 {
		t.Fatal("user_seq was not added to the queue table")
	}
	// The row that was queued before the column existed is still deliverable, with
	// no anchor -- the delivery path writes the user event in that case.
	got, err := reopened.ListPendingPrompts(ctx, "task-old")
	if err != nil {
		t.Fatalf("the repaired queue cannot be read: %v", err)
	}
	if len(got) != 1 || got[0].Prompt != "queued by the older build" || got[0].UserSeq != 0 {
		t.Fatalf("queue after the repair = %+v, want the older row kept with no anchor", got)
	}
	// And a new row carries its anchor.
	appended, err := reopened.AppendPendingPrompt(ctx, PendingPrompt{
		TaskID: "task-old", Prompt: "queued after the repair", UserSeq: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	if appended.UserSeq != 42 {
		t.Fatalf("appended row has user_seq %d, want 42", appended.UserSeq)
	}
}
