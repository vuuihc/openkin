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
