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
	for _, table := range []string{"tasks", "events", "approvals", "settings"} {
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

	tasks, err := s2.ListTasks(context.Background())
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
