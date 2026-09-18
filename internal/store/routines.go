package store

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Default circuit breaker: auto-disable after this many consecutive failures.
const RoutineMaxConsecFailures = 3

// Routine is a saved recurring task (ADR 0011).
type Routine struct {
	ID              string `json:"id"`
	ProjectID       string `json:"project_id,omitempty"`
	Cwd             string `json:"cwd"`
	Agent           string `json:"agent"`
	PermissionMode  string `json:"permission_mode"`
	Prompt          string `json:"prompt"`
	IntervalSecs    int64  `json:"interval_secs"`
	Enabled         bool   `json:"enabled"`
	LastRunAt       *int64 `json:"last_run_at,omitempty"`
	NextDueAt       int64  `json:"next_due_at"`
	ConsecFailures  int    `json:"consec_failures"`
	CreatedAt       int64  `json:"created_at"`
	Title           string `json:"title"`
	MissedRunPolicy string `json:"missed_run_policy"`
	Lane            string `json:"lane"`
	ClaimUntilAt    int64  `json:"claim_until_at,omitempty"`
	LastOutcome     string `json:"last_outcome,omitempty"`
	LastError       string `json:"last_error,omitempty"`
}

// RoutinePatch is a partial update for routines.
type RoutinePatch struct {
	Title           *string
	ProjectID       *string // empty string clears
	Cwd             *string
	Agent           *string
	PermissionMode  *string
	Prompt          *string
	IntervalSecs    *int64
	Enabled         *bool
	LastRunAt       *int64
	ClearLastRunAt  bool
	NextDueAt       *int64
	ConsecFailures  *int
	MissedRunPolicy *string
	Lane            *string
	LastOutcome     *string
	LastError       *string
}

// ListRoutinesOpts filters for ListRoutines.
type ListRoutinesOpts struct {
	ProjectID string // empty = all
	Enabled   *bool  // nil = all
	Limit     int
	Before    string // cursor: rows older than this routine id
	Query     string // literal substring over title, prompt, cwd, agent, id
}

type RoutinePage struct {
	Routines   []Routine `json:"routines"`
	NextCursor string    `json:"next_cursor,omitempty"`
	HasMore    bool      `json:"has_more"`
}

const routineColumns = `id, project_id, cwd, agent, permission_mode, prompt, interval_secs, enabled, last_run_at, next_due_at, consec_failures, created_at, title, missed_run_policy, lane, claim_until_at, last_outcome, last_error`

func scanRoutine(scanner interface {
	Scan(dest ...any) error
}) (Routine, error) {
	var r Routine
	var projectID sql.NullString
	var lastRun sql.NullInt64
	var missedRunPolicy, lane, lastOutcome, lastError sql.NullString
	var enabled int
	if err := scanner.Scan(
		&r.ID, &projectID, &r.Cwd, &r.Agent, &r.PermissionMode, &r.Prompt,
		&r.IntervalSecs, &enabled, &lastRun, &r.NextDueAt, &r.ConsecFailures,
		&r.CreatedAt, &r.Title, &missedRunPolicy, &lane, &r.ClaimUntilAt,
		&lastOutcome, &lastError,
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
	r.MissedRunPolicy = missedRunPolicy.String
	if r.MissedRunPolicy == "" {
		r.MissedRunPolicy = "coalesce"
	}
	r.Lane = lane.String
	if r.Lane == "" {
		r.Lane = "routine"
	}
	r.LastOutcome = lastOutcome.String
	r.LastError = lastError.String
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
	if r.MissedRunPolicy == "" {
		r.MissedRunPolicy = "coalesce"
	}
	if r.Lane == "" {
		r.Lane = "routine"
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
			enabled, last_run_at, next_due_at, consec_failures, created_at, title,
			missed_run_policy, lane, claim_until_at, last_outcome, last_error
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, projectID, r.Cwd, r.Agent, r.PermissionMode, r.Prompt, r.IntervalSecs,
		enabled, lastRun, r.NextDueAt, r.ConsecFailures, r.CreatedAt, r.Title,
		r.MissedRunPolicy, r.Lane, r.ClaimUntilAt, r.LastOutcome, r.LastError,
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
	page, err := s.ListRoutinesPage(ctx, opts)
	if err != nil {
		return nil, err
	}
	return page.Routines, nil
}

// ListRoutinesPage returns one cursor page without treating the page size as
// a product-level definition limit.
func (s *Store) ListRoutinesPage(ctx context.Context, opts ListRoutinesOpts) (RoutinePage, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	var b strings.Builder
	b.WriteString(`SELECT ` + routineColumns + ` FROM routines WHERE 1=1`)
	args := make([]any, 0, 8)
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
	if opts.Before != "" {
		if createdAt, id, ok := decodeRoutineCursor(opts.Before); ok {
			b.WriteString(` AND (created_at < ? OR (created_at = ? AND id < ?))`)
			args = append(args, createdAt, createdAt, id)
		} else {
			// Legacy ID-only cursors cannot safely resume after the row was
			// deleted. Return an empty page rather than restarting page one.
			b.WriteString(` AND 1 = 0`)
		}
	}
	if q := strings.TrimSpace(opts.Query); q != "" {
		if len(q) > 200 {
			q = q[:200]
		}
		pat := "%" + escapeLike(q) + "%"
		b.WriteString(` AND (
			title LIKE ? ESCAPE '\' OR prompt LIKE ? ESCAPE '\' OR
			cwd LIKE ? ESCAPE '\' OR agent LIKE ? ESCAPE '\' OR id LIKE ? ESCAPE '\'
		)`)
		args = append(args, pat, pat, pat, pat, pat)
	}
	b.WriteString(` ORDER BY created_at DESC, id DESC LIMIT ?`)
	args = append(args, limit+1)

	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return RoutinePage{}, fmt.Errorf("list routines: %w", err)
	}
	defer rows.Close()

	out := make([]Routine, 0, limit+1)
	for rows.Next() {
		r, err := scanRoutine(rows)
		if err != nil {
			return RoutinePage{}, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return RoutinePage{}, err
	}
	page := RoutinePage{Routines: out}
	if len(out) > limit {
		page.HasMore = true
		page.Routines = out[:limit]
		page.NextCursor = encodeRoutineCursor(page.Routines[len(page.Routines)-1])
	}
	return page, nil
}

func encodeRoutineCursor(r Routine) string {
	return strconv.FormatInt(r.CreatedAt, 10) + ":" + r.ID
}

func decodeRoutineCursor(cursor string) (int64, string, bool) {
	separator := strings.IndexByte(cursor, ':')
	if separator <= 0 || separator == len(cursor)-1 {
		return 0, "", false
	}
	createdAt, err := strconv.ParseInt(cursor[:separator], 10, 64)
	if err != nil {
		return 0, "", false
	}
	return createdAt, cursor[separator+1:], true
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

// ClaimDueRoutine atomically leases one due routine to a scheduler tick.
func (s *Store) ClaimDueRoutine(ctx context.Context, id, token string, nowMs, leaseMs int64) (Routine, error) {
	if leaseMs <= 0 {
		leaseMs = 2 * 60 * 1000
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE routines
		SET claim_token = ?, claim_until_at = ?
		WHERE id = ? AND enabled = 1 AND next_due_at <= ?
		  AND (claim_token = '' OR claim_until_at <= ?)`,
		token, nowMs+leaseMs, id, nowMs, nowMs)
	if err != nil {
		return Routine{}, fmt.Errorf("claim due routine: %w", err)
	}
	if changed, _ := res.RowsAffected(); changed != 1 {
		return Routine{}, ErrConflict
	}
	return s.GetRoutine(ctx, id)
}

// CompleteRoutineClaim advances a claimed routine and releases its lease.
func (s *Store) CompleteRoutineClaim(ctx context.Context, r Routine, token string, nowMs, nextDueAt int64, outcome, lastError string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE routines SET
			last_run_at = ?, next_due_at = ?, claim_token = '', claim_until_at = 0,
			last_outcome = ?, last_error = ?
		WHERE id = ? AND claim_token = ?`,
		nowMs, nextDueAt, outcome, lastError, r.ID, token)
	if err != nil {
		return fmt.Errorf("complete routine claim: %w", err)
	}
	if changed, _ := res.RowsAffected(); changed != 1 {
		return ErrConflict
	}
	return nil
}

// CountRoutineInFlight returns queued/running routine tasks. It is used by the
// scheduler to leave at least one worker slot for interactive work.
func (s *Store) CountRoutineInFlight(ctx context.Context) (int, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM (
			SELECT 'task:' || t.id FROM tasks t
			WHERE t.routine_id IS NOT NULL
			  AND t.status IN ('queued', 'running', 'waiting_approval', 'waiting_input')
			  AND NOT EXISTS (
				SELECT 1
				FROM eval_runs er
				WHERE er.id = json_extract(t.dispatch, '$.eval_run_id')
				  AND er.routine_id = t.routine_id
				  AND er.status = 'running'
			  )
			  AND NOT EXISTS (
				SELECT 1
				FROM events ev
				JOIN eval_runs er ON er.id = json_extract(ev.payload, '$.run_id')
				WHERE ev.task_id = t.id
				  AND ev.type = 'eval_metadata'
				  AND er.routine_id = t.routine_id
				  AND er.status = 'running'
			  )
			UNION
			SELECT 'eval:' || er.routine_id FROM eval_runs er
			WHERE er.routine_id <> '' AND er.status = 'running'
		)`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count routine in-flight: %w", err)
	}
	return n, nil
}

// RoutineHealth is the indexed scheduler backlog snapshot.
type RoutineHealth struct {
	DueBacklog         int    `json:"due_backlog"`
	OldestDueAt        *int64 `json:"oldest_due_at,omitempty"`
	Running            int    `json:"running"`
	LastSchedulerError string `json:"last_scheduler_error,omitempty"`
}

// RoutineHealthSnapshot returns due and in-flight counts without loading all
// routine definitions.
func (s *Store) RoutineHealthSnapshot(ctx context.Context) (RoutineHealth, error) {
	var h RoutineHealth
	var oldest sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*), MIN(next_due_at)
		FROM routines WHERE enabled = 1 AND next_due_at <= ?`,
		time.Now().UnixMilli()).Scan(&h.DueBacklog, &oldest); err != nil {
		return RoutineHealth{}, fmt.Errorf("routine due health: %w", err)
	}
	if oldest.Valid {
		h.OldestDueAt = &oldest.Int64
	}
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM (
			SELECT 'task:' || t.id FROM tasks t
			WHERE t.routine_id IS NOT NULL
			  AND t.status IN ('queued', 'running', 'waiting_approval', 'waiting_input')
			  AND NOT EXISTS (
				SELECT 1
				FROM eval_runs er
				WHERE er.id = json_extract(t.dispatch, '$.eval_run_id')
				  AND er.routine_id = t.routine_id
				  AND er.status = 'running'
			  )
			  AND NOT EXISTS (
				SELECT 1
				FROM events ev
				JOIN eval_runs er ON er.id = json_extract(ev.payload, '$.run_id')
				WHERE ev.task_id = t.id
				  AND ev.type = 'eval_metadata'
				  AND er.routine_id = t.routine_id
				  AND er.status = 'running'
			  )
			UNION
			SELECT 'eval:' || er.routine_id FROM eval_runs er
			WHERE er.routine_id <> '' AND er.status = 'running'
		)`,
	).Scan(&h.Running); err != nil {
		return RoutineHealth{}, fmt.Errorf("routine running health: %w", err)
	}
	return h, nil
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
	if p.MissedRunPolicy != nil {
		sets = append(sets, "missed_run_policy = ?")
		args = append(args, *p.MissedRunPolicy)
	}
	if p.Lane != nil {
		sets = append(sets, "lane = ?")
		args = append(args, *p.Lane)
	}
	if p.LastOutcome != nil {
		sets = append(sets, "last_outcome = ?")
		args = append(args, *p.LastOutcome)
	}
	if p.LastError != nil {
		sets = append(sets, "last_error = ?")
		args = append(args, *p.LastError)
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
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete routine: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var pending int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM routine_dispatches
		WHERE routine_id = ? AND state IN ('pending', 'manual_pending', 'mcp_manual_pending')`,
		id,
	).Scan(&pending); err != nil {
		return fmt.Errorf("check routine dispatches: %w", err)
	}
	if pending > 0 {
		return ErrConflict
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM routines WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete routine: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete routine: %w", err)
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
