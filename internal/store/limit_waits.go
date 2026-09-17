package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// TaskLimitWait is the durable state for an automatic quota continuation.
// Event history remains the user-visible audit trail; this row is the
// restart-safe scheduler index.
type TaskLimitWait struct {
	TaskID      string `json:"task_id"`
	EventEpoch  int64  `json:"event_epoch"`
	UserSeq     int    `json:"user_seq"`
	Agent       string `json:"agent,omitempty"`
	Provider    string `json:"provider,omitempty"`
	Window      string `json:"window,omitempty"`
	ResetAt     int64  `json:"reset_at,omitempty"`
	State       string `json:"state"`
	Attempts    int    `json:"attempts"`
	NextProbeAt int64  `json:"next_probe_at"`
	FirstWaitAt int64  `json:"first_wait_at"`
	LastProbeAt int64  `json:"last_probe_at,omitempty"`
	LastError   string `json:"last_error,omitempty"`
	ClaimedAt   int64  `json:"claimed_at,omitempty"`
	UpdatedAt   int64  `json:"updated_at"`
}

const taskLimitWaitColumns = `
	task_id, event_epoch, user_seq, agent, provider, window, reset_at,
	state, attempts, next_probe_at, first_wait_at, last_probe_at,
	last_error, claimed_at, updated_at`

func scanTaskLimitWait(scanner interface {
	Scan(dest ...any) error
}) (TaskLimitWait, error) {
	var w TaskLimitWait
	var agent, provider, window, lastError sql.NullString
	var lastProbeAt, claimedAt sql.NullInt64
	if err := scanner.Scan(
		&w.TaskID, &w.EventEpoch, &w.UserSeq, &agent, &provider, &window,
		&w.ResetAt, &w.State, &w.Attempts, &w.NextProbeAt, &w.FirstWaitAt,
		&lastProbeAt, &lastError, &claimedAt, &w.UpdatedAt,
	); err != nil {
		return TaskLimitWait{}, err
	}
	if agent.Valid {
		w.Agent = agent.String
	}
	if provider.Valid {
		w.Provider = provider.String
	}
	if window.Valid {
		w.Window = window.String
	}
	if lastProbeAt.Valid {
		w.LastProbeAt = lastProbeAt.Int64
	}
	if lastError.Valid {
		w.LastError = lastError.String
	}
	if claimedAt.Valid {
		w.ClaimedAt = claimedAt.Int64
	}
	return w, nil
}

// UpsertTaskLimitWait creates or refreshes the active wait for a task.
func (s *Store) UpsertTaskLimitWait(ctx context.Context, w TaskLimitWait) error {
	return s.upsertTaskLimitWait(ctx, w, false)
}

// UpsertTaskLimitWaitMonotonic refreshes a wait without allowing a stale
// auto-arm to shorten a newer reset deadline. Explicit user actions should use
// UpsertTaskLimitWait when they intentionally override the deadline.
func (s *Store) UpsertTaskLimitWaitMonotonic(ctx context.Context, w TaskLimitWait) error {
	return s.upsertTaskLimitWait(ctx, w, true)
}

func (s *Store) upsertTaskLimitWait(ctx context.Context, w TaskLimitWait, preferLaterReset bool) error {
	if strings.TrimSpace(w.TaskID) == "" {
		return fmt.Errorf("task limit wait task_id is required")
	}
	if strings.TrimSpace(w.State) == "" {
		w.State = "waiting"
	}
	if w.FirstWaitAt <= 0 {
		w.FirstWaitAt = time.Now().UnixMilli()
	}
	if w.NextProbeAt <= 0 {
		w.NextProbeAt = w.FirstWaitAt
	}
	if w.UpdatedAt <= 0 {
		w.UpdatedAt = time.Now().UnixMilli()
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO task_limit_waits (
			task_id, event_epoch, user_seq, agent, provider, window, reset_at,
			state, attempts, next_probe_at, first_wait_at, last_probe_at,
			last_error, claimed_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(task_id) DO UPDATE SET
			event_epoch = excluded.event_epoch,
			user_seq = excluded.user_seq,
			agent = excluded.agent,
			provider = excluded.provider,
			window = excluded.window,
			reset_at = excluded.reset_at,
			state = excluded.state,
			attempts = excluded.attempts,
			next_probe_at = excluded.next_probe_at,
			first_wait_at = excluded.first_wait_at,
			last_probe_at = excluded.last_probe_at,
			last_error = excluded.last_error,
				claimed_at = excluded.claimed_at,
				updated_at = excluded.updated_at`+
		func() string {
			if !preferLaterReset {
				return ""
			}
			return ` WHERE task_limit_waits.state IN ('completed', 'canceled', 'blocked')
					OR excluded.event_epoch > task_limit_waits.event_epoch
					OR (excluded.event_epoch = task_limit_waits.event_epoch
						AND excluded.user_seq > task_limit_waits.user_seq)
					OR (excluded.event_epoch = task_limit_waits.event_epoch
						AND excluded.user_seq = task_limit_waits.user_seq
						AND excluded.reset_at >= task_limit_waits.reset_at)`
		}(),
		w.TaskID, w.EventEpoch, w.UserSeq, w.Agent, w.Provider, w.Window, w.ResetAt,
		w.State, w.Attempts, w.NextProbeAt, w.FirstWaitAt, w.LastProbeAt,
		w.LastError, nullableInt64(w.ClaimedAt), w.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("upsert task limit wait: %w", err)
	}
	return nil
}

// GetTaskLimitWait returns the durable wait row for a task.
func (s *Store) GetTaskLimitWait(ctx context.Context, taskID string) (TaskLimitWait, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+taskLimitWaitColumns+`
		FROM task_limit_waits WHERE task_id = ?`, taskID)
	w, err := scanTaskLimitWait(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskLimitWait{}, ErrNotFound
	}
	if err != nil {
		return TaskLimitWait{}, fmt.Errorf("get task limit wait: %w", err)
	}
	return w, nil
}

// ListTaskLimitWaits returns active durable waits ordered by due time.
func (s *Store) ListTaskLimitWaits(ctx context.Context, now int64, limit int) ([]TaskLimitWait, error) {
	if limit <= 0 {
		limit = 1000
	}
	if limit > 10000 {
		limit = 10000
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+taskLimitWaitColumns+`
		FROM task_limit_waits
		WHERE state IN ('waiting', 'probing') AND next_probe_at <= ?
		ORDER BY next_probe_at ASC, task_id ASC LIMIT ?`, now, limit)
	if err != nil {
		return nil, fmt.Errorf("list task limit waits: %w", err)
	}
	defer rows.Close()
	var out []TaskLimitWait
	for rows.Next() {
		w, err := scanTaskLimitWait(rows)
		if err != nil {
			return nil, fmt.Errorf("scan task limit wait: %w", err)
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate task limit waits: %w", err)
	}
	return out, nil
}

// ListActiveTaskLimitWaits returns all waits that can be resumed after a
// process restart, including waits scheduled in the future.
func (s *Store) ListActiveTaskLimitWaits(ctx context.Context, limit int) ([]TaskLimitWait, error) {
	return s.ListActiveTaskLimitWaitsPage(ctx, 0, "", limit)
}

// ListActiveTaskLimitWaitsPage returns active waits after the supplied
// (next_probe_at, task_id) cursor. It keeps restart recovery bounded per page
// without imposing a total wait-count cap.
func (s *Store) ListActiveTaskLimitWaitsPage(
	ctx context.Context, afterProbeAt int64, afterTaskID string, limit int,
) ([]TaskLimitWait, error) {
	if limit <= 0 {
		limit = 1000
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+taskLimitWaitColumns+`
		FROM task_limit_waits
		WHERE state IN ('waiting', 'probing') AND
			(next_probe_at > ? OR (next_probe_at = ? AND task_id > ?))
		ORDER BY next_probe_at ASC, task_id ASC LIMIT ?`,
		afterProbeAt, afterProbeAt, afterTaskID, limit)
	if err != nil {
		return nil, fmt.Errorf("list active task limit waits: %w", err)
	}
	defer rows.Close()
	var out []TaskLimitWait
	for rows.Next() {
		w, err := scanTaskLimitWait(rows)
		if err != nil {
			return nil, fmt.Errorf("scan active task limit wait: %w", err)
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate active task limit waits: %w", err)
	}
	return out, nil
}

// ClaimTaskLimitWait atomically reserves a due wait for one worker.
func (s *Store) ClaimTaskLimitWait(ctx context.Context, taskID string, now int64) (TaskLimitWait, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return TaskLimitWait{}, fmt.Errorf("begin claim task limit wait: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx, `
		UPDATE task_limit_waits
		SET state = 'probing', claimed_at = ?, updated_at = ?
		WHERE task_id = ? AND next_probe_at <= ? AND (
			state = 'waiting' OR
			(state = 'probing' AND claimed_at IS NOT NULL AND claimed_at < ?)
		)`,
		now, now, taskID, now, now-5*60*1000)
	if err != nil {
		return TaskLimitWait{}, fmt.Errorf("claim task limit wait: %w", err)
	}
	changed, _ := res.RowsAffected()
	if changed != 1 {
		return TaskLimitWait{}, ErrConflict
	}
	w, err := scanTaskLimitWait(tx.QueryRowContext(ctx, `SELECT `+taskLimitWaitColumns+`
		FROM task_limit_waits WHERE task_id = ?`, taskID))
	if err != nil {
		return TaskLimitWait{}, fmt.Errorf("read claimed task limit wait: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return TaskLimitWait{}, fmt.Errorf("commit claim task limit wait: %w", err)
	}
	return w, nil
}

// RequeueTaskLimitWaitClaims releases probes owned by a previous daemon
// process. A restart establishes a new scheduler owner, so an in-flight
// probe must not remain leased for the old process's full lease window.
func (s *Store) RequeueTaskLimitWaitClaims(ctx context.Context) error {
	now := time.Now().UnixMilli()
	_, err := s.db.ExecContext(ctx, `
		UPDATE task_limit_waits
		SET state = 'waiting', claimed_at = NULL, updated_at = ?
		WHERE state = 'probing'`, now)
	if err != nil {
		return fmt.Errorf("requeue task limit wait claims: %w", err)
	}
	return nil
}

// UpdateTaskLimitWait updates the complete durable state after probing or retry.
func (s *Store) UpdateTaskLimitWait(ctx context.Context, w TaskLimitWait) error {
	if w.UpdatedAt <= 0 {
		w.UpdatedAt = time.Now().UnixMilli()
	}
	query := `
		UPDATE task_limit_waits SET
			event_epoch = ?, user_seq = ?, agent = ?, provider = ?, window = ?,
			reset_at = ?, state = ?, attempts = ?, next_probe_at = ?,
			first_wait_at = ?, last_probe_at = ?, last_error = ?, claimed_at = ?,
			updated_at = ?
		WHERE task_id = ?`
	claimedValue := nullableInt64(w.ClaimedAt)
	if w.State != "probing" {
		claimedValue = nil
	}
	args := []any{
		w.EventEpoch, w.UserSeq, w.Agent, w.Provider, w.Window, w.ResetAt,
		w.State, w.Attempts, w.NextProbeAt, w.FirstWaitAt, w.LastProbeAt,
		w.LastError, claimedValue, w.UpdatedAt, w.TaskID,
	}
	if w.ClaimedAt > 0 {
		query += ` AND state = 'probing' AND claimed_at = ?`
		args = append(args, w.ClaimedAt)
	}
	res, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("update task limit wait: %w", err)
	}
	if changed, _ := res.RowsAffected(); changed == 0 {
		return ErrNotFound
	}
	return nil
}

// SetTaskLimitWaitStateClaimed updates a wait only while the caller still
// owns its transactional claim. A manual action or newer wakeup clears the
// claim and makes stale workers harmless.
func (s *Store) SetTaskLimitWaitStateClaimed(
	ctx context.Context, taskID string, claimedAt int64, state, lastError string, nextProbeAt int64,
) error {
	now := time.Now().UnixMilli()
	res, err := s.db.ExecContext(ctx, `
		UPDATE task_limit_waits
		SET state = ?, last_error = ?, next_probe_at = ?, claimed_at = NULL, updated_at = ?
		WHERE task_id = ? AND state = 'probing' AND claimed_at = ?`,
		state, lastError, nextProbeAt, now, taskID, claimedAt)
	if err != nil {
		return fmt.Errorf("set claimed task limit wait state: %w", err)
	}
	if changed, _ := res.RowsAffected(); changed == 0 {
		return ErrConflict
	}
	return nil
}

// SetTaskLimitWaitState changes only the lifecycle state and scheduler fields.
func (s *Store) SetTaskLimitWaitState(ctx context.Context, taskID, state, lastError string, nextProbeAt int64) error {
	now := time.Now().UnixMilli()
	res, err := s.db.ExecContext(ctx, `
		UPDATE task_limit_waits
		SET state = ?, last_error = ?, next_probe_at = ?, claimed_at = NULL, updated_at = ?
		WHERE task_id = ?`, state, lastError, nextProbeAt, now, taskID)
	if err != nil {
		return fmt.Errorf("set task limit wait state: %w", err)
	}
	if changed, _ := res.RowsAffected(); changed == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteTaskLimitWait removes a wait. It is used for explicit completion and
// is also safe to call while deleting a task.
func (s *Store) DeleteTaskLimitWait(ctx context.Context, taskID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM task_limit_waits WHERE task_id = ?`, taskID)
	if err != nil {
		return fmt.Errorf("delete task limit wait: %w", err)
	}
	return nil
}

func nullableInt64(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}
