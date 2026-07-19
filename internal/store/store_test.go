package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestOpenAndMigrate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "kin.db")

	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatalf("user_version: %v", err)
	}
	if v != schemaVersion {
		t.Fatalf("user_version = %d, want %d", v, schemaVersion)
	}

	// Tables exist.
	for _, table := range []string{"tasks", "events", "approvals", "settings", "kin_messages", "usage_records"} {
		var name string
		err := s.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table,
		).Scan(&name)
		if err != nil {
			t.Fatalf("table %s missing: %v", table, err)
		}
	}

	// Re-open is idempotent.
	s.Close()
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	defer s2.Close()

	tasks, err := s2.ListTasks(context.Background(), ListTasksOpts{})
	if err != nil {
		t.Fatalf("ListTasks: %v", err)
	}
	if tasks == nil {
		t.Fatal("ListTasks returned nil; want empty slice")
	}
	if len(tasks) != 0 {
		t.Fatalf("ListTasks len = %d, want 0", len(tasks))
	}
}

func TestTaskAndEventCRUD(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	now := NowMilli()
	task := Task{
		ID: "01TESTTASK0000000000000001", Title: "hi", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "hello", Status: "queued", CreatedAt: now,
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "queued" || got.Title != "hi" {
		t.Fatalf("got %+v", got)
	}

	status := "running"
	started := now + 1
	if err := s.UpdateTask(ctx, task.ID, TaskPatch{Status: &status, StartedAt: &started}); err != nil {
		t.Fatal(err)
	}

	e1, err := s.AppendEvent(ctx, task.ID, "message", []byte(`{"text":"a"}`))
	if err != nil {
		t.Fatal(err)
	}
	if e1.Seq != 1 {
		t.Fatalf("seq=%d", e1.Seq)
	}
	e2, err := s.AppendEvent(ctx, task.ID, "result", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if e2.Seq != 2 {
		t.Fatalf("seq=%d", e2.Seq)
	}

	evs, err := s.ListEvents(ctx, task.ID, 0)
	if err != nil || len(evs) != 2 {
		t.Fatalf("events: %v len=%d", err, len(evs))
	}
	evs, err = s.ListEvents(ctx, task.ID, 1)
	if err != nil || len(evs) != 1 || evs[0].Seq != 2 {
		t.Fatalf("since_seq: %v %v", err, evs)
	}

	ids, err := s.FailOrphaned(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != task.ID {
		t.Fatalf("orphans: %v", ids)
	}
	got, _ = s.GetTask(ctx, task.ID)
	if got.Status != "failed" {
		t.Fatalf("status=%s", got.Status)
	}
}

func TestUpdateTaskModel(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	model := "claude-opus-4-8"
	task := Task{
		ID: "t-model", Title: "m", Agent: "claude-code", Cwd: "/tmp",
		Prompt: "p", Model: &model, Status: "queued", CreatedAt: 1,
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	next := "claude-haiku-4-5"
	if err := s.UpdateTask(ctx, task.ID, TaskPatch{Model: &next}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Model == nil || *got.Model != next {
		t.Fatalf("model=%v want %s", got.Model, next)
	}
	if err := s.UpdateTask(ctx, task.ID, TaskPatch{ClearModel: true}); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != nil {
		t.Fatalf("model should be cleared, got %v", got.Model)
	}
}
