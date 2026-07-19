package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// TaskCheckpoint is a private turn snapshot for an isolated task workspace.
type TaskCheckpoint struct {
	TaskID    string `json:"task_id"`
	EventSeq  int    `json:"event_seq"`
	HeadOID   string `json:"head_oid"`
	TreeOID   string `json:"tree_oid"`
	SizeBytes int64  `json:"size_bytes"`
	CreatedAt int64  `json:"created_at"`
}

const checkpointColumns = `task_id, event_seq, head_oid, tree_oid, size_bytes, created_at`

func scanCheckpoint(scanner interface {
	Scan(dest ...any) error
}) (TaskCheckpoint, error) {
	var cp TaskCheckpoint
	if err := scanner.Scan(
		&cp.TaskID, &cp.EventSeq, &cp.HeadOID, &cp.TreeOID, &cp.SizeBytes, &cp.CreatedAt,
	); err != nil {
		return TaskCheckpoint{}, err
	}
	return cp, nil
}

// PutCheckpoint inserts or replaces a checkpoint for (task_id, event_seq).
func (s *Store) PutCheckpoint(ctx context.Context, cp TaskCheckpoint) error {
	if cp.TaskID == "" {
		return fmt.Errorf("task_id is required")
	}
	if cp.EventSeq < 0 {
		return fmt.Errorf("event_seq must be >= 0")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO task_checkpoints (task_id, event_seq, head_oid, tree_oid, size_bytes, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(task_id, event_seq) DO UPDATE SET
			head_oid = excluded.head_oid,
			tree_oid = excluded.tree_oid,
			size_bytes = excluded.size_bytes,
			created_at = excluded.created_at
	`, cp.TaskID, cp.EventSeq, cp.HeadOID, cp.TreeOID, cp.SizeBytes, cp.CreatedAt)
	if err != nil {
		return fmt.Errorf("put checkpoint: %w", err)
	}
	return nil
}

// GetCheckpoint returns the checkpoint for an exact (task_id, event_seq).
func (s *Store) GetCheckpoint(ctx context.Context, taskID string, eventSeq int) (TaskCheckpoint, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+checkpointColumns+` FROM task_checkpoints WHERE task_id = ? AND event_seq = ?`,
		taskID, eventSeq,
	)
	cp, err := scanCheckpoint(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskCheckpoint{}, ErrNotFound
	}
	if err != nil {
		return TaskCheckpoint{}, fmt.Errorf("get checkpoint: %w", err)
	}
	return cp, nil
}

// GetCheckpointAtOrBefore returns the latest checkpoint with event_seq <= eventSeq.
func (s *Store) GetCheckpointAtOrBefore(ctx context.Context, taskID string, eventSeq int) (TaskCheckpoint, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT `+checkpointColumns+`
		FROM task_checkpoints
		WHERE task_id = ? AND event_seq <= ?
		ORDER BY event_seq DESC
		LIMIT 1
	`, taskID, eventSeq)
	cp, err := scanCheckpoint(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskCheckpoint{}, ErrNotFound
	}
	if err != nil {
		return TaskCheckpoint{}, fmt.Errorf("get checkpoint at or before: %w", err)
	}
	return cp, nil
}

// GetInitialCheckpoint returns the earliest checkpoint for a task.
func (s *Store) GetInitialCheckpoint(ctx context.Context, taskID string) (TaskCheckpoint, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT `+checkpointColumns+`
		FROM task_checkpoints
		WHERE task_id = ?
		ORDER BY event_seq ASC
		LIMIT 1
	`, taskID)
	cp, err := scanCheckpoint(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskCheckpoint{}, ErrNotFound
	}
	if err != nil {
		return TaskCheckpoint{}, fmt.Errorf("get initial checkpoint: %w", err)
	}
	return cp, nil
}

// DeleteCheckpointsFrom deletes checkpoints with event_seq >= eventSeq.
func (s *Store) DeleteCheckpointsFrom(ctx context.Context, taskID string, eventSeq int) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM task_checkpoints WHERE task_id = ? AND event_seq >= ?
	`, taskID, eventSeq)
	if err != nil {
		return fmt.Errorf("delete checkpoints: %w", err)
	}
	return nil
}

// ListCheckpoints returns all checkpoints for a task ordered by event_seq ascending.
// The slice is never nil.
func (s *Store) ListCheckpoints(ctx context.Context, taskID string) ([]TaskCheckpoint, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+checkpointColumns+`
		FROM task_checkpoints
		WHERE task_id = ?
		ORDER BY event_seq ASC
	`, taskID)
	if err != nil {
		return nil, fmt.Errorf("list checkpoints: %w", err)
	}
	defer rows.Close()

	out := make([]TaskCheckpoint, 0)
	for rows.Next() {
		cp, err := scanCheckpoint(rows)
		if err != nil {
			return nil, fmt.Errorf("scan checkpoint: %w", err)
		}
		out = append(out, cp)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
