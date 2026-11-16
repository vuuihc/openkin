package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var ErrMCPIdempotencyExists = errors.New("MCP idempotency key already exists")

// MCPAuditCall records the authenticated identity and outcome of one public
// MCP JSON-RPC request. RequestHash is a digest of bounded request metadata,
// never the raw prompt or credentials.
type MCPAuditCall struct {
	ID            string
	OccurredAt    int64
	PrincipalKind string
	PrincipalID   string
	ClientID      string
	Method        string
	Tool          string
	Scope         string
	Success       bool
	ErrorCode     string
	RequestHash   string
}

type MCPTaskOrigin struct {
	TaskID        string
	PrincipalKind string
	PrincipalID   string
	ClientID      string
	SessionID     string
	CreatedAt     int64
}

func (s *Store) RecordMCPTaskOrigin(ctx context.Context, origin MCPTaskOrigin) error {
	if origin.TaskID == "" || origin.PrincipalKind == "" || origin.PrincipalID == "" ||
		origin.ClientID == "" || origin.SessionID == "" || origin.CreatedAt <= 0 {
		return fmt.Errorf("invalid MCP task origin")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO mcp_task_origins (
			task_id, principal_kind, principal_id, client_id, session_id, created_at
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(task_id) DO NOTHING`,
		origin.TaskID, origin.PrincipalKind, origin.PrincipalID, origin.ClientID,
		origin.SessionID, origin.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("record MCP task origin: %w", err)
	}
	return nil
}

func (s *Store) GetMCPTaskOrigin(ctx context.Context, taskID string) (MCPTaskOrigin, error) {
	var origin MCPTaskOrigin
	err := s.db.QueryRowContext(ctx, `
		SELECT task_id, principal_kind, principal_id, client_id, session_id, created_at
		FROM mcp_task_origins WHERE task_id = ?`, taskID,
	).Scan(
		&origin.TaskID, &origin.PrincipalKind, &origin.PrincipalID,
		&origin.ClientID, &origin.SessionID, &origin.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return MCPTaskOrigin{}, ErrNotFound
	}
	if err != nil {
		return MCPTaskOrigin{}, fmt.Errorf("get MCP task origin: %w", err)
	}
	return origin, nil
}

func (s *Store) DeleteMCPTaskOrigin(ctx context.Context, taskID string) error {
	if taskID == "" {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM mcp_task_origins WHERE task_id = ?`, taskID); err != nil {
		return fmt.Errorf("delete MCP task origin: %w", err)
	}
	return nil
}

func (s *Store) RecordMCPAuditCall(ctx context.Context, call MCPAuditCall) error {
	if call.ID == "" || call.OccurredAt <= 0 || call.Method == "" {
		return fmt.Errorf("invalid MCP audit call")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO mcp_audit_calls (
			id, occurred_at, principal_kind, principal_id, client_id,
			method, tool, scope, success, error_code, request_hash
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		call.ID, call.OccurredAt, call.PrincipalKind, call.PrincipalID,
		call.ClientID, call.Method, call.Tool, call.Scope, mcpBoolInt(call.Success),
		call.ErrorCode, call.RequestHash,
	)
	if err != nil {
		return fmt.Errorf("record MCP audit call: %w", err)
	}
	return nil
}

// GetMCPIdempotency returns a non-expired response for a scoped key.
func (s *Store) GetMCPIdempotency(ctx context.Context, principalID, clientID, key string, now int64) ([]byte, bool, error) {
	if principalID == "" || clientID == "" || key == "" {
		return nil, false, nil
	}
	var expiresAt int64
	var state string
	var response string
	err := s.db.QueryRowContext(ctx, `
		SELECT expires_at, state, response
		FROM mcp_idempotency
		WHERE principal_id = ? AND client_id = ? AND idem_key = ?`,
		principalID, clientID, key,
	).Scan(&expiresAt, &state, &response)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("get MCP idempotency: %w", err)
	}
	if expiresAt <= now {
		if state == "pending" {
			return []byte(response), true, nil
		}
		if _, err := s.db.ExecContext(ctx, `
			DELETE FROM mcp_idempotency
			WHERE principal_id = ? AND client_id = ? AND idem_key = ?`,
			principalID, clientID, key,
		); err != nil {
			return nil, false, fmt.Errorf("delete expired MCP idempotency: %w", err)
		}
		return nil, false, nil
	}
	return []byte(response), true, nil
}

func (s *Store) PruneMCPData(ctx context.Context, now, auditBefore int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin MCP retention: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM mcp_idempotency WHERE expires_at <= ? AND state = 'completed'`, now); err != nil {
		return fmt.Errorf("prune MCP idempotency: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM mcp_audit_calls WHERE occurred_at < ?`, auditBefore); err != nil {
		return fmt.Errorf("prune MCP audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit MCP retention: %w", err)
	}
	return nil
}

func (s *Store) PutMCPIdempotency(ctx context.Context, principalID, clientID, key string, response []byte, ttl time.Duration, now int64) error {
	if principalID == "" || clientID == "" || key == "" {
		return fmt.Errorf("MCP idempotency principal, client, and key are required")
	}
	if len(response) == 0 {
		return fmt.Errorf("MCP idempotency response is required")
	}
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO mcp_idempotency (
			principal_id, client_id, idem_key, created_at, expires_at, state, response
		) VALUES (?, ?, ?, ?, ?, 'pending', ?)
		ON CONFLICT(principal_id, client_id, idem_key) DO NOTHING`,
		principalID, clientID, key, now, now+ttl.Milliseconds(), string(response),
	)
	if err != nil {
		return fmt.Errorf("put MCP idempotency: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return ErrMCPIdempotencyExists
	}
	return nil
}

func (s *Store) CompleteMCPIdempotency(ctx context.Context, principalID, clientID, key string, response []byte) error {
	if principalID == "" || clientID == "" || key == "" || len(response) == 0 {
		return fmt.Errorf("MCP idempotency completion fields are required")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE mcp_idempotency SET state = 'completed', response = ?
		WHERE principal_id = ? AND client_id = ? AND idem_key = ?`,
		string(response), principalID, clientID, key,
	)
	if err != nil {
		return fmt.Errorf("complete MCP idempotency: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteMCPIdempotency removes a pending operation only after an explicit
// admin decision. It is intentionally never called by automatic retry paths.
func (s *Store) DeleteMCPIdempotency(ctx context.Context, principalID, clientID, key string) error {
	result, err := s.db.ExecContext(ctx, `
		DELETE FROM mcp_idempotency
		WHERE principal_id = ? AND client_id = ? AND idem_key = ?`,
		principalID, clientID, key,
	)
	if err != nil {
		return fmt.Errorf("delete MCP idempotency: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return ErrNotFound
	}
	return nil
}

func mcpBoolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
