package store

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"
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
	for _, table := range []string{"tasks", "events", "approvals", "user_questions", "settings", "kin_messages", "usage_records"} {
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


func TestDeleteTaskCascadesChildrenAndDetachesArtifacts(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()

	now := NowMilli()
	task := Task{
		ID: "01DELTESTTASK0000000000001", Title: "delete me", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "bye", Status: "succeeded", CreatedAt: now,
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendEvent(ctx, task.ID, "message", []byte(`{"text":"a"}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertApproval(ctx, Approval{
		ID: "01DELAPPROVAL000000000001", TaskID: task.ID, Kind: "bash",
		Payload: json.RawMessage(`{"command":"ls"}`), Decision: "pending", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReplaceKinMessages(ctx, task.ID, []KinMessage{{
		Role: "user", Content: "hi",
	}}); err != nil {
		t.Fatal(err)
	}
	inTok, outTok := 1, 2
	cost := 0.01
	if err := s.InsertUsageRecord(ctx, UsageRecord{
		TaskID: task.ID, EventSeq: 1, OccurredAt: now, Agent: "claude-code",
		InputTokens: &inTok, OutputTokens: &outTok, CostUSD: &cost,
		CostSource: CostSourcePriceTable, CacheStatus: CacheStatusUnknown, InputSemantics: InputSemanticsUncachedOnly,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutCheckpoint(ctx, TaskCheckpoint{
		TaskID: task.ID, EventSeq: 1, HeadOID: "abc", TreeOID: "def", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	art := Artifact{
		ID: "01DELARTIFACT000000000001", Title: "note", Kind: "markdown",
		RelPath: "note.md", Size: 3, Status: ArtifactSaved, SourceTaskID: &task.ID,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.InsertArtifact(ctx, art); err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteTask(ctx, task.ID); err != nil {
		t.Fatalf("DeleteTask: %v", err)
	}
	if _, err := s.GetTask(ctx, task.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetTask after delete: %v", err)
	}
	evs, err := s.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 0 {
		t.Fatalf("events left: %d", len(evs))
	}
	gotArt, err := s.GetArtifact(ctx, art.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotArt.SourceTaskID != nil {
		t.Fatalf("artifact source should be nil, got %v", *gotArt.SourceTaskID)
	}
	if err := s.DeleteTask(ctx, task.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second DeleteTask: %v", err)
	}
}


func TestListTasksQuery(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	now := time.Now().UnixMilli()

	tasks := []Task{
		{ID: "01QUERYTEST0000000000001", Title: "Fix sidebar limit", Agent: "kin", Cwd: "/Users/me/kin", Prompt: "raise the task list cap", Status: "succeeded", CreatedAt: now},
		{ID: "01QUERYTEST0000000000002", Title: "Write docs", Agent: "codex", Cwd: "/Users/me/other", Prompt: "readme polish", Status: "succeeded", CreatedAt: now + 1},
		{ID: "01QUERYTEST0000000000003", Title: "Unrelated", Agent: "claude", Cwd: "/tmp/demo", Prompt: "hello world", Status: "queued", CreatedAt: now + 2},
	}
	for _, task := range tasks {
		if err := s.InsertTask(ctx, task); err != nil {
			t.Fatal(err)
		}
	}

	// Match title
	got, err := s.ListTasks(ctx, ListTasksOpts{Query: "sidebar", Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != tasks[0].ID {
		t.Fatalf("title match: %+v", got)
	}

	// Match cwd basename
	got, err = s.ListTasks(ctx, ListTasksOpts{Query: "/Users/me/kin", Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != tasks[0].ID {
		t.Fatalf("cwd match: %+v", got)
	}

	// Match agent
	got, err = s.ListTasks(ctx, ListTasksOpts{Query: "codex", Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != tasks[1].ID {
		t.Fatalf("agent match: %+v", got)
	}

	// Case-insensitive ASCII
	got, err = s.ListTasks(ctx, ListTasksOpts{Query: "SIDEBAR", Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("case-insensitive: %+v", got)
	}

	// LIKE metacharacters treated literally
	if err := s.InsertTask(ctx, Task{
		ID: "01QUERYTEST0000000000004", Title: "100% done", Agent: "kin", Cwd: "/x", Prompt: "a_b", Status: "queued", CreatedAt: now + 3,
	}); err != nil {
		t.Fatal(err)
	}
	got, err = s.ListTasks(ctx, ListTasksOpts{Query: "100%", Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "01QUERYTEST0000000000004" {
		t.Fatalf("literal percent: %+v", got)
	}

	// Empty query returns all (up to limit)
	got, err = s.ListTasks(ctx, ListTasksOpts{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("empty query len=%d want 4", len(got))
	}
}
