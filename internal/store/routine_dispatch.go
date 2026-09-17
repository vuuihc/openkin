package store

import (
	"context"
	"database/sql"
	"fmt"
)

type RoutineDispatch struct {
	RoutineID string
	DueAt     int64
	TaskID    string
	State     string
	CreatedAt int64
}

// BeginRoutineDispatch reserves a deterministic task ID for one scheduled due
// occurrence. A restarted scheduler receives the same ID instead of creating
// a second task after the original Engine.Create succeeded.
func (s *Store) BeginRoutineDispatch(ctx context.Context, routineID string, dueAt int64, taskID string, now int64) (RoutineDispatch, bool, error) {
	return s.beginRoutineDispatch(ctx, routineID, dueAt, taskID, now, "pending")
}

// BeginManualRoutineDispatch reserves a manual dispatch that can be recovered
// after a daemon restart before a second manual run is accepted.
func (s *Store) BeginManualRoutineDispatch(ctx context.Context, routineID string, dueAt int64, taskID string, now int64) (RoutineDispatch, bool, error) {
	return s.beginRoutineDispatch(ctx, routineID, dueAt, taskID, now, "manual_pending")
}

func (s *Store) BeginMCPRoutineDispatch(ctx context.Context, routineID string, dueAt int64, taskID string, now int64) (RoutineDispatch, bool, error) {
	return s.beginRoutineDispatch(ctx, routineID, dueAt, taskID, now, "mcp_manual_pending")
}

func (s *Store) beginRoutineDispatch(ctx context.Context, routineID string, dueAt int64, taskID string, now int64, state string) (RoutineDispatch, bool, error) {
	if routineID == "" || dueAt <= 0 || taskID == "" || now <= 0 {
		return RoutineDispatch{}, false, fmt.Errorf("invalid routine dispatch")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RoutineDispatch{}, false, fmt.Errorf("begin routine dispatch: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
		INSERT INTO routine_dispatches (routine_id, due_at, task_id, state, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(routine_id, due_at) DO NOTHING`,
		routineID, dueAt, taskID, state, now,
	)
	if err != nil {
		return RoutineDispatch{}, false, fmt.Errorf("reserve routine dispatch: %w", err)
	}
	inserted, _ := result.RowsAffected()
	var dispatch RoutineDispatch
	err = tx.QueryRowContext(ctx, `
		SELECT routine_id, due_at, task_id, state, created_at
		FROM routine_dispatches WHERE routine_id = ? AND due_at = ?`,
		routineID, dueAt,
	).Scan(&dispatch.RoutineID, &dispatch.DueAt, &dispatch.TaskID, &dispatch.State, &dispatch.CreatedAt)
	if err == sql.ErrNoRows {
		return RoutineDispatch{}, false, ErrNotFound
	}
	if err != nil {
		return RoutineDispatch{}, false, fmt.Errorf("read routine dispatch: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return RoutineDispatch{}, false, fmt.Errorf("commit routine dispatch: %w", err)
	}
	return dispatch, inserted == 1, nil
}

// ListPendingManualRoutineDispatches returns manual dispatches left incomplete
// by a process interruption. The caller owns capacity enforcement.
func (s *Store) ListPendingManualRoutineDispatches(ctx context.Context, limit int) ([]RoutineDispatch, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT routine_id, due_at, task_id, state, created_at
		FROM routine_dispatches
		WHERE state IN ('manual_pending', 'mcp_manual_pending')
		ORDER BY created_at ASC, routine_id ASC, due_at ASC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending manual routine dispatches: %w", err)
	}
	defer rows.Close()
	out := make([]RoutineDispatch, 0, limit)
	for rows.Next() {
		var dispatch RoutineDispatch
		if err := rows.Scan(
			&dispatch.RoutineID,
			&dispatch.DueAt,
			&dispatch.TaskID,
			&dispatch.State,
			&dispatch.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan pending manual routine dispatch: %w", err)
		}
		out = append(out, dispatch)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pending manual routine dispatches: %w", err)
	}
	return out, nil
}

func (s *Store) CompleteRoutineDispatch(ctx context.Context, routineID string, dueAt int64, state string) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE routine_dispatches SET state = ?
		WHERE routine_id = ? AND due_at = ?`,
		state, routineID, dueAt,
	)
	if err != nil {
		return fmt.Errorf("complete routine dispatch: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return ErrNotFound
	}
	return nil
}
