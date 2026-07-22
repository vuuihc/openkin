package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func openApprovalExecStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestApprovalExecutionRoundTrip(t *testing.T) {
	s := openApprovalExecStore(t)
	ctx := context.Background()
	now := time.Now().UnixMilli()
	task := Task{
		ID: "01EXECTASK000000000000001", Title: "exec", Agent: "kin",
		Cwd: "/tmp", Prompt: "p", Status: "running", CreatedAt: now,
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	execID := "01EXECRUN000000000000001"
	agent := "claude-code"
	step := 2
	model := "claude-sonnet"
	if err := s.InsertApproval(ctx, Approval{
		ID: "01EXECAPPROVAL0000000001", TaskID: task.ID, Kind: "tool_use",
		Payload: json.RawMessage(`{"tool_name":"Bash"}`), Decision: DecisionPending, CreatedAt: now,
		ExecutionID: &execID, ExecutionAgent: &agent, ExecutionStep: &step, ExecutionModel: &model,
	}); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetApproval(ctx, "01EXECAPPROVAL0000000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.ExecutionID == nil || *got.ExecutionID != execID {
		t.Fatalf("execution_id=%v", got.ExecutionID)
	}
	if got.ExecutionAgent == nil || *got.ExecutionAgent != agent {
		t.Fatalf("execution_agent=%v", got.ExecutionAgent)
	}
	if got.ExecutionStep == nil || *got.ExecutionStep != step {
		t.Fatalf("execution_step=%v", got.ExecutionStep)
	}
	if got.ExecutionModel == nil || *got.ExecutionModel != model {
		t.Fatalf("execution_model=%v", got.ExecutionModel)
	}

	list, err := s.ListApprovals(ctx, ListApprovalsOpts{Status: DecisionPending})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("list len=%d", len(list))
	}
	if list[0].ExecutionID == nil || *list[0].ExecutionID != execID {
		t.Fatalf("list execution_id=%v", list[0].ExecutionID)
	}
	if list[0].TaskAgent != "kin" {
		t.Fatalf("task_agent=%q", list[0].TaskAgent)
	}
}

func TestApprovalHistoricalNullExecution(t *testing.T) {
	s := openApprovalExecStore(t)
	ctx := context.Background()
	now := time.Now().UnixMilli()
	task := Task{
		ID: "01HISTTASK000000000000001", Title: "hist", Agent: "codex",
		Cwd: "/tmp", Prompt: "p", Status: "running", CreatedAt: now,
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertApproval(ctx, Approval{
		ID: "01HISTAPPROVAL0000000001", TaskID: task.ID, Kind: "tool_use",
		Payload: json.RawMessage(`{}`), Decision: DecisionPending, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetApproval(ctx, "01HISTAPPROVAL0000000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.ExecutionID != nil || got.ExecutionAgent != nil || got.ExecutionStep != nil || got.ExecutionModel != nil {
		t.Fatalf("expected null execution fields, got %+v", got)
	}
}

func TestMigration009ApprovalExecutionPopulated(t *testing.T) {
	// Build a v8 database with an existing approval row, then open via migrate path.
	dir := t.TempDir()
	path := filepath.Join(dir, "kin.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	// Minimal v8-shaped schema with approvals lacking execution columns.
	schema := `
PRAGMA user_version = 8;
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  agent TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  session_ref TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'queued',
  exit_code INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  workspace_mode TEXT,
  workspace_source_root TEXT,
  workspace_root TEXT,
  execution_cwd TEXT,
  workspace_scope TEXT,
  workspace_base_oid TEXT,
  workspace_branch TEXT,
  project_id TEXT
);
CREATE TABLE approvals (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  decision    TEXT NOT NULL DEFAULT 'pending',
  decided_via TEXT,
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);
INSERT INTO tasks (id, title, agent, cwd, prompt, status, created_at)
VALUES ('01MIGTASK0000000000000001', 'm', 'kin', '/tmp', 'p', 'running', 1);
INSERT INTO approvals (id, task_id, kind, payload, decision, created_at)
VALUES ('01MIGAPPROVAL00000000001', '01MIGTASK0000000000000001', 'tool_use', '{}', 'pending', 1);
`
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	var v int
	if err := s.DB().QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	if v != schemaVersion {
		t.Fatalf("user_version=%d want %d", v, schemaVersion)
	}

	// Historical row must remain readable with null execution fields.
	got, err := s.GetApproval(context.Background(), "01MIGAPPROVAL00000000001")
	if err != nil {
		t.Fatalf("get historical approval after migration: %v", err)
	}
	if got.ExecutionID != nil || got.ExecutionAgent != nil {
		t.Fatalf("migration must not invent execution identity: %+v", got)
	}

	// New inserts use the additive columns.
	execID := "01NEWEXEC000000000000001"
	agent := "codex"
	if err := s.InsertApproval(context.Background(), Approval{
		ID: "01NEWAPPROVAL00000000001", TaskID: "01MIGTASK0000000000000001",
		Kind: "tool_use", Payload: json.RawMessage(`{}`), Decision: DecisionPending, CreatedAt: 2,
		ExecutionID: &execID, ExecutionAgent: &agent,
	}); err != nil {
		t.Fatal(err)
	}
	got2, err := s.GetApproval(context.Background(), "01NEWAPPROVAL00000000001")
	if err != nil {
		t.Fatal(err)
	}
	if got2.ExecutionID == nil || *got2.ExecutionID != execID {
		t.Fatalf("new execution_id=%v", got2.ExecutionID)
	}
}
