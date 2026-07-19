package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// Store is the SQLite persistence layer.
type Store struct {
	db *sql.DB
}

// Open opens (or creates) the database at path and applies pending migrations.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite allows one writer; serialize via a single connection.
	db.SetMaxOpenConns(1)
	// Single-writer friendly settings for a local daemon.
	if _, err := db.Exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("pragma: %w", err)
	}

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the underlying database.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// DB returns the underlying *sql.DB (for tests / later packages).
func (s *Store) DB() *sql.DB { return s.db }

// Task is a row in the tasks table.
type Task struct {
	ID             string   `json:"id"`
	Title          string   `json:"title"`
	Agent          string   `json:"agent"`
	Cwd            string   `json:"cwd"`
	Prompt         string   `json:"prompt"`
	Model          *string  `json:"model,omitempty"`
	SessionRef     *string  `json:"session_ref,omitempty"`
	PermissionMode string   `json:"permission_mode,omitempty"`
	Status         string   `json:"status"`
	ExitCode       *int     `json:"exit_code,omitempty"`
	TokensIn       int      `json:"tokens_in"`
	TokensOut      int      `json:"tokens_out"`
	CostUSD        *float64 `json:"cost_usd,omitempty"`
	CreatedAt      int64    `json:"created_at"`
	StartedAt      *int64   `json:"started_at,omitempty"`
	FinishedAt     *int64   `json:"finished_at,omitempty"`

	// Workspace isolation (ADR 0005). Cwd remains user-selected project path.
	WorkspaceMode       string `json:"workspace_mode"`
	WorkspaceSourceRoot string `json:"workspace_source_root,omitempty"`
	WorkspaceRoot       string `json:"workspace_root,omitempty"`
	ExecutionCwd        string `json:"execution_cwd,omitempty"`
	WorkspaceScope      string `json:"workspace_scope,omitempty"`
	WorkspaceBaseOID    string `json:"workspace_base_oid,omitempty"`
	WorkspaceBranch     string `json:"workspace_branch,omitempty"`
}

// EffectiveCwd returns the path adapters and workspace file APIs should use.
func (t Task) EffectiveCwd() string {
	if strings.TrimSpace(t.ExecutionCwd) != "" {
		return t.ExecutionCwd
	}
	return t.Cwd
}

// Event is a row in the events table (append-only).
type Event struct {
	TaskID  string          `json:"task_id"`
	Seq     int             `json:"seq"`
	TS      int64           `json:"ts"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

const (
	// CacheStatusReported means the provider explicitly supplied cache token data.
	CacheStatusReported = "reported"
	// CacheStatusUnknown means the provider response did not establish cache state.
	CacheStatusUnknown = "unknown"
	// CacheStatusUnsupported means the provider cannot report cache token data.
	CacheStatusUnsupported = "unsupported"
	// CacheStatusMixed means an aggregate contains more than one cache status.
	CacheStatusMixed = "mixed"
)

const (
	// InputSemanticsTotalIncludesCache means input_tokens includes cache reads.
	InputSemanticsTotalIncludesCache = "total_includes_cache"
	// InputSemanticsUncachedOnly means input_tokens excludes cache reads/writes.
	InputSemanticsUncachedOnly = "uncached_only"
	// InputSemanticsUnknown means the adapter could not establish input semantics.
	InputSemanticsUnknown = "unknown"
)

const (
	// CostSourceProvider is a provider-reported cost.
	CostSourceProvider = "provider"
	// CostSourcePriceTable is a local price-table estimate.
	CostSourcePriceTable = "price_table"
	// CostSourceUnknown means cost was not available.
	CostSourceUnknown = "unknown"
)

// UsageRecord is one provider or agent usage observation keyed to its task event.
// Nil token and cost fields represent values the source did not report.
type UsageRecord struct {
	TaskID                string   `json:"task_id"`
	EventSeq              int      `json:"event_seq"`
	OccurredAt            int64    `json:"occurred_at"`
	Agent                 string   `json:"agent"`
	Provider              *string  `json:"provider,omitempty"`
	Model                 *string  `json:"model,omitempty"`
	InputTokens           *int     `json:"input_tokens,omitempty"`
	OutputTokens          *int     `json:"output_tokens,omitempty"`
	ReasoningOutputTokens *int     `json:"reasoning_output_tokens,omitempty"`
	CacheReadTokens       *int     `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens      *int     `json:"cache_write_tokens,omitempty"`
	CostUSD               *float64 `json:"cost_usd,omitempty"`
	CostSource            string   `json:"cost_source"`
	CacheStatus           string   `json:"cache_status"`
	InputSemantics        string   `json:"input_semantics"`
}

func (r UsageRecord) validate() error {
	if strings.TrimSpace(r.TaskID) == "" {
		return fmt.Errorf("usage record task_id is required")
	}
	if r.EventSeq < 1 {
		return fmt.Errorf("usage record event_seq must be >= 1")
	}
	if r.OccurredAt <= 0 {
		return fmt.Errorf("usage record occurred_at must be > 0")
	}
	if strings.TrimSpace(r.Agent) == "" {
		return fmt.Errorf("usage record agent is required")
	}
	for _, field := range []struct {
		name  string
		value *int
	}{
		{"input_tokens", r.InputTokens},
		{"output_tokens", r.OutputTokens},
		{"reasoning_output_tokens", r.ReasoningOutputTokens},
		{"cache_read_tokens", r.CacheReadTokens},
		{"cache_write_tokens", r.CacheWriteTokens},
	} {
		if field.value != nil && *field.value < 0 {
			return fmt.Errorf("usage record %s must be >= 0", field.name)
		}
	}
	if r.CostUSD != nil && *r.CostUSD < 0 {
		return fmt.Errorf("usage record cost_usd must be >= 0")
	}
	if !validUsageEnum(r.CostSource, CostSourceProvider, CostSourcePriceTable, CostSourceUnknown) {
		return fmt.Errorf("invalid usage record cost_source %q", r.CostSource)
	}
	if !validUsageEnum(r.CacheStatus, CacheStatusReported, CacheStatusUnknown, CacheStatusUnsupported) {
		return fmt.Errorf("invalid usage record cache_status %q", r.CacheStatus)
	}
	if !validUsageEnum(r.InputSemantics, InputSemanticsTotalIncludesCache, InputSemanticsUncachedOnly, InputSemanticsUnknown) {
		return fmt.Errorf("invalid usage record input_semantics %q", r.InputSemantics)
	}
	return nil
}

func validUsageEnum(value string, values ...string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

// ListTasksOpts filters for ListTasks.
type ListTasksOpts struct {
	Status string // empty = all
	Limit  int    // 0 = default 50
	Before string // ULID cursor: only tasks with id < before
}

func scanTask(scanner interface {
	Scan(dest ...any) error
}) (Task, error) {
	var t Task
	var model, sessionRef sql.NullString
	var exitCode sql.NullInt64
	var costUSD sql.NullFloat64
	var startedAt, finishedAt sql.NullInt64
	var permissionMode sql.NullString
	var workspaceMode, sourceRoot, workspaceRoot, executionCwd sql.NullString
	var workspaceScope, baseOID, branch sql.NullString
	if err := scanner.Scan(
		&t.ID, &t.Title, &t.Agent, &t.Cwd, &t.Prompt,
		&model, &sessionRef, &permissionMode, &t.Status,
		&exitCode, &t.TokensIn, &t.TokensOut, &costUSD,
		&t.CreatedAt, &startedAt, &finishedAt,
		&workspaceMode, &sourceRoot, &workspaceRoot, &executionCwd,
		&workspaceScope, &baseOID, &branch,
	); err != nil {
		return Task{}, err
	}
	if permissionMode.Valid && permissionMode.String != "" {
		t.PermissionMode = permissionMode.String
	} else {
		t.PermissionMode = "default"
	}
	if workspaceMode.Valid && workspaceMode.String != "" {
		t.WorkspaceMode = workspaceMode.String
	} else {
		t.WorkspaceMode = "shared"
	}
	if sourceRoot.Valid {
		t.WorkspaceSourceRoot = sourceRoot.String
	}
	if workspaceRoot.Valid {
		t.WorkspaceRoot = workspaceRoot.String
	}
	if executionCwd.Valid {
		t.ExecutionCwd = executionCwd.String
	}
	if workspaceScope.Valid && workspaceScope.String != "" {
		t.WorkspaceScope = workspaceScope.String
	} else {
		t.WorkspaceScope = "."
	}
	if baseOID.Valid {
		t.WorkspaceBaseOID = baseOID.String
	}
	if branch.Valid {
		t.WorkspaceBranch = branch.String
	}
	if model.Valid {
		t.Model = &model.String
	}
	if sessionRef.Valid {
		t.SessionRef = &sessionRef.String
	}
	if exitCode.Valid {
		v := int(exitCode.Int64)
		t.ExitCode = &v
	}
	if costUSD.Valid {
		t.CostUSD = &costUSD.Float64
	}
	if startedAt.Valid {
		t.StartedAt = &startedAt.Int64
	}
	if finishedAt.Valid {
		t.FinishedAt = &finishedAt.Int64
	}
	return t, nil
}

const taskColumns = `id, title, agent, cwd, prompt, model, session_ref, permission_mode, status, exit_code, tokens_in, tokens_out, cost_usd, created_at, started_at, finished_at, workspace_mode, workspace_source_root, workspace_root, execution_cwd, workspace_scope, workspace_base_oid, workspace_branch`

// ListTasks returns tasks ordered by id descending (ULID ≈ time).
func (s *Store) ListTasks(ctx context.Context, opts ListTasksOpts) ([]Task, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	var b strings.Builder
	args := make([]any, 0, 4)
	b.WriteString(`SELECT ` + taskColumns + ` FROM tasks WHERE 1=1`)
	if opts.Status != "" {
		b.WriteString(` AND status = ?`)
		args = append(args, opts.Status)
	}
	if opts.Before != "" {
		b.WriteString(` AND id < ?`)
		args = append(args, opts.Before)
	}
	b.WriteString(` ORDER BY id DESC LIMIT ?`)
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	defer rows.Close()

	out := make([]Task, 0)
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// GetTask returns a single task by id.
func (s *Store) GetTask(ctx context.Context, id string) (Task, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM tasks WHERE id = ?`, id)
	t, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, ErrNotFound
	}
	if err != nil {
		return Task{}, fmt.Errorf("get task: %w", err)
	}
	return t, nil
}

// InsertTask inserts a new task row. Status should be "queued".
func (s *Store) InsertTask(ctx context.Context, t Task) error {
	var model, sessionRef any
	if t.Model != nil {
		model = *t.Model
	}
	if t.SessionRef != nil {
		sessionRef = *t.SessionRef
	}
	perm := t.PermissionMode
	if perm == "" {
		perm = "default"
	}
	wsMode := t.WorkspaceMode
	if wsMode == "" {
		wsMode = "shared"
	}
	wsScope := t.WorkspaceScope
	if wsScope == "" {
		wsScope = "."
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO tasks (
			id, title, agent, cwd, prompt, model, session_ref, permission_mode, status,
			exit_code, tokens_in, tokens_out, cost_usd,
			created_at, started_at, finished_at,
			workspace_mode, workspace_source_root, workspace_root, execution_cwd,
			workspace_scope, workspace_base_oid, workspace_branch
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		t.ID, t.Title, t.Agent, t.Cwd, t.Prompt, model, sessionRef, perm, t.Status,
		t.ExitCode, t.TokensIn, t.TokensOut, t.CostUSD,
		t.CreatedAt, t.StartedAt, t.FinishedAt,
		wsMode, t.WorkspaceSourceRoot, t.WorkspaceRoot, t.ExecutionCwd,
		wsScope, t.WorkspaceBaseOID, t.WorkspaceBranch,
	)
	if err != nil {
		return fmt.Errorf("insert task: %w", err)
	}
	return nil
}

// TaskPatch is a partial update applied by the engine.
type TaskPatch struct {
	Status          *string
	Title           *string
	Agent           *string
	SessionRef      *string
	ClearSessionRef bool // sets session_ref NULL (handoff across agents)
	Prompt          *string
	PermissionMode  *string
	ExitCode        *int
	ClearExitCode   bool
	TokensIn        *int
	TokensOut       *int
	CostUSD         *float64
	StartedAt       *int64
	FinishedAt      *int64
	ClearFinishedAt bool
}

// UpdateTask applies a patch to a task row.
func (s *Store) UpdateTask(ctx context.Context, id string, p TaskPatch) error {
	// Build dynamic SET; always require at least one field.
	sets := make([]string, 0, 12)
	args := make([]any, 0, 13)
	if p.Status != nil {
		sets = append(sets, "status = ?")
		args = append(args, *p.Status)
	}
	if p.Title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *p.Title)
	}
	if p.Agent != nil {
		sets = append(sets, "agent = ?")
		args = append(args, *p.Agent)
	}
	if p.ClearSessionRef {
		sets = append(sets, "session_ref = NULL")
	} else if p.SessionRef != nil {
		sets = append(sets, "session_ref = ?")
		args = append(args, *p.SessionRef)
	}
	if p.Prompt != nil {
		sets = append(sets, "prompt = ?")
		args = append(args, *p.Prompt)
	}
	if p.PermissionMode != nil {
		sets = append(sets, "permission_mode = ?")
		args = append(args, *p.PermissionMode)
	}
	if p.ClearExitCode {
		sets = append(sets, "exit_code = NULL")
	} else if p.ExitCode != nil {
		sets = append(sets, "exit_code = ?")
		args = append(args, *p.ExitCode)
	}
	if p.TokensIn != nil {
		sets = append(sets, "tokens_in = ?")
		args = append(args, *p.TokensIn)
	}
	if p.TokensOut != nil {
		sets = append(sets, "tokens_out = ?")
		args = append(args, *p.TokensOut)
	}
	if p.CostUSD != nil {
		sets = append(sets, "cost_usd = ?")
		args = append(args, *p.CostUSD)
	}
	if p.StartedAt != nil {
		sets = append(sets, "started_at = ?")
		args = append(args, *p.StartedAt)
	}
	if p.ClearFinishedAt {
		sets = append(sets, "finished_at = NULL")
	} else if p.FinishedAt != nil {
		sets = append(sets, "finished_at = ?")
		args = append(args, *p.FinishedAt)
	}
	if len(sets) == 0 {
		return nil
	}
	args = append(args, id)
	q := `UPDATE tasks SET ` + strings.Join(sets, ", ") + ` WHERE id = ?`
	res, err := s.db.ExecContext(ctx, q, args...)
	if err != nil {
		return fmt.Errorf("update task: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// AppendEvent inserts the next event for a task (monotonically increasing seq).
// Returns the stored event. Must be called before any WS broadcast (spec §3).
func (s *Store) AppendEvent(ctx context.Context, taskID, typ string, payload json.RawMessage) (Event, error) {
	if payload == nil {
		payload = json.RawMessage(`{}`)
	}
	ts := time.Now().UnixMilli()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Event{}, fmt.Errorf("begin event tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	seq, err := nextEventSeq(ctx, tx, taskID)
	if err != nil {
		return Event{}, err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO events (task_id, seq, ts, type, payload)
		VALUES (?, ?, ?, ?, ?)`,
		taskID, seq, ts, typ, string(payload),
	); err != nil {
		return Event{}, fmt.Errorf("insert event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Event{}, fmt.Errorf("commit event: %w", err)
	}
	return Event{
		TaskID:  taskID,
		Seq:     seq,
		TS:      ts,
		Type:    typ,
		Payload: payload,
	}, nil
}

// AppendUsageEvent persists a usage event, its normalized ledger row, and the
// compatible task token/cost summary in one transaction.
func (s *Store) AppendUsageEvent(ctx context.Context, taskID, typ string, payload json.RawMessage, record UsageRecord) (Event, Task, error) {
	if payload == nil {
		payload = json.RawMessage(`{}`)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Event{}, Task{}, fmt.Errorf("begin usage event tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	seq, err := nextEventSeq(ctx, tx, taskID)
	if err != nil {
		return Event{}, Task{}, err
	}
	ts := time.Now().UnixMilli()
	record.TaskID = taskID
	record.EventSeq = seq
	record.OccurredAt = ts
	if err := record.validate(); err != nil {
		return Event{}, Task{}, err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO events (task_id, seq, ts, type, payload)
		VALUES (?, ?, ?, ?, ?)`,
		taskID, seq, ts, typ, string(payload),
	); err != nil {
		return Event{}, Task{}, fmt.Errorf("insert usage event: %w", err)
	}
	if err := insertUsageRecord(ctx, tx, record); err != nil {
		return Event{}, Task{}, err
	}

	input := logicalUsageInput(record)
	output := intValueOrZero(record.OutputTokens)
	result, err := tx.ExecContext(ctx, `
		UPDATE tasks
		SET tokens_in = tokens_in + ?,
		    tokens_out = tokens_out + ?,
		    cost_usd = CASE
		      WHEN ? IS NULL THEN cost_usd
		      ELSE COALESCE(cost_usd, 0) + ?
		    END
		WHERE id = ?`,
		input, output, record.CostUSD, record.CostUSD, taskID,
	)
	if err != nil {
		return Event{}, Task{}, fmt.Errorf("update task usage summary: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return Event{}, Task{}, ErrNotFound
	}

	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM tasks WHERE id = ?`, taskID))
	if err != nil {
		return Event{}, Task{}, fmt.Errorf("read task usage summary: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Event{}, Task{}, fmt.Errorf("commit usage event: %w", err)
	}
	event := Event{TaskID: taskID, Seq: seq, TS: ts, Type: typ, Payload: payload}
	return event, task, nil
}

func nextEventSeq(ctx context.Context, tx *sql.Tx, taskID string) (int, error) {
	var maxSeq sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT MAX(seq) FROM (
			SELECT seq FROM events WHERE task_id = ?
			UNION ALL
			SELECT event_seq AS seq FROM usage_records WHERE task_id = ?
		)`, taskID, taskID).Scan(&maxSeq); err != nil {
		return 0, fmt.Errorf("max seq: %w", err)
	}
	if !maxSeq.Valid {
		return 1, nil
	}
	return int(maxSeq.Int64) + 1, nil
}

func logicalUsageInput(record UsageRecord) int {
	input := intValueOrZero(record.InputTokens)
	if record.InputSemantics == InputSemanticsUncachedOnly {
		input += intValueOrZero(record.CacheReadTokens) + intValueOrZero(record.CacheWriteTokens)
	}
	return input
}

func intValueOrZero(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

// InsertUsageRecord persists one normalized usage observation. The task event
// identified by (task_id, event_seq) is its stable idempotency key.
func (s *Store) InsertUsageRecord(ctx context.Context, r UsageRecord) error {
	if err := r.validate(); err != nil {
		return err
	}
	return insertUsageRecord(ctx, s.db, r)
}

type usageRecordExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func insertUsageRecord(ctx context.Context, exec usageRecordExecer, r UsageRecord) error {
	_, err := exec.ExecContext(ctx, `
		INSERT INTO usage_records (
			task_id, event_seq, occurred_at, agent, provider, model,
			input_tokens, output_tokens, reasoning_output_tokens,
			cache_read_tokens, cache_write_tokens, cost_usd,
			cost_source, cache_status, input_semantics
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.TaskID, r.EventSeq, r.OccurredAt, r.Agent, r.Provider, r.Model,
		r.InputTokens, r.OutputTokens, r.ReasoningOutputTokens,
		r.CacheReadTokens, r.CacheWriteTokens, r.CostUSD,
		r.CostSource, r.CacheStatus, r.InputSemantics,
	)
	if err != nil {
		return fmt.Errorf("insert usage record: %w", err)
	}
	return nil
}

// ListUsageRecords returns task usage observations in event order.
func (s *Store) ListUsageRecords(ctx context.Context, taskID string) ([]UsageRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT task_id, event_seq, occurred_at, agent, provider, model,
		       input_tokens, output_tokens, reasoning_output_tokens,
		       cache_read_tokens, cache_write_tokens, cost_usd,
		       cost_source, cache_status, input_semantics
		FROM usage_records
		WHERE task_id = ?
		ORDER BY event_seq ASC`, taskID)
	if err != nil {
		return nil, fmt.Errorf("list usage records: %w", err)
	}
	defer rows.Close()

	records := make([]UsageRecord, 0)
	for rows.Next() {
		var r UsageRecord
		var provider, model sql.NullString
		var input, output, reasoning, cacheRead, cacheWrite sql.NullInt64
		var cost sql.NullFloat64
		if err := rows.Scan(
			&r.TaskID, &r.EventSeq, &r.OccurredAt, &r.Agent, &provider, &model,
			&input, &output, &reasoning, &cacheRead, &cacheWrite, &cost,
			&r.CostSource, &r.CacheStatus, &r.InputSemantics,
		); err != nil {
			return nil, fmt.Errorf("scan usage record: %w", err)
		}
		if provider.Valid {
			r.Provider = &provider.String
		}
		if model.Valid {
			r.Model = &model.String
		}
		r.InputTokens = nullableInt(input)
		r.OutputTokens = nullableInt(output)
		r.ReasoningOutputTokens = nullableInt(reasoning)
		r.CacheReadTokens = nullableInt(cacheRead)
		r.CacheWriteTokens = nullableInt(cacheWrite)
		if cost.Valid {
			v := cost.Float64
			r.CostUSD = &v
		}
		records = append(records, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

func nullableInt(v sql.NullInt64) *int {
	if !v.Valid {
		return nil
	}
	i := int(v.Int64)
	return &i
}

// ListEvents returns events for a task with seq > sinceSeq, ordered by seq asc.
func (s *Store) ListEvents(ctx context.Context, taskID string, sinceSeq int) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT task_id, seq, ts, type, payload
		FROM events
		WHERE task_id = ? AND seq > ?
		ORDER BY seq ASC`, taskID, sinceSeq)
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	defer rows.Close()

	out := make([]Event, 0)
	for rows.Next() {
		var e Event
		var payload string
		if err := rows.Scan(&e.TaskID, &e.Seq, &e.TS, &e.Type, &payload); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		e.Payload = json.RawMessage(payload)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// TruncateEventsFrom deletes events with seq >= fromSeq for a task.
// Used by retry (drop a turn and re-run) and similar rewinds.
func (s *Store) TruncateEventsFrom(ctx context.Context, taskID string, fromSeq int) error {
	if fromSeq < 1 {
		return fmt.Errorf("fromSeq must be >= 1")
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM events WHERE task_id = ? AND seq >= ?`, taskID, fromSeq)
	if err != nil {
		return fmt.Errorf("truncate events: %w", err)
	}
	return nil
}

// CopyEventsToTask copies events with seq <= maxSeq from src to dst, renumbering from 1.
// Returns the number of events copied.
func (s *Store) CopyEventsToTask(ctx context.Context, srcID, dstID string, maxSeq int) (int, error) {
	if maxSeq < 1 {
		return 0, fmt.Errorf("maxSeq must be >= 1")
	}
	// Load fully first so we do not hold a query connection open across BeginTx
	// (SQLite single-connection pools would otherwise deadlock).
	type row struct {
		ts      int64
		typ     string
		payload string
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT ts, type, payload
		FROM events
		WHERE task_id = ? AND seq <= ?
		ORDER BY seq ASC`, srcID, maxSeq)
	if err != nil {
		return 0, fmt.Errorf("list events for copy: %w", err)
	}
	var batch []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.ts, &r.typ, &r.payload); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan event for copy: %w", err)
		}
		batch = append(batch, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin copy events: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for i, r := range batch {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO events (task_id, seq, ts, type, payload)
			VALUES (?, ?, ?, ?, ?)`,
			dstID, i+1, r.ts, r.typ, r.payload,
		); err != nil {
			return 0, fmt.Errorf("insert copied event: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit copy events: %w", err)
	}
	return len(batch), nil
}

// FailOrphaned marks queued/running tasks as failed after a daemon restart.
// Returns the IDs that were failed so the caller can append error events.
func (s *Store) FailOrphaned(ctx context.Context) ([]string, error) {
	now := time.Now().UnixMilli()
	rows, err := s.db.QueryContext(ctx, `
		SELECT id FROM tasks WHERE status IN ('queued', 'running', 'waiting_approval')`)
	if err != nil {
		return nil, fmt.Errorf("select orphans: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}

	for _, id := range ids {
		if _, err := s.db.ExecContext(ctx, `
			UPDATE tasks SET status = 'failed', finished_at = ?
			WHERE id = ? AND status IN ('queued', 'running', 'waiting_approval')`,
			now, id,
		); err != nil {
			return nil, fmt.Errorf("fail orphan %s: %w", id, err)
		}
	}
	return ids, nil
}

// RecentCwds returns distinct cwd values from recent tasks (most recent first).
func (s *Store) RecentCwds(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 10
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT cwd FROM (
			SELECT cwd, MAX(created_at) AS last_used
			FROM tasks
			GROUP BY cwd
			ORDER BY last_used DESC
			LIMIT ?
		)`, limit)
	if err != nil {
		return nil, fmt.Errorf("recent cwds: %w", err)
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var cwd string
		if err := rows.Scan(&cwd); err != nil {
			return nil, err
		}
		out = append(out, cwd)
	}
	return out, rows.Err()
}

// GetSetting reads a settings key.
func (s *Store) GetSetting(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return v, nil
}

// SetSetting upserts a settings key.
func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// UsageRow is one day × agent aggregate for GET /api/usage/summary (M4).
type UsageRow struct {
	Date  string `json:"date"` // YYYY-MM-DD (UTC)
	Agent string `json:"agent"`
	Tasks int    `json:"tasks"`
	UsageTotals
}

// UsageModelSubtotal is a task usage subtotal grouped by model.
type UsageModelSubtotal struct {
	Model string `json:"model"`
	UsageTotals
}

// UsageCostSourceSubtotal is a task usage subtotal grouped by cost source.
type UsageCostSourceSubtotal struct {
	CostSource string `json:"cost_source"`
	UsageTotals
}

// UsageTotals is the shared token, cache, cost, and coverage shape used by
// task subtotals and task-level usage responses.
type UsageTotals struct {
	TokensIn                 int64    `json:"tokens_in"`
	TokensOut                int64    `json:"tokens_out"`
	CostUSD                  *float64 `json:"cost_usd"`
	RequestCount             int      `json:"request_count"`
	ReasoningOutputTokens    int64    `json:"reasoning_output_tokens"`
	CacheReadTokens          int64    `json:"cache_read_tokens"`
	CacheWriteTokens         int64    `json:"cache_write_tokens"`
	CacheEligibleInputTokens int64    `json:"cache_eligible_input_tokens"`
	CacheHitRate             *float64 `json:"cache_hit_rate"`
	CacheCoverage            *float64 `json:"cache_coverage"`
	CacheStatus              string   `json:"cache_status"`
}

// TaskUsage is the cache-aware usage view for one task.
type TaskUsage struct {
	TaskID string `json:"task_id"`
	UsageTotals
	ModelSubtotals      []UsageModelSubtotal      `json:"model_subtotals"`
	CostSourceSubtotals []UsageCostSourceSubtotal `json:"cost_source_subtotals"`
}

// UsageSummary returns per-day, per-agent aggregates over the last `days` days (UTC).
// days defaults to 30 when <= 0; capped at 366.
func (s *Store) UsageSummary(ctx context.Context, days int) ([]UsageRow, error) {
	if days <= 0 {
		days = 30
	}
	if days > 366 {
		days = 366
	}
	// Inclusive window: start of (today - (days-1)) UTC in unix ms.
	now := time.Now().UTC()
	startDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).
		AddDate(0, 0, -(days - 1))
	startMS := startDay.UnixMilli()

	rows, err := s.db.QueryContext(ctx, `
		SELECT task_id, event_seq, occurred_at, agent, provider, model,
	       input_tokens, output_tokens, reasoning_output_tokens,
	       cache_read_tokens, cache_write_tokens, cost_usd,
	       cost_source, cache_status, input_semantics
		FROM usage_records WHERE occurred_at >= ?`, startMS)
	if err != nil {
		return nil, fmt.Errorf("usage summary: %w", err)
	}
	defer rows.Close()
	type aggregateKey struct{ date, agent string }
	aggregates := map[aggregateKey]*usageAccumulator{}
	tasksByKey := map[aggregateKey]map[string]struct{}{}
	for rows.Next() {
		r, err := scanUsageRecord(rows)
		if err != nil {
			return nil, fmt.Errorf("scan usage: %w", err)
		}
		key := aggregateKey{date: usageDate(r.OccurredAt), agent: r.Agent}
		if aggregates[key] == nil {
			aggregates[key] = &usageAccumulator{}
			tasksByKey[key] = map[string]struct{}{}
		}
		aggregates[key].addRecord(r)
		tasksByKey[key][r.TaskID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close usage summary rows: %w", err)
	}

	// Tasks without ledger rows retain their historical task totals. Their cache
	// state is unknown, rather than a misleading reported zero.
	legacyRows, err := s.db.QueryContext(ctx, `
		SELECT t.id, t.agent, t.tokens_in, t.tokens_out, t.cost_usd, t.created_at
		FROM tasks t
		WHERE t.created_at >= ?
		  AND NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.task_id = t.id)`, startMS)
	if err != nil {
		return nil, fmt.Errorf("usage summary legacy tasks: %w", err)
	}
	defer legacyRows.Close()
	for legacyRows.Next() {
		var id, agent string
		var in, out int64
		var cost sql.NullFloat64
		var created int64
		if err := legacyRows.Scan(&id, &agent, &in, &out, &cost, &created); err != nil {
			return nil, fmt.Errorf("scan legacy usage task: %w", err)
		}
		key := aggregateKey{date: usageDate(created), agent: agent}
		if aggregates[key] == nil {
			aggregates[key] = &usageAccumulator{}
			tasksByKey[key] = map[string]struct{}{}
		}
		aggregates[key].addLegacy(in, out, nullableFloat(cost))
		tasksByKey[key][id] = struct{}{}
	}
	if err := legacyRows.Err(); err != nil {
		return nil, err
	}

	out := make([]UsageRow, 0, len(aggregates))
	for key, aggregate := range aggregates {
		totals := aggregate.totals()
		out = append(out, UsageRow{Date: key.date, Agent: key.agent, Tasks: len(tasksByKey[key]), UsageTotals: totals})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Date == out[j].Date {
			return out[i].Agent < out[j].Agent
		}
		return out[i].Date > out[j].Date
	})
	return out, nil
}

// TaskUsage returns cache-aware totals and model/cost-source breakdowns for a task.
func (s *Store) TaskUsage(ctx context.Context, taskID string) (TaskUsage, error) {
	task, err := s.GetTask(ctx, taskID)
	if err != nil {
		return TaskUsage{}, err
	}
	records, err := s.ListUsageRecords(ctx, taskID)
	if err != nil {
		return TaskUsage{}, err
	}
	if len(records) == 0 {
		a := usageAccumulator{}
		a.addLegacy(int64(task.TokensIn), int64(task.TokensOut), task.CostUSD)
		return TaskUsage{TaskID: taskID, UsageTotals: a.totals(), ModelSubtotals: []UsageModelSubtotal{}, CostSourceSubtotals: []UsageCostSourceSubtotal{}}, nil
	}
	total := usageAccumulator{}
	byModel := map[string]*usageAccumulator{}
	byCost := map[string]*usageAccumulator{}
	for _, record := range records {
		total.addRecord(record)
		model := "unknown"
		if record.Model != nil && *record.Model != "" {
			model = *record.Model
		}
		if byModel[model] == nil {
			byModel[model] = &usageAccumulator{}
		}
		byModel[model].addRecord(record)
		if byCost[record.CostSource] == nil {
			byCost[record.CostSource] = &usageAccumulator{}
		}
		byCost[record.CostSource].addRecord(record)
	}
	result := TaskUsage{TaskID: taskID, UsageTotals: total.totals(), ModelSubtotals: make([]UsageModelSubtotal, 0, len(byModel)), CostSourceSubtotals: make([]UsageCostSourceSubtotal, 0, len(byCost))}
	for model, subtotal := range byModel {
		result.ModelSubtotals = append(result.ModelSubtotals, UsageModelSubtotal{Model: model, UsageTotals: subtotal.totals()})
	}
	for source, subtotal := range byCost {
		result.CostSourceSubtotals = append(result.CostSourceSubtotals, UsageCostSourceSubtotal{CostSource: source, UsageTotals: subtotal.totals()})
	}
	sort.Slice(result.ModelSubtotals, func(i, j int) bool { return result.ModelSubtotals[i].Model < result.ModelSubtotals[j].Model })
	sort.Slice(result.CostSourceSubtotals, func(i, j int) bool {
		return result.CostSourceSubtotals[i].CostSource < result.CostSourceSubtotals[j].CostSource
	})
	return result, nil
}

type usageAccumulator struct {
	tokensIn, tokensOut, reasoning, cacheRead, cacheWrite  int64
	requests, knownInput, eligibleInput, eligibleCacheRead int64
	cost                                                   float64
	costCount                                              int
	statuses                                               map[string]struct{}
}

func (a *usageAccumulator) addRecord(r UsageRecord) {
	a.tokensIn += int64(logicalUsageInput(r))
	a.tokensOut += int64(intValueOrZero(r.OutputTokens))
	a.reasoning += int64(intValueOrZero(r.ReasoningOutputTokens))
	a.cacheRead += int64(intValueOrZero(r.CacheReadTokens))
	a.cacheWrite += int64(intValueOrZero(r.CacheWriteTokens))
	a.requests++
	if r.InputTokens != nil {
		a.knownInput += int64(logicalUsageInput(r))
		if r.CacheStatus == CacheStatusReported && r.InputSemantics != InputSemanticsUnknown {
			a.eligibleInput += int64(logicalUsageInput(r))
			a.eligibleCacheRead += int64(intValueOrZero(r.CacheReadTokens))
		}
	}
	if r.CostUSD != nil {
		a.cost += *r.CostUSD
		a.costCount++
	}
	if a.statuses == nil {
		a.statuses = map[string]struct{}{}
	}
	a.statuses[r.CacheStatus] = struct{}{}
}

func (a *usageAccumulator) addLegacy(input, output int64, cost *float64) {
	a.tokensIn += input
	a.tokensOut += output
	a.knownInput += input
	if cost != nil {
		a.cost += *cost
		a.costCount++
	}
	if a.statuses == nil {
		a.statuses = map[string]struct{}{}
	}
	a.statuses[CacheStatusUnknown] = struct{}{}
}

func (a *usageAccumulator) totals() UsageTotals {
	t := UsageTotals{
		TokensIn: a.tokensIn, TokensOut: a.tokensOut, RequestCount: int(a.requests),
		ReasoningOutputTokens: a.reasoning, CacheReadTokens: a.cacheRead, CacheWriteTokens: a.cacheWrite,
		CacheEligibleInputTokens: a.eligibleInput, CacheStatus: aggregateCacheStatus(a.statuses),
	}
	if a.costCount > 0 {
		cost := a.cost
		t.CostUSD = &cost
	}
	if a.eligibleInput > 0 {
		rate := float64(a.eligibleCacheRead) / float64(a.eligibleInput)
		t.CacheHitRate = &rate
	}
	if a.knownInput > 0 {
		coverage := float64(a.eligibleInput) / float64(a.knownInput)
		t.CacheCoverage = &coverage
	}
	return t
}

func aggregateCacheStatus(statuses map[string]struct{}) string {
	if len(statuses) == 0 {
		return CacheStatusUnknown
	}
	if len(statuses) > 1 {
		return CacheStatusMixed
	}
	for status := range statuses {
		return status
	}
	return CacheStatusUnknown
}

func scanUsageRecord(scanner interface{ Scan(...any) error }) (UsageRecord, error) {
	var r UsageRecord
	var provider, model sql.NullString
	var input, output, reasoning, cacheRead, cacheWrite sql.NullInt64
	var cost sql.NullFloat64
	if err := scanner.Scan(
		&r.TaskID, &r.EventSeq, &r.OccurredAt, &r.Agent, &provider, &model,
		&input, &output, &reasoning, &cacheRead, &cacheWrite, &cost,
		&r.CostSource, &r.CacheStatus, &r.InputSemantics,
	); err != nil {
		return UsageRecord{}, err
	}
	if provider.Valid {
		r.Provider = &provider.String
	}
	if model.Valid {
		r.Model = &model.String
	}
	r.InputTokens = nullableInt(input)
	r.OutputTokens = nullableInt(output)
	r.ReasoningOutputTokens = nullableInt(reasoning)
	r.CacheReadTokens = nullableInt(cacheRead)
	r.CacheWriteTokens = nullableInt(cacheWrite)
	r.CostUSD = nullableFloat(cost)
	return r, nil
}

func nullableFloat(v sql.NullFloat64) *float64 {
	if !v.Valid {
		return nil
	}
	f := v.Float64
	return &f
}

func usageDate(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02") }

// LoadPriceTable returns the configured price table, or the default if unset/invalid.
func (s *Store) LoadPriceTable(ctx context.Context) PriceTable {
	raw, err := s.GetSetting(ctx, KeyPriceTable)
	if err != nil || strings.TrimSpace(raw) == "" {
		return DefaultPriceTable()
	}
	t, err := ParsePriceTable(raw)
	if err != nil {
		return DefaultPriceTable()
	}
	return t
}

// NowMilli is a testable clock helper.
func NowMilli() int64 { return time.Now().UnixMilli() }
