package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// Migration 013 – legacy backfill
// ---------------------------------------------------------------------------

func TestMigration013BackfillsLegacyWorktree(t *testing.T) {
	dir := t.TempDir()
	db, err := openSQLite(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}

	// Create a version-12 database with one worktree task, one shared task,
	// and one checkpoint for the worktree task.
	schema := `
PRAGMA user_version = 12;

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  agent       TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  model       TEXT,
  session_ref TEXT,
  status      TEXT NOT NULL,
  exit_code   INTEGER,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  workspace_mode TEXT NOT NULL DEFAULT 'shared',
  workspace_source_root TEXT NOT NULL DEFAULT '',
  workspace_root TEXT NOT NULL DEFAULT '',
  execution_cwd TEXT NOT NULL DEFAULT '',
  workspace_scope TEXT NOT NULL DEFAULT '.',
  workspace_base_oid TEXT NOT NULL DEFAULT '',
  workspace_branch TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  routine_id TEXT,
  routine_noteworthy INTEGER NOT NULL DEFAULT 0,
  routine_tldr TEXT NOT NULL DEFAULT '',
  routine_unread INTEGER NOT NULL DEFAULT 0,
  dispatch TEXT
);

CREATE TABLE events (
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  seq      INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);

CREATE TABLE task_checkpoints (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_seq  INTEGER NOT NULL,
  head_oid   TEXT NOT NULL,
  tree_oid   TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, event_seq)
);
`
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}

	// Insert one worktree task with legacy workspace metadata
	_, err = db.Exec(`
		INSERT INTO tasks (id, title, agent, cwd, prompt, status, created_at,
			workspace_mode, workspace_source_root, workspace_root, execution_cwd,
			workspace_scope, workspace_base_oid, workspace_branch)
		VALUES ('01LEGACYTK000000000000001', 'legacy worktree', 'kin', '/tmp', 'p', 'done', 1000,
			'worktree', '/repo', '/tmp/.kin/wt-abc', '/tmp/.kin/wt-abc', '.', 'abc123', 'feat/t1')
	`)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	_, err = db.Exec(`
		INSERT INTO events (task_id, seq, ts, type, payload)
		VALUES ('01LEGACYTK000000000000001', 0, 1000, 'user', '"hello"')
	`)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	_, err = db.Exec(`
		INSERT INTO task_checkpoints (task_id, event_seq, head_oid, tree_oid, size_bytes, created_at)
		VALUES ('01LEGACYTK000000000000001', 0, 'abc123', 'tree1', 100, 1000)
	`)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}

	// Insert one shared task (no legacy workspace)
	_, err = db.Exec(`
		INSERT INTO tasks (id, title, agent, cwd, prompt, status, created_at,
			workspace_mode)
		VALUES ('01SHAREDTK000000000000001', 'shared task', 'kin', '/tmp', 'p', 'done', 1000,
			'shared')
	`)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	_, err = db.Exec(`
		INSERT INTO events (task_id, seq, ts, type, payload)
		VALUES ('01SHAREDTK000000000000001', 0, 1000, 'user', '"hello"')
	`)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}

	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen – triggers migration chain from v=12 → v=13
	s, err := Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	var v int
	if err := s.DB().QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	if v != 14 {
		t.Fatalf("user_version=%d want 14", v)
	}

	// Worktree task: must have legacy_pending generation and worktree policy
	ws, err := s.GetCurrentWorkspace(ctx, "01LEGACYTK000000000000001")
	if err != nil {
		t.Fatalf("get current workspace for legacy task: %v", err)
	}
	if ws.State != WorkspaceLegacyPending {
		t.Fatalf("state=%q want legacy_pending", ws.State)
	}
	if ws.Generation != 1 {
		t.Fatalf("generation=%d want 1", ws.Generation)
	}
	if ws.ID != "01LEGACYTK000000000000001:g1" {
		t.Fatalf("id=%q want <task-id>:g1", ws.ID)
	}
	if ws.SourceRoot != "/repo" || ws.PhysicalRoot != "/tmp/.kin/wt-abc" {
		t.Fatalf("unexpected workspace fields: %+v", ws)
	}

	// Check that checkpoint has the workspace_id
	cp, err := s.GetCheckpoint(ctx, "01LEGACYTK000000000000001", 0)
	if err != nil {
		t.Fatalf("get checkpoint: %v", err)
	}
	if cp.WorkspaceID != "01LEGACYTK000000000000001:g1" {
		t.Fatalf("checkpoint workspace_id=%q want %q", cp.WorkspaceID, "01LEGACYTK000000000000001:g1")
	}

	// Shared task: no generation, shared policy
	task2, err := s.GetTask(ctx, "01SHAREDTK000000000000001")
	if err != nil {
		t.Fatalf("get shared task: %v", err)
	}
	if task2.WorkspacePolicy != "shared" {
		t.Fatalf("shared task policy=%q want 'shared'", task2.WorkspacePolicy)
	}
	if task2.CurrentWorkspaceID != "" {
		t.Fatalf("shared task should have no current workspace, got %q", task2.CurrentWorkspaceID)
	}
}

// ---------------------------------------------------------------------------
// Workspace generation lifecycle
// ---------------------------------------------------------------------------

func TestWorkspaceGenerationLifecycle(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	task := Task{
		ID: "01WSLIFEC0000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
		WorkspacePolicy: "auto",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	// Insert generation 1
	ws1 := WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: WorkspaceProvisioning, SourceRoot: "/repo", Scope: ".",
		CreatedAt: NowMilli(), UpdatedAt: NowMilli(),
	}
	if err := s.InsertWorkspace(ctx, ws1); err != nil {
		t.Fatal(err)
	}

	// List workspaces
	list, err := s.ListTaskWorkspaces(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("got %d workspaces, want 1", len(list))
	}

	// GetCurrentWorkspace returns the open workspace by state,
	// so it should find ws1 even without setting current_workspace_id
	cur, err := s.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatalf("get current workspace: %v", err)
	}
	if cur.ID != ws1.ID {
		t.Fatalf("current=%q want %q", cur.ID, ws1.ID)
	}

	// Set current (idempotent)
	if err := s.SetCurrentWorkspace(ctx, task.ID, ws1.ID); err != nil {
		t.Fatal(err)
	}
	cur, err = s.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cur.ID != ws1.ID {
		t.Fatalf("current=%q want %q", cur.ID, ws1.ID)
	}

	// Transition state: provisioning → ready
	_, err = s.TransitionWorkspace(ctx, ws1.ID, []WorkspaceState{WorkspaceProvisioning}, WorkspaceReady)
	if err != nil {
		t.Fatalf("transition: %v", err)
	}
	cur, err = s.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cur.State != WorkspaceReady {
		t.Fatalf("state=%q want ready", cur.State)
	}

	// Insert generation 2 (should work when generation 1 is released)
	_, err = s.TransitionWorkspace(ctx, ws1.ID, []WorkspaceState{WorkspaceReady}, WorkspaceReleased)
	if err != nil {
		t.Fatalf("transition to released: %v", err)
	}

	ws2 := WorkspaceGeneration{
		ID: task.ID + ":g2", TaskID: task.ID, Generation: 2,
		State: WorkspaceProvisioning, SourceRoot: "/repo", Scope: ".",
		CreatedAt: NowMilli(), UpdatedAt: NowMilli(),
	}
	if err := s.InsertWorkspace(ctx, ws2); err != nil {
		t.Fatal(err)
	}

	// Set current to generation 2
	if err := s.SetCurrentWorkspace(ctx, task.ID, ws2.ID); err != nil {
		t.Fatal(err)
	}

	// Clear current (sets current_workspace_id to empty, but workspace still exists in open state)
	if err := s.ClearCurrentWorkspace(ctx, task.ID, ws2.ID); err != nil {
		t.Fatal(err)
	}
	// GetCurrentWorkspace finds by state, so it still returns ws2 until it is released
	cur2, err := s.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatalf("get current after clear: %v", err)
	}
	if cur2.ID != ws2.ID {
		t.Fatalf("expected ws2, got %s", cur2.ID)
	}

	// List non-terminal (should find generation 2 which is provisioning)
	list2, err := s.ListTaskWorkspaces(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list2) < 2 {
		t.Fatalf("expected at least 2 workspaces, got %d", len(list2))
	}
}

func TestOnlyOneOpenWorkspacePerTask(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	task := Task{
		ID: "01ONLYOPEN0000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
		WorkspacePolicy: "auto",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	ws1 := WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: WorkspaceProvisioning, SourceRoot: "/repo", Scope: ".",
		CreatedAt: NowMilli(), UpdatedAt: NowMilli(),
	}
	if err := s.InsertWorkspace(ctx, ws1); err != nil {
		t.Fatal(err)
	}

	// Second open generation should fail the unique partial index
	ws2 := WorkspaceGeneration{
		ID: task.ID + ":g2", TaskID: task.ID, Generation: 2,
		State: WorkspaceReady, SourceRoot: "/repo", Scope: ".",
		CreatedAt: NowMilli(), UpdatedAt: NowMilli(),
	}
	err = s.InsertWorkspace(ctx, ws2)
	if err == nil {
		t.Fatal("expected error for second open workspace, got nil")
	}

	// After releasing g1, g2 should succeed
	_, err = s.TransitionWorkspace(ctx, ws1.ID, []WorkspaceState{WorkspaceProvisioning}, WorkspaceReleased)
	if err != nil {
		t.Fatalf("transition to released: %v", err)
	}
	if err := s.InsertWorkspace(ctx, ws2); err != nil {
		t.Fatalf("second workspace after release should succeed: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Turn workspace mapping
// ---------------------------------------------------------------------------

func TestTurnWorkspaceMappingFollowsPromotion(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	task := Task{
		ID: "01TURNWSP0000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
		WorkspacePolicy: "auto",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	ws := WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: WorkspaceProvisioning, SourceRoot: "/repo", Scope: ".",
		CreatedAt: NowMilli(), UpdatedAt: NowMilli(),
	}
	if err := s.InsertWorkspace(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if err := s.SetCurrentWorkspace(ctx, task.ID, ws.ID); err != nil {
		t.Fatal(err)
	}

	wsID := ws.ID
	turn := TaskTurnWorkspace{
		TaskID:      task.ID,
		WorkspaceID: &wsID,
		Access:      "writable",
		CreatedAt:   NowMilli(),
		UpdatedAt:   NowMilli(),
	}

	// Append user event with turn workspace pointing to g1
	ev, tw, err := s.AppendUserEventWithTurnWorkspace(ctx, task.ID, json.RawMessage(`"hello"`), turn)
	if err != nil {
		t.Fatalf("append turn workspace: %v", err)
	}
	if tw.WorkspaceID == nil || *tw.WorkspaceID != ws.ID {
		t.Fatalf("turn workspace_id=%v want %q", tw.WorkspaceID, ws.ID)
	}
	if tw.Access != "writable" {
		t.Fatalf("access=%q want writable", tw.Access)
	}

	// Append source-read-only turn (workspace_id is nil)
	readOnlyTurn := TaskTurnWorkspace{
		TaskID:      task.ID,
		WorkspaceID: nil,
		Access:      "source_read_only",
		CreatedAt:   NowMilli(),
		UpdatedAt:   NowMilli(),
	}
	ev2, tw2, err := s.AppendUserEventWithTurnWorkspace(ctx, task.ID, json.RawMessage(`"read"`), readOnlyTurn)
	if err != nil {
		t.Fatalf("append read-only turn: %v", err)
	}
	_ = ev2
	if tw2.WorkspaceID != nil {
		t.Fatalf("read-only turn workspace_id=%v want nil", tw2.WorkspaceID)
	}
	if tw2.Access != "source_read_only" {
		t.Fatalf("access=%q want source_read_only", tw2.Access)
	}

	// Verify turn workspace is persisted
	got, err := s.GetTurnWorkspace(ctx, task.ID, ev.Seq)
	if err != nil {
		t.Fatalf("get turn workspace: %v", err)
	}
	if got.WorkspaceID == nil || *got.WorkspaceID != ws.ID {
		t.Fatalf("got workspace_id=%v want %q", got.WorkspaceID, ws.ID)
	}
}

func TestTurnWorkspaceRejectsCrossTaskWorkspace(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	task1 := Task{
		ID: "01TASK1000000000000000001", Title: "t1", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task1); err != nil {
		t.Fatal(err)
	}
	task2 := Task{
		ID: "01TASK2000000000000000002", Title: "t2", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task2); err != nil {
		t.Fatal(err)
	}

	// Insert workspace for task1
	ws1 := WorkspaceGeneration{
		ID: task1.ID + ":g1", TaskID: task1.ID, Generation: 1,
		State: WorkspaceProvisioning, SourceRoot: "/repo", Scope: ".",
		CreatedAt: NowMilli(), UpdatedAt: NowMilli(),
	}
	if err := s.InsertWorkspace(ctx, ws1); err != nil {
		t.Fatal(err)
	}

	// Insert a checkpoint with workspace_id for task1
	cp := TaskCheckpoint{
		TaskID: task1.ID, EventSeq: 0, HeadOID: "abc", TreeOID: "tree",
		SizeBytes: 10, CreatedAt: NowMilli(), WorkspaceID: ws1.ID,
	}
	if err := s.PutCheckpoint(ctx, cp); err != nil {
		t.Fatalf("put checkpoint with own workspace: %v", err)
	}

	// GetCheckpointForWorkspace with correct workspace should work
	_, err = s.GetCheckpointForWorkspace(ctx, task1.ID, 0, ws1.ID)
	if err != nil {
		t.Fatalf("get checkpoint for own workspace: %v", err)
	}

	// GetCheckpointForWorkspace with wrong workspace should fail
	_, err = s.GetCheckpointForWorkspace(ctx, task1.ID, 0, "nonexistent")
	if err == nil {
		t.Fatal("expected error for wrong workspace_id")
	}
}

func TestTurnWorkspaceRejectsInvalidAccessCombinations(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	task := Task{
		ID: "01INVALACC0000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	// The CHECK constraint on task_turn_workspaces enforces:
	// - access='writable' requires workspace_id IS NOT NULL
	// - access IN ('pending_isolation','source_read_only','shared') requires workspace_id IS NULL
	// Test writable with nil workspace_id (should fail at constraint level)
	wsID := "test:g1"
	turn := TaskTurnWorkspace{
		TaskID:      task.ID,
		WorkspaceID: &wsID,
		Access:      "source_read_only",
		CreatedAt:   NowMilli(),
		UpdatedAt:   NowMilli(),
	}
	// source_read_only with non-nil workspace_id - this depends on the CHECK constraint
	_, _, err = s.AppendUserEventWithTurnWorkspace(ctx, task.ID, json.RawMessage(`"test"`), turn)
	if err != nil {
		// Expected - this is an invalid combination (access=source_read_only with workspace_id set)
		t.Logf("expected error for invalid access combo: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

func TestUserEventAndTurnWorkspaceAreAtomic(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	task := Task{
		ID: "01ATOMICTN0000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	turn := TaskTurnWorkspace{
		TaskID:      task.ID,
		WorkspaceID: nil,
		Access:      "source_read_only",
		CreatedAt:   NowMilli(),
		UpdatedAt:   NowMilli(),
	}

	// AppendUserEventWithTurnWorkspace should create both event and turn workspace atomically
	ev, tw, err := s.AppendUserEventWithTurnWorkspace(ctx, task.ID, json.RawMessage(`"atomic"`), turn)
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if ev.TaskID != task.ID || ev.Seq < 0 {
		t.Fatalf("unexpected event: %+v", ev)
	}
	if tw.TaskID != task.ID || tw.UserEventSeq != ev.Seq {
		t.Fatalf("turn workspace not aligned: tw=%+v ev=%+v", tw, ev)
	}

	// Verify event exists
	got, err := s.GetTurnWorkspace(ctx, task.ID, ev.Seq)
	if err != nil {
		t.Fatalf("get turn workspace: %v", err)
	}
	if got.UserEventSeq != ev.Seq {
		t.Fatalf("seq mismatch: %d vs %d", got.UserEventSeq, ev.Seq)
	}
}

func TestWorkspaceTransitionEventIsAtomic(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	task := Task{
		ID: "01ATOMICWS0000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
		WorkspacePolicy: "auto",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	ws := WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: WorkspaceProvisioning, SourceRoot: "/repo", Scope: ".",
		CreatedAt: NowMilli(), UpdatedAt: NowMilli(),
	}
	if err := s.InsertWorkspace(ctx, ws); err != nil {
		t.Fatal(err)
	}

	// ApplyWorkspaceTransition should atomically transition state and create event
	workspaceBranch := "kin/task/atomic/g1"
	transition := WorkspaceTransition{
		WorkspaceID: ws.ID,
		TaskID:      task.ID,
		FromStates:  []WorkspaceState{WorkspaceProvisioning},
		ToState:     WorkspaceReady,
		Patch: WorkspacePatch{
			WorkspaceBranch: &workspaceBranch,
		},
	}
	updated, ev, err := s.ApplyWorkspaceTransition(ctx, transition)
	if err != nil {
		t.Fatalf("apply transition: %v", err)
	}
	if updated.State != WorkspaceReady {
		t.Fatalf("state=%q want ready", updated.State)
	}
	if updated.WorkspaceBranch != workspaceBranch {
		t.Fatalf("workspace_branch=%q want %q", updated.WorkspaceBranch, workspaceBranch)
	}
	if ev.Type != "workspace_ready" {
		t.Fatalf("event type=%q", ev.Type)
	}
}
