package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func TestCheckpointCRUD(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	task := Task{
		ID: "01CHKPOINT00000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	cp1 := TaskCheckpoint{
		TaskID: task.ID, EventSeq: 1, HeadOID: "aaa", TreeOID: "t1",
		SizeBytes: 10, CreatedAt: NowMilli(),
	}
	cp2 := TaskCheckpoint{
		TaskID: task.ID, EventSeq: 5, HeadOID: "bbb", TreeOID: "t2",
		SizeBytes: 20, CreatedAt: NowMilli(),
	}
	if err := s.PutCheckpoint(ctx, cp1); err != nil {
		t.Fatal(err)
	}
	if err := s.PutCheckpoint(ctx, cp2); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetCheckpoint(ctx, task.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got.TreeOID != "t1" || got.HeadOID != "aaa" {
		t.Fatalf("%+v", got)
	}

	// UPSERT
	cp1.TreeOID = "t1b"
	if err := s.PutCheckpoint(ctx, cp1); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetCheckpoint(ctx, task.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got.TreeOID != "t1b" {
		t.Fatalf("%+v", got)
	}

	at, err := s.GetCheckpointAtOrBefore(ctx, task.ID, 4)
	if err != nil {
		t.Fatal(err)
	}
	if at.EventSeq != 1 {
		t.Fatalf("seq=%d", at.EventSeq)
	}
	at, err = s.GetCheckpointAtOrBefore(ctx, task.ID, 5)
	if err != nil {
		t.Fatal(err)
	}
	if at.EventSeq != 5 {
		t.Fatalf("seq=%d", at.EventSeq)
	}

	init, err := s.GetInitialCheckpoint(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if init.EventSeq != 1 {
		t.Fatalf("init=%d", init.EventSeq)
	}

	list, err := s.ListCheckpoints(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if list == nil || len(list) != 2 {
		t.Fatalf("list=%v", list)
	}
	if list[0].EventSeq != 1 || list[1].EventSeq != 5 {
		t.Fatalf("order=%v", list)
	}

	if err := s.DeleteCheckpointsFrom(ctx, task.ID, 5); err != nil {
		t.Fatal(err)
	}
	list, err = s.ListCheckpoints(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].EventSeq != 1 {
		t.Fatalf("after delete=%v", list)
	}

	_, err = s.GetCheckpoint(ctx, task.ID, 99)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err=%v", err)
	}
}

func TestMigrateV5ToWorkspace(t *testing.T) {
	// Build a v5-equivalent DB (usage_records present, no workspace columns), then reopen.
	dir := t.TempDir()
	path := filepath.Join(dir, "kin.db")

	// Open at current schema then downgrade simulation: create with raw SQL at v5.
	// Use Open which lands at v6, then we can't easily. Instead: open empty, run only up to v5 manually.
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// Insert a task at current schema, verify workspace defaults.
	ctx := context.Background()
	task := Task{
		ID: "01MIGRATEWS000000000000001", Title: "m", Agent: "claude-code",
		Cwd: "/proj", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceMode != "shared" {
		t.Fatalf("mode=%q", got.WorkspaceMode)
	}
	if got.WorkspaceScope != "." {
		t.Fatalf("scope=%q", got.WorkspaceScope)
	}
	if got.EffectiveCwd() != "/proj" {
		t.Fatalf("effective=%q", got.EffectiveCwd())
	}
	got.ExecutionCwd = "/proj/wt/sub"
	if got.EffectiveCwd() != "/proj/wt/sub" {
		t.Fatalf("effective with exec=%q", got.EffectiveCwd())
	}

	// task_checkpoints table exists
	var name string
	err = s.DB().QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_checkpoints'`).Scan(&name)
	if err != nil || name != "task_checkpoints" {
		t.Fatalf("task_checkpoints missing: %v", err)
	}

	var v int
	if err := s.DB().QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	if v != schemaVersion {
		t.Fatalf("version=%d want %d", v, schemaVersion)
	}
	s.Close()

	// Reopen idempotent
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	got, err = s2.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Cwd != "/proj" {
		t.Fatalf("%+v", got)
	}
}

func TestMigrateFromV5Populated(t *testing.T) {
	// Simulate a DB that stopped at user_version=5 (usage_records era) without workspace columns.
	dir := t.TempDir()
	path := filepath.Join(dir, "old.db")

	// Create minimal v5-shaped schema without going through current migration001.
	db, err := openSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  agent TEXT NOT NULL,
  cwd TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  session_ref TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  permission_mode TEXT NOT NULL DEFAULT 'default'
);
CREATE TABLE events (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
CREATE TABLE usage_records (
  task_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  agent TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  cost_source TEXT NOT NULL,
  cache_status TEXT NOT NULL,
  input_semantics TEXT NOT NULL,
  PRIMARY KEY (task_id, event_seq)
);
INSERT INTO tasks (id, title, agent, cwd, prompt, status, created_at)
VALUES ('01OLDV5TASK000000000000001', 'old', 'claude-code', '/old', 'hi', 'succeeded', 1);
INSERT INTO events (task_id, seq, ts, type, payload) VALUES ('01OLDV5TASK000000000000001', 1, 1, 'message', '{}');
PRAGMA user_version = 5;
`)
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	var v int
	if err := s.DB().QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	if v != 6 {
		t.Fatalf("version=%d", v)
	}
	got, err := s.GetTask(ctx, "01OLDV5TASK000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceMode != "shared" || got.ExecutionCwd != "" {
		t.Fatalf("%+v", got)
	}
	if got.EffectiveCwd() != "/old" {
		t.Fatalf("effective=%q", got.EffectiveCwd())
	}
	evs, err := s.ListEvents(ctx, got.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 1 {
		t.Fatalf("events=%d", len(evs))
	}
}

func openSQLite(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;`); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}
