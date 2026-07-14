package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Agent      string   `json:"agent"`
	Cwd        string   `json:"cwd"`
	Prompt     string   `json:"prompt"`
	Model      *string  `json:"model,omitempty"`
	SessionRef *string  `json:"session_ref,omitempty"`
	Status     string   `json:"status"`
	ExitCode   *int     `json:"exit_code,omitempty"`
	TokensIn   int      `json:"tokens_in"`
	TokensOut  int      `json:"tokens_out"`
	CostUSD    *float64 `json:"cost_usd,omitempty"`
	CreatedAt  int64    `json:"created_at"`
	StartedAt  *int64   `json:"started_at,omitempty"`
	FinishedAt *int64   `json:"finished_at,omitempty"`
}

// Event is a row in the events table (append-only).
type Event struct {
	TaskID  string          `json:"task_id"`
	Seq     int             `json:"seq"`
	TS      int64           `json:"ts"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
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
	if err := scanner.Scan(
		&t.ID, &t.Title, &t.Agent, &t.Cwd, &t.Prompt,
		&model, &sessionRef, &t.Status,
		&exitCode, &t.TokensIn, &t.TokensOut, &costUSD,
		&t.CreatedAt, &startedAt, &finishedAt,
	); err != nil {
		return Task{}, err
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

const taskColumns = `id, title, agent, cwd, prompt, model, session_ref, status,
		       exit_code, tokens_in, tokens_out, cost_usd,
		       created_at, started_at, finished_at`

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
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO tasks (
			id, title, agent, cwd, prompt, model, session_ref, status,
			exit_code, tokens_in, tokens_out, cost_usd,
			created_at, started_at, finished_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.Title, t.Agent, t.Cwd, t.Prompt, model, sessionRef, t.Status,
		t.ExitCode, t.TokensIn, t.TokensOut, t.CostUSD,
		t.CreatedAt, t.StartedAt, t.FinishedAt,
	)
	if err != nil {
		return fmt.Errorf("insert task: %w", err)
	}
	return nil
}

// TaskPatch is a partial update applied by the engine.
type TaskPatch struct {
	Status          *string
	SessionRef      *string
	Prompt          *string
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
	if p.SessionRef != nil {
		sets = append(sets, "session_ref = ?")
		args = append(args, *p.SessionRef)
	}
	if p.Prompt != nil {
		sets = append(sets, "prompt = ?")
		args = append(args, *p.Prompt)
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

	var maxSeq sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT MAX(seq) FROM events WHERE task_id = ?`, taskID,
	).Scan(&maxSeq); err != nil {
		return Event{}, fmt.Errorf("max seq: %w", err)
	}
	seq := 1
	if maxSeq.Valid {
		seq = int(maxSeq.Int64) + 1
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
	Date       string   `json:"date"` // YYYY-MM-DD (UTC)
	Agent      string   `json:"agent"`
	Tasks      int      `json:"tasks"`
	TokensIn   int64    `json:"tokens_in"`
	TokensOut  int64    `json:"tokens_out"`
	CostUSD    *float64 `json:"cost_usd"` // nil if all costs null
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
		SELECT
			strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
			agent,
			COUNT(*) AS tasks,
			COALESCE(SUM(tokens_in), 0) AS tokens_in,
			COALESCE(SUM(tokens_out), 0) AS tokens_out,
			SUM(cost_usd) AS cost_usd,
			SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS cost_n
		FROM tasks
		WHERE created_at >= ?
		GROUP BY day, agent
		ORDER BY day DESC, agent ASC`, startMS)
	if err != nil {
		return nil, fmt.Errorf("usage summary: %w", err)
	}
	defer rows.Close()

	out := make([]UsageRow, 0)
	for rows.Next() {
		var r UsageRow
		var cost sql.NullFloat64
		var costN int
		if err := rows.Scan(&r.Date, &r.Agent, &r.Tasks, &r.TokensIn, &r.TokensOut, &cost, &costN); err != nil {
			return nil, fmt.Errorf("scan usage: %w", err)
		}
		if cost.Valid && costN > 0 {
			v := cost.Float64
			r.CostUSD = &v
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

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
