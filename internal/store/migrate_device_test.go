package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote"
)

func tableColumns(t *testing.T, s *Store, table string) map[string]bool {
	t.Helper()
	rows, err := s.db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		t.Fatalf("read columns of %s: %v", table, err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan column of %s: %v", table, err)
		}
		out[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate columns of %s: %v", table, err)
	}
	return out
}

func tableExists(t *testing.T, s *Store, table string) bool {
	t.Helper()
	var count int
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&count); err != nil {
		t.Fatalf("look up table %s: %v", table, err)
	}
	return count == 1
}

func schemaVersionOf(t *testing.T, s *Store) int {
	t.Helper()
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	return v
}

// A brand-new database must come out of migration001 at the current version,
// with the device registry already in place: fresh installs skip the numbered
// upgrade steps entirely.
func TestFreshInstallHasTheDeviceRegistry(t *testing.T) {
	s := openDeviceTestStore(t)

	if got := schemaVersionOf(t, s); got != schemaVersion {
		t.Fatalf("user_version = %d, want %d", got, schemaVersion)
	}
	for _, table := range []string{"devices", "device_agents", "workspace_anchors", "workspace_anchor_roots"} {
		if !tableExists(t, s, table) {
			t.Errorf("fresh install is missing table %s", table)
		}
	}
	columns := tableColumns(t, s, "tasks")
	for _, column := range []string{"owner_user_id", "origin_device_id", "executing_device_id", "workspace_anchor_id", "hub_seq"} {
		if !columns[column] {
			t.Errorf("fresh install is missing tasks.%s", column)
		}
	}
}

// The upgrade path is the one that can lose data, so it is tested by removing
// exactly what migration 034 adds and running the migration again over rows
// that were already there.
func TestUpgradeToDeviceRegistryKeepsExistingRows(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now().UnixMilli()
	if err := s.InsertDeviceCredential(ctx, DeviceCredential{
		ID: "ios-paired", TokenHash: remote.HashToken("paired"), Label: "phone", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO tasks (id, title, agent, cwd, prompt, status, created_at)
		VALUES ('task-1', 'before the upgrade', 'kin', '/tmp', 'hi', 'done', ?)`, now); err != nil {
		t.Fatal(err)
	}

	// Put the database back to version 33.
	if _, err := s.db.ExecContext(ctx, `
		DROP INDEX IF EXISTS idx_tasks_hub_seq;
		DROP INDEX IF EXISTS idx_tasks_owner_created;
		ALTER TABLE tasks DROP COLUMN owner_user_id;
		ALTER TABLE tasks DROP COLUMN origin_device_id;
		ALTER TABLE tasks DROP COLUMN executing_device_id;
		ALTER TABLE tasks DROP COLUMN workspace_anchor_id;
		ALTER TABLE tasks DROP COLUMN hub_seq;
		DROP TABLE workspace_anchor_roots;
		DROP TABLE workspace_anchors;
		DROP TABLE device_agents;
		DROP TABLE devices;
		PRAGMA user_version = 33;`); err != nil {
		t.Fatalf("roll schema back to 33: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen at version 33: %v", err)
	}
	t.Cleanup(func() { _ = upgraded.Close() })

	if got := schemaVersionOf(t, upgraded); got != schemaVersion {
		t.Fatalf("user_version after upgrade = %d, want %d", got, schemaVersion)
	}
	for _, table := range []string{"devices", "device_agents", "workspace_anchors", "workspace_anchor_roots"} {
		if !tableExists(t, upgraded, table) {
			t.Errorf("upgraded database is missing table %s", table)
		}
	}
	columns := tableColumns(t, upgraded, "tasks")
	for _, column := range []string{"owner_user_id", "origin_device_id", "executing_device_id", "workspace_anchor_id", "hub_seq"} {
		if !columns[column] {
			t.Errorf("upgraded database is missing tasks.%s", column)
		}
	}

	var title string
	if err := upgraded.db.QueryRowContext(ctx, `SELECT title FROM tasks WHERE id = 'task-1'`).Scan(&title); err != nil {
		t.Fatalf("existing task did not survive the upgrade: %v", err)
	}
	if title != "before the upgrade" {
		t.Fatalf("task title = %q", title)
	}

	// A device that was already paired is a device that is already registered.
	var label, role string
	if err := upgraded.db.QueryRowContext(ctx,
		`SELECT label, role FROM devices WHERE id = 'ios-paired'`).Scan(&label, &role); err != nil {
		t.Fatalf("paired device was not carried into the registry: %v", err)
	}
	if label != "phone" || role != "node" {
		t.Fatalf("registry row = %q/%q, want phone/node", label, role)
	}
}

// hub_seq is the global sync cursor. It is deliberately nullable so the upgrade
// does not have to invent numbers for rows that predate it.
func TestExistingTasksStartWithoutAHubCursor(t *testing.T) {
	s := openDeviceTestStore(t)
	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO tasks (id, title, agent, cwd, prompt, status, created_at)
		VALUES ('task-1', 'no cursor yet', 'kin', '/tmp', 'hi', 'done', ?)`, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	var hubSeq *int64
	if err := s.db.QueryRowContext(ctx, `SELECT hub_seq FROM tasks WHERE id = 'task-1'`).Scan(&hubSeq); err != nil {
		t.Fatalf("read hub_seq: %v", err)
	}
	if hubSeq != nil {
		t.Fatalf("hub_seq = %d, want NULL for a task that predates the cursor", *hubSeq)
	}
}

// A session's identity gained the machine it lives on, which means the unique
// key had to be rebuilt. Rows and their task links are the thing that can be
// lost here: SQLite cannot drop a constraint in place, and dropping the table
// fires the cascade from task_agent_sessions.
func TestUpgradeToDeviceScopedAgentSessionsKeepsRowsAndLinks(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO tasks (id, title, agent, cwd, prompt, status, created_at)
		VALUES ('task-1', 'before the upgrade', 'claude-code', '/code/openkin', 'hi', 'succeeded', ?)`, now); err != nil {
		t.Fatal(err)
	}

	// Put the database back to version 35: the tables as they were, with a row
	// in each and a link between them.
	if _, err := s.db.ExecContext(ctx, `
		DROP TABLE agent_sessions;
		CREATE TABLE agent_sessions (
		  id              TEXT PRIMARY KEY,
		  agent_id        TEXT NOT NULL,
		  external_ref    TEXT NOT NULL,
		  source_uri      TEXT NOT NULL DEFAULT '',
		  title           TEXT NOT NULL DEFAULT '',
		  cwd             TEXT NOT NULL DEFAULT '',
		  status          TEXT NOT NULL DEFAULT 'unknown',
		  capabilities    TEXT NOT NULL DEFAULT '[]',
		  metadata        TEXT NOT NULL DEFAULT '{}',
		  source_cursor   TEXT NOT NULL DEFAULT '',
		  content_digest  TEXT NOT NULL DEFAULT '',
		  first_seen_at   INTEGER NOT NULL,
		  last_seen_at    INTEGER NOT NULL,
		  updated_at      INTEGER NOT NULL,
		  UNIQUE(agent_id, external_ref)
		);
		INSERT INTO agent_sessions
		  (id, agent_id, external_ref, title, cwd, status, first_seen_at, last_seen_at, updated_at)
		VALUES ('session-1', 'claude-code', 'ref-1', 'a session from before', '/code/openkin',
		        'idle', 1, 2, 3);
		INSERT INTO task_agent_sessions (id, task_id, agent_session_id, role, state, attached_at)
		VALUES ('link-1', 'task-1', 'session-1', 'host', 'attached', 1);
		PRAGMA user_version = 35;`); err != nil {
		t.Fatalf("roll schema back to 35: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen at version 35: %v", err)
	}
	t.Cleanup(func() { _ = upgraded.Close() })
	if got := schemaVersionOf(t, upgraded); got != schemaVersion {
		t.Fatalf("user_version after upgrade = %d, want %d", got, schemaVersion)
	}
	if !tableColumns(t, upgraded, "agent_sessions")["device_id"] {
		t.Fatal("upgraded database has no agent_sessions.device_id")
	}

	var title, deviceID string
	if err := upgraded.db.QueryRowContext(ctx,
		`SELECT title, device_id FROM agent_sessions WHERE id = 'session-1'`).Scan(&title, &deviceID); err != nil {
		t.Fatalf("existing session did not survive the upgrade: %v", err)
	}
	if title != "a session from before" || deviceID != "" {
		t.Fatalf("session after upgrade = %q/%q, want the row and no device yet", title, deviceID)
	}
	var links int
	if err := upgraded.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM task_agent_sessions WHERE id = 'link-1'`).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if links != 1 {
		t.Fatal("the task's session link was cascaded away by the rebuild")
	}

	// The rebuilt key is the triple: the same ref on another machine is a new
	// row, and the same triple is a conflict.
	if _, err := upgraded.UpsertAgentSession(ctx, AgentSession{
		DeviceID: "studio", AgentID: "claude-code", ExternalRef: "ref-1", Title: "elsewhere",
	}); err != nil {
		t.Fatalf("a second machine's session was refused: %v", err)
	}
	if _, err := upgraded.db.ExecContext(ctx, `
		INSERT INTO agent_sessions (id, device_id, agent_id, external_ref, first_seen_at, last_seen_at, updated_at)
		VALUES ('session-dup', 'studio', 'claude-code', 'ref-1', 1, 2, 3)`); err == nil {
		t.Fatal("the same ref on the same machine was accepted twice")
	}
}

// A database that already has the column (fresh installs and re-runs) must not
// be rebuilt again: the rebuild drops and renames tables, so running it twice
// would be running it over a table that is already correct.
func TestAgentSessionRebuildIsIdempotent(t *testing.T) {
	ctx := context.Background()
	s := openDeviceTestStore(t)
	if err := s.migrateAgentSessionIdentity(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertAgentSession(ctx, AgentSession{
		DeviceID: "laptop", AgentID: "codex", ExternalRef: "ref-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.migrateAgentSessionIdentity(); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetAgentSession(ctx, "laptop", "codex", "ref-1")
	if err != nil || got.DeviceID != "laptop" {
		t.Fatalf("row after a second run = %+v err=%v", got, err)
	}
}

// A database that reached the current schema before account isolation existed
// has no owner on its tombstones. The additive ensure has to repair that on
// open, because the version chain will not run again for a database that is
// already at the current version — which is exactly the shape a running daemon
// upgrades from.
func TestOpeningACurrentDatabaseAddsTheScopeColumns(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// Rebuild the tombstone table in its pre-isolation shape.
	if _, err := s.db.ExecContext(ctx, `
		DROP TABLE task_tombstones;
		CREATE TABLE task_tombstones (
		  task_id    TEXT PRIMARY KEY,
		  hub_seq    INTEGER NOT NULL,
		  deleted_at INTEGER NOT NULL
		);
		CREATE INDEX idx_task_tombstones_hub_seq ON task_tombstones(hub_seq);`); err != nil {
		t.Fatalf("roll tombstones back: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen at the current version: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	for _, table := range []string{"tasks", "task_tombstones"} {
		if cols := tableColumns(t, reopened, table); !cols["owner_user_id"] {
			t.Fatalf("%s has no owner_user_id after reopening: %v", table, cols)
		}
	}

	// The repaired column has to be usable, not merely present: a deletion must
	// record its owner, and the scoped feed must route it on that.
	insertOwnedTestTask(t, reopened, "task-a", "user-a")
	if err := reopened.DeleteTask(ctx, "task-a"); err != nil {
		t.Fatal(err)
	}
	member, err := reopened.ListTaskChangesSince(ctx, 0, 0, OwnedBy("user-a"))
	if err != nil {
		t.Fatal(err)
	}
	if len(member.Deleted) != 1 || member.Deleted[0] != "task-a" {
		t.Fatalf("deletions after repair = %v, want [task-a]", member.Deleted)
	}
	other, err := reopened.ListTaskChangesSince(ctx, 0, 0, OwnedBy("user-b"))
	if err != nil {
		t.Fatal(err)
	}
	if len(other.Deleted) != 0 {
		t.Fatalf("another account saw the deletion: %v", other.Deleted)
	}
}
