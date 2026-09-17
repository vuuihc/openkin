package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// A2AOperation is a durable mutation idempotency record.
type A2AOperation struct {
	State    string
	Response json.RawMessage
	Status   int
	Created  bool
}

// ReserveA2AOperation records a mutation before side effects.
func (s *Store) ReserveA2AOperation(ctx context.Context, principal, taskID, key, requestHash string) (A2AOperation, error) {
	if strings.TrimSpace(principal) == "" || strings.TrimSpace(taskID) == "" ||
		strings.TrimSpace(key) == "" || strings.TrimSpace(requestHash) == "" {
		return A2AOperation{}, fmt.Errorf("a2a operation fields are required")
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO a2a_operations (principal_id, task_id, idem_key, request_hash, state, created_at)
		VALUES (?, ?, ?, ?, 'started', ?)
		ON CONFLICT(principal_id, task_id, idem_key) DO NOTHING`,
		principal, taskID, key, requestHash, NowMilli())
	if err != nil {
		return A2AOperation{}, fmt.Errorf("reserve a2a operation: %w", err)
	}
	if changed, _ := res.RowsAffected(); changed == 1 {
		return A2AOperation{State: "started", Created: true}, nil
	}
	var op A2AOperation
	var existingHash, response string
	if err := s.db.QueryRowContext(ctx, `
		SELECT request_hash, state, response, http_status
		FROM a2a_operations WHERE principal_id = ? AND task_id = ? AND idem_key = ?`,
		principal, taskID, key).Scan(&existingHash, &op.State, &response, &op.Status); err != nil {
		return A2AOperation{}, fmt.Errorf("get a2a operation: %w", err)
	}
	if existingHash != requestHash {
		return A2AOperation{}, fmt.Errorf("%w: idempotency key reused with different request", ErrConflict)
	}
	op.Response = json.RawMessage(response)
	return op, nil
}

// CompleteA2AOperation stores the response returned by a mutation.
func (s *Store) CompleteA2AOperation(ctx context.Context, principal, taskID, key string, status int, response json.RawMessage) error {
	if response == nil {
		response = json.RawMessage(`{}`)
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE a2a_operations SET state = 'completed', response = ?, http_status = ?
		WHERE principal_id = ? AND task_id = ? AND idem_key = ?`,
		string(response), status, principal, taskID, key)
	if err != nil {
		return fmt.Errorf("complete a2a operation: %w", err)
	}
	if changed, _ := res.RowsAffected(); changed == 0 {
		return ErrNotFound
	}
	return nil
}

// FailA2AOperation stores a deterministic error response for retries.
func (s *Store) FailA2AOperation(ctx context.Context, principal, taskID, key string, status int, response json.RawMessage) error {
	if response == nil {
		response = json.RawMessage(`{}`)
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE a2a_operations SET state = 'failed', response = ?, http_status = ?
		WHERE principal_id = ? AND task_id = ? AND idem_key = ?`,
		string(response), status, principal, taskID, key)
	return err
}

// PutA2AIdempotency stores the task created for a client retry key.
func (s *Store) PutA2AIdempotency(ctx context.Context, principal, key, taskID string) error {
	if strings.TrimSpace(principal) == "" || strings.TrimSpace(key) == "" || strings.TrimSpace(taskID) == "" {
		return fmt.Errorf("a2a principal, key, and task_id are required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO a2a_idempotency (principal_id, idem_key, task_id, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(principal_id, idem_key) DO NOTHING`,
		principal, key, taskID, NowMilli())
	if err != nil {
		return fmt.Errorf("put a2a idempotency: %w", err)
	}
	return nil
}

// ReserveA2AIdempotency atomically claims a retry key before task creation.
// It returns the existing task id and created=false when another request won.
func (s *Store) ReserveA2AIdempotency(ctx context.Context, principal, key, taskID, requestHash string) (string, bool, error) {
	if strings.TrimSpace(principal) == "" || strings.TrimSpace(key) == "" || strings.TrimSpace(taskID) == "" {
		return "", false, fmt.Errorf("a2a principal, key, and task_id are required")
	}
	if strings.TrimSpace(requestHash) == "" {
		return "", false, fmt.Errorf("a2a request hash is required")
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO a2a_idempotency (principal_id, idem_key, task_id, request_hash, created_at)
		VALUES (?, ?, ?, ?, ?) ON CONFLICT(principal_id, idem_key) DO NOTHING`,
		principal, key, taskID, requestHash, NowMilli())
	if err != nil {
		return "", false, fmt.Errorf("reserve a2a idempotency: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 1 {
		return taskID, true, nil
	}
	var existing, existingHash string
	err = s.db.QueryRowContext(ctx, `
		SELECT task_id, request_hash FROM a2a_idempotency
		WHERE principal_id = ? AND idem_key = ?`, principal, key).Scan(&existing, &existingHash)
	if err == nil && existingHash != "" && existingHash != requestHash {
		return "", false, fmt.Errorf("%w: idempotency key reused with different request", ErrConflict)
	}
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, ErrNotFound
		}
		return "", false, fmt.Errorf("get a2a idempotency: %w", err)
	}
	return existing, false, err
}

// DeleteA2AIdempotency releases a reservation after task creation failed.
func (s *Store) DeleteA2AIdempotency(ctx context.Context, principal, key string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM a2a_idempotency WHERE principal_id = ? AND idem_key = ?`, principal, key)
	return err
}

// ReclaimA2AIdempotency removes only an old reservation whose task was never
// created. The age guard prevents a concurrent creator from being reclaimed.
func (s *Store) ReclaimA2AIdempotency(ctx context.Context, principal, key, taskID string, olderThan int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
		DELETE FROM a2a_idempotency
		WHERE principal_id = ? AND idem_key = ? AND task_id = ? AND created_at <= ?
		  AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = ?)`,
		principal, key, taskID, NowMilli()-olderThan, taskID)
	if err != nil {
		return false, fmt.Errorf("reclaim a2a idempotency: %w", err)
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// A2AIdempotencyReclaimable reports whether a stale orphan reservation can be
// retried with the same task id. It does not delete or replace the reservation.
func (s *Store) A2AIdempotencyReclaimable(ctx context.Context, principal, key, taskID string, olderThan int64) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1 FROM a2a_idempotency
		WHERE principal_id = ? AND idem_key = ? AND task_id = ? AND created_at <= ?
		  AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = ?)`,
		principal, key, taskID, NowMilli()-olderThan, taskID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return one == 1, nil
}

// IsA2ATaskOwner checks whether a non-master principal owns a delegated task.
func (s *Store) IsA2ATaskOwner(ctx context.Context, principal, taskID string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1 FROM a2a_idempotency WHERE principal_id = ? AND task_id = ?
		UNION
		SELECT 1 FROM a2a_operations WHERE principal_id = ? AND task_id = ?
		LIMIT 1`, principal, taskID, principal, taskID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check a2a task owner: %w", err)
	}
	return one == 1, nil
}

// GetA2AIdempotency resolves a client retry key.
func (s *Store) GetA2AIdempotency(ctx context.Context, principal, key string) (string, error) {
	var taskID string
	err := s.db.QueryRowContext(ctx, `
		SELECT task_id FROM a2a_idempotency WHERE principal_id = ? AND idem_key = ?`,
		principal, key).Scan(&taskID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("get a2a idempotency: %w", err)
	}
	return taskID, nil
}
