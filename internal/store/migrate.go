package store

import (
	"fmt"
)

// Current schema version (PRAGMA user_version).
const schemaVersion = 7

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
  permission_mode TEXT NOT NULL DEFAULT 'default',
  workspace_mode TEXT NOT NULL DEFAULT 'shared',
  workspace_source_root TEXT NOT NULL DEFAULT '',
  workspace_root TEXT NOT NULL DEFAULT '',
  execution_cwd TEXT NOT NULL DEFAULT '',
  workspace_scope TEXT NOT NULL DEFAULT '.',
  workspace_base_oid TEXT NOT NULL DEFAULT '',
  workspace_branch TEXT NOT NULL DEFAULT '',
  project_id TEXT
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

CREATE TABLE kin_messages (
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  idx      INTEGER NOT NULL,
  role     TEXT NOT NULL,
  content  TEXT NOT NULL DEFAULT '',
  name     TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT NOT NULL DEFAULT '',
  tool_calls TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (task_id, idx)
);

CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'proposed',
  source_task_id TEXT REFERENCES tasks(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_status ON artifacts(status, created_at DESC);

CREATE TABLE usage_records (
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_seq               INTEGER NOT NULL,
  occurred_at             INTEGER NOT NULL,
  agent                   TEXT NOT NULL,
  provider                TEXT,
  model                   TEXT,
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  reasoning_output_tokens INTEGER,
  cache_read_tokens       INTEGER,
  cache_write_tokens      INTEGER,
  cost_usd                REAL,
  cost_source             TEXT NOT NULL,
  cache_status            TEXT NOT NULL,
  input_semantics         TEXT NOT NULL,
  PRIMARY KEY (task_id, event_seq)
);
CREATE INDEX idx_usage_records_occurred ON usage_records(occurred_at, agent, model);
CREATE INDEX idx_usage_records_task ON usage_records(task_id, event_seq);

CREATE TABLE task_checkpoints (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_seq  INTEGER NOT NULL,
  head_oid   TEXT NOT NULL,
  tree_oid   TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, event_seq)
);
CREATE INDEX idx_task_checkpoints_task ON task_checkpoints(task_id, event_seq);

CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  mode            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  one_pager_rel   TEXT NOT NULL,
  soft_progress   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL
);
CREATE INDEX idx_projects_status_active ON projects(status, last_active_at DESC);

CREATE TABLE project_roots (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);
CREATE INDEX idx_project_roots_path ON project_roots(path);

CREATE INDEX idx_tasks_project ON tasks(project_id, id DESC);
`

const migration002 = `
ALTER TABLE tasks ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default';
`

const migration003 = `
CREATE TABLE kin_messages (
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  idx      INTEGER NOT NULL,
  role     TEXT NOT NULL,
  content  TEXT NOT NULL DEFAULT '',
  name     TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT NOT NULL DEFAULT '',
  tool_calls TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (task_id, idx)
);
`

const migration004 = `
CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'proposed',
  source_task_id TEXT REFERENCES tasks(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_status ON artifacts(status, created_at DESC);

`

const migration005 = `
CREATE TABLE usage_records (
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_seq               INTEGER NOT NULL,
  occurred_at             INTEGER NOT NULL,
  agent                   TEXT NOT NULL,
  provider                TEXT,
  model                   TEXT,
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  reasoning_output_tokens INTEGER,
  cache_read_tokens       INTEGER,
  cache_write_tokens      INTEGER,
  cost_usd                REAL,
  cost_source             TEXT NOT NULL,
  cache_status            TEXT NOT NULL,
  input_semantics         TEXT NOT NULL,
  PRIMARY KEY (task_id, event_seq)
);
CREATE INDEX idx_usage_records_occurred ON usage_records(occurred_at, agent, model);
CREATE INDEX idx_usage_records_task ON usage_records(task_id, event_seq);
`

const migration006 = `
ALTER TABLE tasks ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE tasks ADD COLUMN workspace_source_root TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN workspace_root TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN execution_cwd TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN workspace_scope TEXT NOT NULL DEFAULT '.';
ALTER TABLE tasks ADD COLUMN workspace_base_oid TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN workspace_branch TEXT NOT NULL DEFAULT '';

CREATE TABLE task_checkpoints (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_seq  INTEGER NOT NULL,
  head_oid   TEXT NOT NULL,
  tree_oid   TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, event_seq)
);
CREATE INDEX idx_task_checkpoints_task ON task_checkpoints(task_id, event_seq);
`

const migration007 = `
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  mode            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  one_pager_rel   TEXT NOT NULL,
  soft_progress   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_status_active ON projects(status, last_active_at DESC);

CREATE TABLE IF NOT EXISTS project_roots (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);
CREATE INDEX IF NOT EXISTS idx_project_roots_path ON project_roots(path);
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
		// Fresh install lands at current schema (includes permission_mode and artifacts).
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
		v = 2
	}
	if v == 2 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 003: %w", err)
		}
		if _, err := tx.Exec(migration003); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration 003: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 3`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 003: %w", err)
		}
		v = 3
	}
	if v == 3 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 004: %w", err)
		}
		if _, err := tx.Exec(migration004); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration 004: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 4`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 004: %w", err)
		}
		v = 4
	}
	if v == 4 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 005: %w", err)
		}
		if _, err := tx.Exec(migration005); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration 005: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 5`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 005: %w", err)
		}
		v = 5
	}
	if v == 5 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 006: %w", err)
		}
		if _, err := tx.Exec(migration006); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration 006: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 6`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 006: %w", err)
		}
		v = 6
	}

	if v == 6 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 007: %w", err)
		}
		if _, err := tx.Exec(migration007); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration 007: %w", err)
		}
		// project_id may already exist on fresh DBs that were downgraded in tests.
		var n int
		err = tx.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'project_id'`).Scan(&n)
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("check project_id column: %w", err)
		}
		if n == 0 {
			if _, err := tx.Exec(`ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)`); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("add project_id column: %w", err)
			}
		}
		if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, id DESC)`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("create idx_tasks_project: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 7`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 007: %w", err)
		}
	}
	return nil
}
