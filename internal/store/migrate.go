package store

import (
	"fmt"
	"strings"
)

// Current schema version (PRAGMA user_version).
const schemaVersion = 30

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
  project_id TEXT,
  routine_id TEXT,
  routine_noteworthy INTEGER NOT NULL DEFAULT 0,
  routine_tldr TEXT NOT NULL DEFAULT '',
  routine_unread INTEGER NOT NULL DEFAULT 0,
  event_epoch INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE approvals (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  decision    TEXT NOT NULL DEFAULT 'pending',
  decided_via TEXT,
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  execution_id    TEXT,
  execution_agent TEXT,
  execution_step  INTEGER,
  execution_model TEXT
);

CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );

CREATE TABLE IF NOT EXISTS pairing_sessions (
  secret_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_expires
ON pairing_sessions(expires_at, used_at);

CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_credentials_active
ON device_credentials(revoked_at, created_at DESC);
CREATE TABLE user_questions (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  response        TEXT,
  answered_via    TEXT,
  created_at      INTEGER NOT NULL,
  answered_at     INTEGER,
  execution_id    TEXT,
  execution_agent TEXT,
  execution_step  INTEGER,
  execution_model TEXT
);

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
  event_epoch             INTEGER NOT NULL DEFAULT 0,
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
  PRIMARY KEY (task_id, event_epoch, event_seq)
);
CREATE INDEX idx_usage_records_occurred ON usage_records(occurred_at, agent, model);
CREATE INDEX idx_usage_records_task ON usage_records(task_id, event_epoch, event_seq);

CREATE TABLE task_checkpoints (
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_seq    INTEGER NOT NULL,
  head_oid     TEXT NOT NULL,
  tree_oid     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
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

CREATE TABLE routines (
  id               TEXT PRIMARY KEY,
  project_id       TEXT REFERENCES projects(id),
  cwd              TEXT NOT NULL,
  agent            TEXT NOT NULL,
  permission_mode  TEXT NOT NULL DEFAULT 'default',
  prompt           TEXT NOT NULL,
  interval_secs    INTEGER NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_run_at      INTEGER,
  next_due_at      INTEGER NOT NULL,
  consec_failures  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  missed_run_policy TEXT NOT NULL DEFAULT 'coalesce',
  lane             TEXT NOT NULL DEFAULT 'routine',
  claim_token      TEXT NOT NULL DEFAULT '',
  claim_until_at   INTEGER NOT NULL DEFAULT 0,
  last_outcome     TEXT NOT NULL DEFAULT '',
  last_error       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_routines_due ON routines(enabled, next_due_at);
CREATE INDEX idx_routines_due_claim ON routines(enabled, next_due_at, claim_until_at, id);
CREATE INDEX idx_routines_project ON routines(project_id);
CREATE INDEX idx_tasks_routine ON tasks(routine_id, id DESC);
CREATE INDEX idx_tasks_routine_unread ON tasks(routine_unread, id DESC) WHERE routine_id IS NOT NULL;

CREATE TABLE routine_dispatches (
  routine_id  TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  due_at      INTEGER NOT NULL,
  task_id     TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (routine_id, due_at)
);
CREATE UNIQUE INDEX routine_dispatches_task ON routine_dispatches(task_id);
;

CREATE TABLE task_worker_steps (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id   TEXT NOT NULL,
  step_index     INTEGER NOT NULL,
  role           TEXT NOT NULL DEFAULT 'worker',
  depends_on     TEXT NOT NULL DEFAULT '[]',
  agent          TEXT NOT NULL,
  provider       TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  access         TEXT NOT NULL DEFAULT 'read',
  status         TEXT NOT NULL DEFAULT 'planned',
  attempt        INTEGER NOT NULL DEFAULT 1,
  execution_ref  TEXT NOT NULL DEFAULT '',
  result_summary TEXT NOT NULL DEFAULT '',
  error          TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (task_id, execution_id, step_index)
);
CREATE INDEX task_worker_steps_task ON task_worker_steps(task_id, created_at, step_index);

CREATE TABLE IF NOT EXISTS task_workspaces (
  id                    TEXT NOT NULL,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  generation            INTEGER NOT NULL,
  state                 TEXT NOT NULL,
  source_root           TEXT NOT NULL,
  scope                 TEXT NOT NULL DEFAULT '.',
  target_branch         TEXT NOT NULL DEFAULT '',
  workspace_branch      TEXT NOT NULL DEFAULT '',
  physical_root         TEXT NOT NULL DEFAULT '',
  execution_cwd         TEXT NOT NULL DEFAULT '',
  base_oid              TEXT NOT NULL DEFAULT '',
  review_base_oid       TEXT NOT NULL DEFAULT '',
  final_head_oid        TEXT NOT NULL DEFAULT '',
  final_tree_oid        TEXT NOT NULL DEFAULT '',
  integrated_oid        TEXT NOT NULL DEFAULT '',
  requested_execution_id TEXT NOT NULL DEFAULT '',
  requested_user_event_seq INTEGER NOT NULL DEFAULT 0,
  completed_execution_id TEXT NOT NULL DEFAULT '',
  failure_reason        TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  integrated_at         INTEGER,
  released_at           INTEGER,
  UNIQUE(task_id, generation),
  UNIQUE(id, task_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS task_workspaces_one_open
ON task_workspaces(task_id)
WHERE state IN (
  'provisioning', 'ready', 'active',
  'finalizing', 'integrated', 'merge_blocked', 'finalize_blocked',
  'legacy_pending'
);

CREATE INDEX IF NOT EXISTS task_workspaces_task_generation
ON task_workspaces(task_id, generation);

CREATE TABLE IF NOT EXISTS task_turn_workspaces (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_event_seq INTEGER NOT NULL,
  workspace_id   TEXT,
  access         TEXT NOT NULL CHECK (
    access IN ('pending_isolation', 'source_read_only', 'writable', 'shared')
  ),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (
    (access IN ('pending_isolation', 'source_read_only', 'shared') AND workspace_id IS NULL)
    OR (access = 'writable' AND workspace_id IS NOT NULL)
  ),
  PRIMARY KEY(task_id, user_event_seq),
  FOREIGN KEY(task_id, user_event_seq) REFERENCES events(task_id, seq) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id, task_id) REFERENCES task_workspaces(id, task_id)
);

CREATE TABLE IF NOT EXISTS retry_restore_intents (
  task_id                  TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  restore_files            INTEGER NOT NULL DEFAULT 1,
  from_seq                 INTEGER NOT NULL,
  expected_event_epoch     INTEGER NOT NULL,
  previous_status          TEXT NOT NULL,
  prompt                   TEXT NOT NULL,
  user_payload             TEXT NOT NULL,
  checkpoint_head_oid      TEXT NOT NULL DEFAULT '',
  checkpoint_tree_oid      TEXT NOT NULL DEFAULT '',
  checkpoint_size_bytes    INTEGER NOT NULL DEFAULT 0,
  checkpoint_created_at    INTEGER NOT NULL,
  checkpoint_workspace_id  TEXT NOT NULL DEFAULT '',
  rollback_head_oid        TEXT NOT NULL DEFAULT '',
  rollback_tree_oid        TEXT NOT NULL DEFAULT '',
  rollback_size_bytes      INTEGER NOT NULL DEFAULT 0,
  rollback_created_at      INTEGER NOT NULL DEFAULT 0,
  target_workspace_id      TEXT NOT NULL DEFAULT '',
  target_generation        INTEGER NOT NULL DEFAULT 0,
  target_is_new            INTEGER NOT NULL DEFAULT 0,
  activate_target          INTEGER NOT NULL DEFAULT 0,
  source_root              TEXT NOT NULL DEFAULT '',
  scope                    TEXT NOT NULL DEFAULT '.',
  target_branch            TEXT NOT NULL DEFAULT '',
  workspace_branch         TEXT NOT NULL DEFAULT '',
  physical_root            TEXT NOT NULL DEFAULT '',
  execution_cwd            TEXT NOT NULL DEFAULT '',
  base_oid                 TEXT NOT NULL DEFAULT '',
  created_at               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_limit_waits (
  task_id       TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  event_epoch   INTEGER NOT NULL DEFAULT 0,
  user_seq      INTEGER NOT NULL DEFAULT 0,
  agent         TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT '',
  window        TEXT NOT NULL DEFAULT '',
  reset_at      INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'waiting',
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_probe_at INTEGER NOT NULL,
  first_wait_at INTEGER NOT NULL,
  last_probe_at INTEGER,
  last_error    TEXT NOT NULL DEFAULT '',
  claimed_at    INTEGER,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_limit_waits_due
ON task_limit_waits(state, next_probe_at, task_id);

CREATE TABLE IF NOT EXISTS mcp_audit_calls (
  id              TEXT PRIMARY KEY,
  occurred_at     INTEGER NOT NULL,
  principal_kind  TEXT NOT NULL,
  principal_id    TEXT NOT NULL DEFAULT '',
  client_id       TEXT NOT NULL DEFAULT '',
  method          TEXT NOT NULL,
  tool            TEXT NOT NULL DEFAULT '',
  scope           TEXT NOT NULL DEFAULT '',
  success         INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT NOT NULL DEFAULT '',
  request_hash    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_calls_time
ON mcp_audit_calls(occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS mcp_idempotency (
  principal_id  TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'completed',
  response      TEXT NOT NULL,
  PRIMARY KEY (principal_id, client_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_mcp_idempotency_expiry
ON mcp_idempotency(expires_at);

CREATE TABLE IF NOT EXISTS mcp_task_origins (
  task_id         TEXT PRIMARY KEY,
  principal_kind  TEXT NOT NULL,
  principal_id    TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

ALTER TABLE tasks ADD COLUMN workspace_policy TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE tasks ADD COLUMN current_workspace_id TEXT NOT NULL DEFAULT '';

` + migrationEvalTables + migrationA2ATables + migrationA2AOperations

const migrationEvalTables = `
CREATE TABLE IF NOT EXISTS eval_runs (
  id                  TEXT PRIMARY KEY,
  suite               TEXT NOT NULL,
  suite_version       TEXT NOT NULL,
  condition           TEXT NOT NULL DEFAULT 'cold',
  route_objective     TEXT NOT NULL DEFAULT '',
  kin_git_sha         TEXT NOT NULL DEFAULT '',
  n_reps              INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'running',
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  report_artifact_id  TEXT NOT NULL DEFAULT '',
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_started
ON eval_runs(started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS eval_results (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id      TEXT NOT NULL,
  rep_idx      INTEGER NOT NULL,
  task_id      TEXT,
  pass         INTEGER NOT NULL DEFAULT 0,
  turns        INTEGER NOT NULL DEFAULT 0,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  checker_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  UNIQUE(run_id, case_id, rep_idx)
);
CREATE INDEX IF NOT EXISTS idx_eval_results_run
ON eval_results(run_id, case_id, rep_idx);
`

const migrationA2ATables = `
CREATE TABLE IF NOT EXISTS a2a_idempotency (
  principal_id TEXT NOT NULL,
  idem_key     TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (principal_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_a2a_idempotency_task
ON a2a_idempotency(task_id);
`

const migrationA2AOperations = `
CREATE TABLE IF NOT EXISTS a2a_operations (
  principal_id TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  idem_key     TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'started',
  response     TEXT NOT NULL DEFAULT '',
  http_status  INTEGER NOT NULL DEFAULT 200,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (principal_id, task_id, idem_key)
);
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
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_seq    INTEGER NOT NULL,
  head_oid     TEXT NOT NULL,
  tree_oid     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
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

// migration008 formerly created project_recycles (session wrap-up).
// Retired: prefer prompt/agent flows over a hard-coded recycle entity.
// Kept as empty SQL so historical version steps remain contiguous.
const migration008 = `SELECT 1;`

// Migration 009 adds nullable execution attribution columns to approvals.
// Applied conditionally (missing columns only) so fresh DBs whose migration001
// already includes the columns and legacy fixtures without an approvals table
// both advance to user_version=10 cleanly.

func (s *Store) migrate() error {
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return fmt.Errorf("read user_version: %w", err)
	}
	if v >= schemaVersion {
		return s.ensureDeviceSchema()
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
		v = 7
	}

	if v == 7 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 008: %w", err)
		}
		if _, err := tx.Exec(migration008); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration 008: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 8`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 008: %w", err)
		}
		v = 8
	}

	if v == 8 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 009: %w", err)
		}
		// Fresh DBs already have execution columns in migration001. Populated
		// legacy fixtures may lack the approvals table or already include some
		// columns after partial upgrades; add only missing nullable columns.
		var hasApprovals int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'approvals'`).Scan(&hasApprovals); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("check approvals table: %w", err)
		}
		if hasApprovals > 0 {
			cols := []struct {
				name string
				decl string
			}{
				{"execution_id", "TEXT"},
				{"execution_agent", "TEXT"},
				{"execution_step", "INTEGER"},
				{"execution_model", "TEXT"},
			}
			for _, col := range cols {
				var n int
				q := fmt.Sprintf(`SELECT COUNT(*) FROM pragma_table_info('approvals') WHERE name = '%s'`, col.name)
				if err := tx.QueryRow(q).Scan(&n); err != nil {
					_ = tx.Rollback()
					return fmt.Errorf("check approvals.%s: %w", col.name, err)
				}
				if n == 0 {
					if _, err := tx.Exec(fmt.Sprintf(`ALTER TABLE approvals ADD COLUMN %s %s`, col.name, col.decl)); err != nil {
						_ = tx.Rollback()
						return fmt.Errorf("add approvals.%s: %w", col.name, err)
					}
				}
			}
		}
		if _, err := tx.Exec(`PRAGMA user_version = 9`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 009: %w", err)
		}
		v = 9
	}

	if v == 9 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 010: %w", err)
		}
		if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS user_questions (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  response        TEXT,
  answered_via    TEXT,
  created_at      INTEGER NOT NULL,
  answered_at     INTEGER,
  execution_id    TEXT,
  execution_agent TEXT,
  execution_step  INTEGER,
  execution_model TEXT
)`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 010 user_questions: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 10`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 010: %w", err)
		}
		v = 10
	}

	if v == 10 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 011: %w", err)
		}
		if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS routines (
  id               TEXT PRIMARY KEY,
  project_id       TEXT REFERENCES projects(id),
  cwd              TEXT NOT NULL,
  agent            TEXT NOT NULL,
  permission_mode  TEXT NOT NULL DEFAULT 'default',
  prompt           TEXT NOT NULL,
  interval_secs    INTEGER NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_run_at      INTEGER,
  next_due_at      INTEGER NOT NULL,
  consec_failures  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  title            TEXT NOT NULL DEFAULT ''
)`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 011 routines: %w", err)
		}
		if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_routines_due ON routines(enabled, next_due_at)`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 011 routines due index: %w", err)
		}
		if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_routines_project ON routines(project_id)`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 011 routines project index: %w", err)
		}
		for _, col := range []struct{ name, def string }{
			{"routine_id", "TEXT REFERENCES routines(id)"},
			{"routine_noteworthy", "INTEGER NOT NULL DEFAULT 0"},
			{"routine_tldr", "TEXT NOT NULL DEFAULT ''"},
			{"routine_unread", "INTEGER NOT NULL DEFAULT 0"},
		} {
			var n int
			q := fmt.Sprintf(`SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = '%s'`, col.name)
			if err := tx.QueryRow(q).Scan(&n); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("check %s column: %w", col.name, err)
			}
			if n == 0 {
				if _, err := tx.Exec(fmt.Sprintf(`ALTER TABLE tasks ADD COLUMN %s %s`, col.name, col.def)); err != nil {
					_ = tx.Rollback()
					return fmt.Errorf("add %s column: %w", col.name, err)
				}
			}
		}
		if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_tasks_routine ON tasks(routine_id, id DESC)`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 011 tasks routine index: %w", err)
		}
		if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_tasks_routine_unread ON tasks(routine_unread, id DESC) WHERE routine_id IS NOT NULL`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 011 tasks routine unread index: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 11`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 011: %w", err)
		}
		v = 11
	}

	if v == 11 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 012: %w", err)
		}
		// Drop retired session "recycle/wrap-up" storage. Product direction:
		// prefer agent/prompt-driven project memory over a hard-coded recycle entity.
		if _, err := tx.Exec(`DROP TABLE IF EXISTS project_recycles`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 012 drop project_recycles: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 12`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 012: %w", err)
		}
		v = 12
	}

	if v == 12 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 013: %w", err)
		}

		// Create task_workspaces table for workspace generations (ADR 0014)
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS task_workspaces (
  id                    TEXT NOT NULL,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  generation            INTEGER NOT NULL,
  state                 TEXT NOT NULL,
  source_root           TEXT NOT NULL,
  scope                 TEXT NOT NULL DEFAULT '.',
  target_branch         TEXT NOT NULL DEFAULT '',
  workspace_branch      TEXT NOT NULL DEFAULT '',
  physical_root         TEXT NOT NULL DEFAULT '',
  execution_cwd         TEXT NOT NULL DEFAULT '',
  base_oid              TEXT NOT NULL DEFAULT '',
  review_base_oid       TEXT NOT NULL DEFAULT '',
  final_head_oid        TEXT NOT NULL DEFAULT '',
  final_tree_oid        TEXT NOT NULL DEFAULT '',
  integrated_oid        TEXT NOT NULL DEFAULT '',
  requested_execution_id TEXT NOT NULL DEFAULT '',
  requested_user_event_seq INTEGER NOT NULL DEFAULT 0,
  completed_execution_id TEXT NOT NULL DEFAULT '',
  failure_reason        TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  integrated_at         INTEGER,
  released_at           INTEGER,
  UNIQUE(task_id, generation),
  UNIQUE(id, task_id)
)
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 013 create task_workspaces: %w", err)
		}

		if _, err := tx.Exec(`
CREATE UNIQUE INDEX IF NOT EXISTS task_workspaces_one_open
ON task_workspaces(task_id)
WHERE state IN (
  'provisioning', 'ready', 'active',
  'finalizing', 'integrated', 'merge_blocked', 'finalize_blocked',
  'legacy_pending'
)
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 013 task_workspaces one_open index: %w", err)
		}

		if _, err := tx.Exec(`
CREATE INDEX IF NOT EXISTS task_workspaces_task_generation
ON task_workspaces(task_id, generation)
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 013 task_workspaces generation index: %w", err)
		}

		// Create task_turn_workspaces table
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS task_turn_workspaces (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_event_seq INTEGER NOT NULL,
  workspace_id   TEXT,
  access         TEXT NOT NULL CHECK (
    access IN ('pending_isolation', 'source_read_only', 'writable', 'shared')
  ),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (
    (access IN ('pending_isolation', 'source_read_only', 'shared') AND workspace_id IS NULL)
    OR (access = 'writable' AND workspace_id IS NOT NULL)
  ),
  PRIMARY KEY(task_id, user_event_seq),
  FOREIGN KEY(task_id, user_event_seq) REFERENCES events(task_id, seq) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id, task_id) REFERENCES task_workspaces(id, task_id)
)
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 013 create task_turn_workspaces: %w", err)
		}

		// Add columns to tasks table
		if _, err := tx.Exec(`ALTER TABLE tasks ADD COLUMN workspace_policy TEXT NOT NULL DEFAULT 'auto'`); err != nil {

			// Ignore error if column already exists or table is missing
			_ = err
		}
		if _, err := tx.Exec(`ALTER TABLE tasks ADD COLUMN current_workspace_id TEXT NOT NULL DEFAULT ''`); err != nil {

			// Ignore error if column already exists or table is missing
			_ = err
		}

		// Add workspace_id column to task_checkpoints (created in migration 005).
		// Ignore error if table doesn't exist (test schemas may not have it).
		_, _ = tx.Exec(`ALTER TABLE task_checkpoints ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`)

		// Backfill: create legacy_pending generations for existing worktree tasks
		if _, err := tx.Exec(`
INSERT INTO task_workspaces (
  id, task_id, generation, state, source_root, scope,
  workspace_branch, physical_root, execution_cwd, base_oid,
  created_at, updated_at
)
SELECT
  id || ':g1', id, 1, 'legacy_pending',
  workspace_source_root, workspace_scope,
  workspace_branch, workspace_root, execution_cwd, workspace_base_oid,
  created_at, created_at
FROM tasks
WHERE workspace_mode = 'worktree' AND workspace_root <> ''
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 013 backfill legacy worktree: %w", err)
		}

		if _, err := tx.Exec(`
UPDATE tasks
SET current_workspace_id = id || ':g1', workspace_policy = 'worktree'
WHERE workspace_mode = 'worktree' AND workspace_root <> ''
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 013 set legacy current_workspace_id: %w", err)
		}

		if _, err := tx.Exec(`
UPDATE tasks
SET workspace_policy = 'shared'
WHERE workspace_mode <> 'worktree'
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 013 set shared policy: %w", err)
		}
		// Update existing checkpoints to reference their legacy workspace
		// Ignore error if table does not exist (test schemas may not have it).
		_, _ = tx.Exec(`UPDATE task_checkpoints
SET workspace_id = (
  SELECT current_workspace_id FROM tasks WHERE id = task_checkpoints.task_id
)
WHERE workspace_id = '' AND EXISTS (
  SELECT 1 FROM tasks WHERE id = task_checkpoints.task_id AND current_workspace_id <> ''
)
`)

		if _, err := tx.Exec(`PRAGMA user_version = 13`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 013: %w", err)
		}
		v = 13
	}

	if v == 13 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 014: %w", err)
		}
		// Add dispatch column to tasks table for auto model routing.
		var n int
		err = tx.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'dispatch'`).Scan(&n)
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("check dispatch column: %w", err)
		}
		if n == 0 {
			if _, err := tx.Exec(`ALTER TABLE tasks ADD COLUMN dispatch TEXT`); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("add dispatch column: %w", err)
			}
		}
		if _, err := tx.Exec(`PRAGMA user_version = 14`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 014: %w", err)
		}
		v = 14
	}

	if v == 14 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 015: %w", err)
		}
		var n int
		err = tx.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'event_epoch'`).Scan(&n)
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("check event_epoch column: %w", err)
		}
		if n == 0 {
			if _, err := tx.Exec(`ALTER TABLE tasks ADD COLUMN event_epoch INTEGER NOT NULL DEFAULT 0`); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("add event_epoch column: %w", err)
			}
		}
		var usageTableExists int
		err = tx.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'usage_records'`).Scan(&usageTableExists)
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("check usage_records table: %w", err)
		}
		createUsageRecords := `
CREATE TABLE usage_records (
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_epoch             INTEGER NOT NULL DEFAULT 0,
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
  PRIMARY KEY (task_id, event_epoch, event_seq)
);`
		if usageTableExists > 0 {
			if _, err := tx.Exec(`
ALTER TABLE usage_records RENAME TO usage_records_v14;
` + createUsageRecords + `
INSERT INTO usage_records (
  task_id, event_epoch, event_seq, occurred_at, agent, provider, model,
  input_tokens, output_tokens, reasoning_output_tokens, cache_read_tokens,
  cache_write_tokens, cost_usd, cost_source, cache_status, input_semantics
)
SELECT
  task_id, 0, event_seq, occurred_at, agent, provider, model,
  input_tokens, output_tokens, reasoning_output_tokens, cache_read_tokens,
  cache_write_tokens, cost_usd, cost_source, cache_status, input_semantics
FROM usage_records_v14;
DROP TABLE usage_records_v14;
CREATE INDEX idx_usage_records_occurred ON usage_records(occurred_at, agent, model);
CREATE INDEX idx_usage_records_task ON usage_records(task_id, event_epoch, event_seq);
`); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("migrate usage records event epoch: %w", err)
			}
		} else if _, err := tx.Exec(createUsageRecords + `
CREATE INDEX idx_usage_records_occurred ON usage_records(occurred_at, agent, model);
CREATE INDEX idx_usage_records_task ON usage_records(task_id, event_epoch, event_seq);
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("create usage records event epoch: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 15`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 015: %w", err)
		}
		v = 15
	}

	if v == 15 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 016: %w", err)
		}
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS retry_restore_intents (
  task_id                  TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  restore_files            INTEGER NOT NULL DEFAULT 1,
  from_seq                 INTEGER NOT NULL,
  expected_event_epoch     INTEGER NOT NULL,
  previous_status          TEXT NOT NULL,
  prompt                   TEXT NOT NULL,
  user_payload             TEXT NOT NULL,
  checkpoint_head_oid      TEXT NOT NULL DEFAULT '',
  checkpoint_tree_oid      TEXT NOT NULL DEFAULT '',
  checkpoint_size_bytes    INTEGER NOT NULL DEFAULT 0,
  checkpoint_created_at    INTEGER NOT NULL,
  checkpoint_workspace_id  TEXT NOT NULL DEFAULT '',
  rollback_head_oid        TEXT NOT NULL DEFAULT '',
  rollback_tree_oid        TEXT NOT NULL DEFAULT '',
  rollback_size_bytes      INTEGER NOT NULL DEFAULT 0,
  rollback_created_at      INTEGER NOT NULL DEFAULT 0,
  target_workspace_id      TEXT NOT NULL DEFAULT '',
  target_generation        INTEGER NOT NULL DEFAULT 0,
  target_is_new            INTEGER NOT NULL DEFAULT 0,
  activate_target          INTEGER NOT NULL DEFAULT 0,
  source_root              TEXT NOT NULL DEFAULT '',
  scope                    TEXT NOT NULL DEFAULT '.',
  target_branch            TEXT NOT NULL DEFAULT '',
  workspace_branch         TEXT NOT NULL DEFAULT '',
  physical_root            TEXT NOT NULL DEFAULT '',
  execution_cwd            TEXT NOT NULL DEFAULT '',
  base_oid                 TEXT NOT NULL DEFAULT '',
  created_at               INTEGER NOT NULL
)`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 016 retry restore intents: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 16`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 016: %w", err)
		}
		v = 16
	}

	if v == 16 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 017: %w", err)
		}
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS pairing_sessions (
  secret_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_expires
ON pairing_sessions(expires_at, used_at);

CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_credentials_active
ON device_credentials(revoked_at, created_at DESC);
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 017 device credentials: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 17`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 017: %w", err)
		}
		v = 17
	}

	if v == 17 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 018: %w", err)
		}
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS task_limit_waits (
  task_id       TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  event_epoch   INTEGER NOT NULL DEFAULT 0,
  user_seq      INTEGER NOT NULL DEFAULT 0,
  agent         TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT '',
  window        TEXT NOT NULL DEFAULT '',
  reset_at      INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'waiting',
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_probe_at INTEGER NOT NULL,
  first_wait_at INTEGER NOT NULL,
  last_probe_at INTEGER,
  last_error    TEXT NOT NULL DEFAULT '',
  claimed_at    INTEGER,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_limit_waits_due
ON task_limit_waits(state, next_probe_at, task_id);
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 018 task limit waits: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 18`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 018: %w", err)
		}
		v = 18
	}

	if v == 18 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 019: %w", err)
		}
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  cwd TEXT NOT NULL,
  agent TEXT NOT NULL,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  prompt TEXT NOT NULL,
  interval_secs INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_due_at INTEGER NOT NULL,
  consec_failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT ''
);`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 019 ensure routines: %w", err)
		}
		for _, q := range []string{
			`missed_run_policy TEXT NOT NULL DEFAULT 'coalesce'`,
			`lane TEXT NOT NULL DEFAULT 'routine'`,
			`claim_token TEXT NOT NULL DEFAULT ''`,
			`claim_until_at INTEGER NOT NULL DEFAULT 0`,
			`last_outcome TEXT NOT NULL DEFAULT ''`,
			`last_error TEXT NOT NULL DEFAULT ''`,
		} {
			var exists int
			name := strings.Fields(q)[0]
			if err := tx.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('routines') WHERE name = ?`, name).Scan(&exists); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("migration 019 inspect routine column: %w", err)
			}
			if exists != 0 {
				continue
			}
			if _, err := tx.Exec(`ALTER TABLE routines ADD COLUMN ` + q); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("migration 019 routine columns: %w", err)
			}
		}
		if _, err := tx.Exec(`
CREATE INDEX IF NOT EXISTS idx_routines_due_claim
ON routines(enabled, next_due_at, claim_until_at, id);
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 019 routine due index: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 19`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 019: %w", err)
		}
		v = 19
	}

	if v == 19 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 020: %w", err)
		}
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS mcp_audit_calls (
  id              TEXT PRIMARY KEY,
  occurred_at     INTEGER NOT NULL,
  principal_kind  TEXT NOT NULL,
  principal_id    TEXT NOT NULL DEFAULT '',
  client_id       TEXT NOT NULL DEFAULT '',
  method          TEXT NOT NULL,
  tool            TEXT NOT NULL DEFAULT '',
  scope           TEXT NOT NULL DEFAULT '',
  success         INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT NOT NULL DEFAULT '',
  request_hash    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_calls_time
ON mcp_audit_calls(occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS mcp_idempotency (
  principal_id  TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  response      TEXT NOT NULL,
  PRIMARY KEY (principal_id, client_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_mcp_idempotency_expiry
ON mcp_idempotency(expires_at);
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 020 mcp tables: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 20`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 020: %w", err)
		}
		v = 20
	}

	if v == 20 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 021: %w", err)
		}
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS mcp_task_origins (
  task_id         TEXT PRIMARY KEY,
  principal_kind  TEXT NOT NULL,
  principal_id    TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 021 MCP task origins: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 21`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 021: %w", err)
		}
		v = 21
	}

	if v == 21 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 022: %w", err)
		}
		var exists int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('mcp_idempotency') WHERE name = 'state'`).Scan(&exists); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 022 inspect MCP idempotency: %w", err)
		}
		if exists == 0 {
			if _, err := tx.Exec(`ALTER TABLE mcp_idempotency ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'`); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("migration 022 MCP idempotency state: %w", err)
			}
		}
		if _, err := tx.Exec(`PRAGMA user_version = 22`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 022: %w", err)
		}
		v = 22
	}

	if v == 22 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 023: %w", err)
		}
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS routine_dispatches (
  routine_id  TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  due_at      INTEGER NOT NULL,
  task_id     TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (routine_id, due_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS routine_dispatches_task ON routine_dispatches(task_id);
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 023 routine dispatches: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 23`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 023: %w", err)
		}
		v = 23
	}

	if v == 23 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 024: %w", err)
		}
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS mcp_task_origins_new (
  task_id         TEXT PRIMARY KEY,
  principal_kind  TEXT NOT NULL,
  principal_id    TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
INSERT OR REPLACE INTO mcp_task_origins_new
  (task_id, principal_kind, principal_id, client_id, session_id, created_at)
SELECT task_id, principal_kind, principal_id, client_id, session_id, created_at
FROM mcp_task_origins;
DROP TABLE mcp_task_origins;
ALTER TABLE mcp_task_origins_new RENAME TO mcp_task_origins;
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 024 MCP task origins: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 24`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 024: %w", err)
		}
		v = 24
	}

	if v == 24 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 025: %w", err)
		}
		if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS task_worker_steps (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id   TEXT NOT NULL,
  step_index     INTEGER NOT NULL,
  role           TEXT NOT NULL DEFAULT 'worker',
  depends_on     TEXT NOT NULL DEFAULT '[]',
  agent          TEXT NOT NULL,
  provider       TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  access         TEXT NOT NULL DEFAULT 'read',
  status         TEXT NOT NULL DEFAULT 'planned',
  attempt        INTEGER NOT NULL DEFAULT 1,
  execution_ref  TEXT NOT NULL DEFAULT '',
  result_summary TEXT NOT NULL DEFAULT '',
  error          TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (task_id, execution_id, step_index)
);
CREATE INDEX IF NOT EXISTS task_worker_steps_task
ON task_worker_steps(task_id, created_at, step_index);
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 025 worker steps: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 25`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 025: %w", err)
		}
		v = 25
	}

	if v == 25 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 026: %w", err)
		}
		if _, err := tx.Exec(migrationEvalTables); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 026 eval tables: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 26`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 026: %w", err)
		}
		v = 26
	}

	if v == 26 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 027: %w", err)
		}
		if _, err := tx.Exec(migrationA2ATables); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 027 a2a table: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 27`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 027: %w", err)
		}
		v = 27
	}

	if v == 27 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 028: %w", err)
		}
		if _, err := tx.Exec(`
CREATE TABLE eval_results_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id      TEXT NOT NULL,
  rep_idx      INTEGER NOT NULL,
  task_id      TEXT,
  pass         INTEGER NOT NULL DEFAULT 0,
  turns        INTEGER NOT NULL DEFAULT 0,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  checker_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  UNIQUE(run_id, case_id, rep_idx)
);
INSERT INTO eval_results_new
  SELECT id, run_id, case_id, rep_idx, task_id, pass, turns, tokens_in,
         tokens_out, cost_usd, latency_ms, checker_json, created_at
  FROM eval_results;
DROP TABLE eval_results;
ALTER TABLE eval_results_new RENAME TO eval_results;
CREATE INDEX IF NOT EXISTS idx_eval_results_run
ON eval_results(run_id, case_id, rep_idx);
`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 028 eval result table: %w", err)
		}
		if _, err := tx.Exec(migrationA2AOperations); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 028 a2a operations: %w", err)
		}
		if _, err := tx.Exec(`PRAGMA user_version = 28`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 028: %w", err)
		}
		v = 28
	}

	if v == 28 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 029: %w", err)
		}
		var hasHash int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('a2a_idempotency') WHERE name = 'request_hash'`).Scan(&hasHash); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 029 inspect a2a idempotency hash: %w", err)
		}
		if hasHash == 0 {
			if _, err := tx.Exec(`ALTER TABLE a2a_idempotency ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''`); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("migration 029 a2a idempotency hash: %w", err)
			}
		}
		if _, err := tx.Exec(`PRAGMA user_version = 29`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 029: %w", err)
		}
		v = 29
	}

	if v == 29 {
		tx, err := s.db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration 030: %w", err)
		}
		var hasStatus int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('a2a_operations') WHERE name = 'http_status'`).Scan(&hasStatus); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration 030 inspect a2a operation status: %w", err)
		}
		if hasStatus == 0 {
			if _, err := tx.Exec(`ALTER TABLE a2a_operations ADD COLUMN http_status INTEGER NOT NULL DEFAULT 200`); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("migration 030 a2a operation status: %w", err)
			}
		}
		if _, err := tx.Exec(`PRAGMA user_version = 30`); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set user_version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration 030: %w", err)
		}
		v = 30
	}

	return nil
}
