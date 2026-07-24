package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// Default circuit breaker: auto-disable after this many consecutive failures.
const RoutineMaxConsecFailures = 3

// Routine is a saved recurring task (ADR 0011).
type Routine struct {
	ID             string `json:"id"`
	ProjectID      string `json:"project_id,omitempty"`
	Cwd            string `json:"cwd"`
	Agent          string `json:"agent"`
	PermissionMode string `json:"permission_mode"`
	Prompt         string `json:"prompt"`
	IntervalSecs   int64  `json:"interval_secs"`
	Enabled        bool   `json:"enabled"`
	LastRunAt      *int64 `json:"last_run_at,omitempty"`
	NextDueAt      int64  `json:"next_due_at"`
	ConsecFailures int    `json:"consec_failures"`
	CreatedAt      int64  `json:"created_at"`
	Title          string `json:"title"`
}

// RoutinePatch is a partial update for routines.
type RoutinePatch struct {
	Title          *string
	ProjectID      *string // empty string clears
	Cwd            *string
	Agent          *string
	PermissionMode *string
	Prompt         *string
	IntervalSecs   *int64
	Enabled        *bool
	LastRunAt      *int64
	ClearLastRunAt bool
	NextDueAt      *int64
	ConsecFailures *int
}

// ListRoutinesOpts filters for ListRoutines.
type ListRoutinesOpts struct {
	ProjectID string // empty = all
	Enabled   *bool  // nil = all
	Limit     int
}

const routineColumns = `id, project_id, cwd, agent, permission_mode, prompt, interval_secs, enabled, last_run_at, next_due_at, consec_failures, created_at, title`

func scanRoutine(scanner interface {
	Scan(dest ...any) error
}) (Routine, error) {
	var r Routine
	var projectID sql.NullString
	var lastRun sql.NullInt64
	var enabled int
	if err := scanner.Scan(
		&r.ID, &projectID, &r.Cwd, &r.Agent, &r.PermissionMode, &r.Prompt,
		&r.IntervalSecs, &enabled, &lastRun, &r.NextDueAt, &r.ConsecFailures,
		&r.CreatedAt, &r.Title,
	); err != nil {
		return Routine{}, err
	}
	if projectID.Valid {
		r.ProjectID = projectID.String
	}
	r.Enabled = enabled != 0
	if lastRun.Valid {
		v := lastRun.Int64
		r.LastRunAt = &v
	}
	if r.PermissionMode == "" {
		r.PermissionMode = "default"
	}
	return r, nil
}

// InsertRoutine creates a routine row.
func (s *Store) InsertRoutine(ctx context.Context, r Routine) error {
	if strings.TrimSpace(r.ID) == "" {
		return fmt.Errorf("routine id is required")
	}
	if strings.TrimSpace(r.Cwd) == "" {
		return fmt.Errorf("routine cwd is required")
	}
	if strings.TrimSpace(r.Prompt) == "" {
		return fmt.Errorf("routine prompt is required")
	}
	if r.IntervalSecs <= 0 {
		return fmt.Errorf("routine interval_secs must be > 0")
	}
	if r.Agent == "" {
		r.Agent = "kin"
	}
	if r.PermissionMode == "" {
		r.PermissionMode = "default"
	}
	if r.CreatedAt == 0 {
		r.CreatedAt = time.Now().UnixMilli()
	}
	if r.NextDueAt == 0 {
		r.NextDueAt = r.CreatedAt
	}
	enabled := 0
	if r.Enabled {
		enabled = 1
	}
	var projectID any
	if r.ProjectID != "" {
		projectID = r.ProjectID
	}
	var lastRun any
	if r.LastRunAt != nil {
		lastRun = *r.LastRunAt
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO routines (
			id, project_id, cwd, agent, permission_mode, prompt, interval_secs,
			enabled, last_run_at, next_due_at, consec_failures, created_at, title
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, projectID, r.Cwd, r.Agent, r.PermissionMode, r.Prompt, r.IntervalSecs,
		enabled, lastRun, r.NextDueAt, r.ConsecFailures, r.CreatedAt, r.Title,
	)
	if err != nil {
		return fmt.Errorf("insert routine: %w", err)
	}
	return nil
}

// GetRoutine returns a routine by id.
func (s *Store) GetRoutine(ctx context.Context, id string) (Routine, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+routineColumns+` FROM routines WHERE id = ?`, id)
	r, err := scanRoutine(row)
	if err == sql.ErrNoRows {
		return Routine{}, ErrNotFound
	}
	if err != nil {
		return Routine{}, fmt.Errorf("get routine: %w", err)
	}
	return r, nil
}

// ListRoutines returns routines ordered by created_at desc.
func (s *Store) ListRoutines(ctx context.Context, opts ListRoutinesOpts) ([]Routine, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	var b strings.Builder
	b.WriteString(`SELECT ` + routineColumns + ` FROM routines WHERE 1=1`)
	args := make([]any, 0, 4)
	if opts.ProjectID != "" {
		b.WriteString(` AND project_id = ?`)
		args = append(args, opts.ProjectID)
	}
	if opts.Enabled != nil {
		v := 0
		if *opts.Enabled {
			v = 1
		}
		b.WriteString(` AND enabled = ?`)
		args = append(args, v)
	}
	b.WriteString(` ORDER BY created_at DESC LIMIT ?`)
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list routines: %w", err)
	}
	defer rows.Close()

	out := make([]Routine, 0)
	for rows.Next() {
		r, err := scanRoutine(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListDueRoutines returns enabled routines with next_due_at <= nowMs.
func (s *Store) ListDueRoutines(ctx context.Context, nowMs int64, limit int) ([]Routine, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+routineColumns+`
		FROM routines
		WHERE enabled = 1 AND next_due_at <= ?
		ORDER BY next_due_at ASC
		LIMIT ?`, nowMs, limit)
	if err != nil {
		return nil, fmt.Errorf("list due routines: %w", err)
	}
	defer rows.Close()
	out := make([]Routine, 0)
	for rows.Next() {
		r, err := scanRoutine(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpdateRoutine applies a patch.
func (s *Store) UpdateRoutine(ctx context.Context, id string, p RoutinePatch) error {
	sets := make([]string, 0, 12)
	args := make([]any, 0, 12)
	if p.Title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *p.Title)
	}
	if p.ProjectID != nil {
		if *p.ProjectID == "" {
			sets = append(sets, "project_id = NULL")
		} else {
			sets = append(sets, "project_id = ?")
			args = append(args, *p.ProjectID)
		}
	}
	if p.Cwd != nil {
		sets = append(sets, "cwd = ?")
		args = append(args, *p.Cwd)
	}
	if p.Agent != nil {
		sets = append(sets, "agent = ?")
		args = append(args, *p.Agent)
	}
	if p.PermissionMode != nil {
		sets = append(sets, "permission_mode = ?")
		args = append(args, *p.PermissionMode)
	}
	if p.Prompt != nil {
		sets = append(sets, "prompt = ?")
		args = append(args, *p.Prompt)
	}
	if p.IntervalSecs != nil {
		sets = append(sets, "interval_secs = ?")
		args = append(args, *p.IntervalSecs)
	}
	if p.Enabled != nil {
		v := 0
		if *p.Enabled {
			v = 1
		}
		sets = append(sets, "enabled = ?")
		args = append(args, v)
	}
	if p.ClearLastRunAt {
		sets = append(sets, "last_run_at = NULL")
	} else if p.LastRunAt != nil {
		sets = append(sets, "last_run_at = ?")
		args = append(args, *p.LastRunAt)
	}
	if p.NextDueAt != nil {
		sets = append(sets, "next_due_at = ?")
		args = append(args, *p.NextDueAt)
	}
	if p.ConsecFailures != nil {
		sets = append(sets, "consec_failures = ?")
		args = append(args, *p.ConsecFailures)
	}
	if len(sets) == 0 {
		return nil
	}
	args = append(args, id)
	q := `UPDATE routines SET ` + strings.Join(sets, ", ") + ` WHERE id = ?`
	res, err := s.db.ExecContext(ctx, q, args...)
	if err != nil {
		return fmt.Errorf("update routine: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetRoutineEnabled toggles enabled.
func (s *Store) SetRoutineEnabled(ctx context.Context, id string, enabled bool) error {
	return s.UpdateRoutine(ctx, id, RoutinePatch{Enabled: &enabled})
}

// DeleteRoutine removes a routine. Tasks keep routine_id (historical).
func (s *Store) DeleteRoutine(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM routines WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete routine: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// CountUnreadRoutineRuns returns how many routine-run tasks are still unread.
func (s *Store) CountUnreadRoutineRuns(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM tasks
		WHERE routine_id IS NOT NULL AND routine_unread = 1`).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count unread routine runs: %w", err)
	}
	return n, nil
}

// MarkRoutineRunRead clears the unread flag on a task.
func (s *Store) MarkRoutineRunRead(ctx context.Context, taskID string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE tasks SET routine_unread = 0
		WHERE id = ? AND routine_id IS NOT NULL`, taskID)
	if err != nil {
		return fmt.Errorf("mark routine run read: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// Either not found or not a routine run — treat missing as not found.
		var exists int
		_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM tasks WHERE id = ?`, taskID).Scan(&exists)
		if exists == 0 {
			return ErrNotFound
		}
	}
	return nil
}

// MarkAllRoutineRunsRead clears unread on all routine runs.
func (s *Store) MarkAllRoutineRunsRead(ctx context.Context) (int, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE tasks SET routine_unread = 0
		WHERE routine_id IS NOT NULL AND routine_unread = 1`)
	if err != nil {
		return 0, fmt.Errorf("mark all routine runs read: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}
