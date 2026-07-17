package store

import (
	"fmt"
)

// Current schema version (PRAGMA user_version).
const schemaVersion = 2

const migration001 = `
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
  permission_mode TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE events (
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  seq      INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
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

CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
`

const migration002 = `
ALTER TABLE tasks ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default';
`


func (s *Store) migrate() error {
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return fmt.Errorf("read user_version: %w", err)
	}
	if v >= schemaVersion {
		return nil
	}
	if v == 0 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 001: %w", err)
		}
		if _, err := tx.Exec(migration001); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration 001: %w", err)
		}
		// Fresh install lands at current schema (includes permission_mode).
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, schemaVersion)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 001: %w", err)
		}
		return nil
	}
	if v == 1 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 002: %w", err)
		}
		if _, err := tx.Exec(migration002); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration 002: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 2`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 002: %w", err)
		}
	}
	return nil
}
