package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Approval decision values.
const (
	DecisionPending  = "pending"
	DecisionApproved = "approved"
	DecisionDenied   = "denied"
	DecisionExpired  = "expired"
)

// DefaultApprovalTTL is how long an approval may stay pending (spec §4.2).
const DefaultApprovalTTL = time.Hour

// Approval is a row in the approvals table, optionally joined with task fields.
type Approval struct {
	ID         string          `json:"id"`
	TaskID     string          `json:"task_id"`
	Kind       string          `json:"kind"`
	Payload    json.RawMessage `json:"payload"`
	Decision   string          `json:"decision"`
	DecidedVia *string         `json:"decided_via,omitempty"`
	CreatedAt  int64           `json:"created_at"`
	DecidedAt  *int64          `json:"decided_at,omitempty"`
	// Joined from tasks (list endpoint).
	TaskTitle string `json:"task_title,omitempty"`
	TaskAgent string `json:"task_agent,omitempty"`
}

const approvalColumns = `id, task_id, kind, payload, decision, decided_via, created_at, decided_at`

func scanApproval(scanner interface {
	Scan(dest ...any) error
}) (Approval, error) {
	var a Approval
	var payload string
	var decidedVia sql.NullString
	var decidedAt sql.NullInt64
	if err := scanner.Scan(
		&a.ID, &a.TaskID, &a.Kind, &payload, &a.Decision,
		&decidedVia, &a.CreatedAt, &decidedAt,
	); err != nil {
		return Approval{}, err
	}
	a.Payload = json.RawMessage(payload)
	if decidedVia.Valid {
		a.DecidedVia = &decidedVia.String
	}
	if decidedAt.Valid {
		a.DecidedAt = &decidedAt.Int64
	}
	return a, nil
}

// InsertApproval inserts a new pending approval.
func (s *Store) InsertApproval(ctx context.Context, a Approval) error {
	if a.Decision == "" {
		a.Decision = DecisionPending
	}
	payload := string(a.Payload)
	if payload == "" {
		payload = "{}"
	}
	var decidedVia any
	if a.DecidedVia != nil {
		decidedVia = *a.DecidedVia
	}
	var decidedAt any
	if a.DecidedAt != nil {
		decidedAt = *a.DecidedAt
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO approvals (
			id, task_id, kind, payload, decision, decided_via, created_at, decided_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.TaskID, a.Kind, payload, a.Decision, decidedVia, a.CreatedAt, decidedAt,
	)
	if err != nil {
		return fmt.Errorf("insert approval: %w", err)
	}
	return nil
}

// GetApproval returns a single approval by id.
func (s *Store) GetApproval(ctx context.Context, id string) (Approval, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+approvalColumns+` FROM approvals WHERE id = ?`, id)
	a, err := scanApproval(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Approval{}, ErrNotFound
	}
	if err != nil {
		return Approval{}, fmt.Errorf("get approval: %w", err)
	}
	return a, nil
}

// ListApprovalsOpts filters for ListApprovals.
type ListApprovalsOpts struct {
	Status string // empty = all; typically "pending"
	Limit  int
}

// ListApprovals returns approvals ordered by created_at desc, with task title/agent joined.
func (s *Store) ListApprovals(ctx context.Context, opts ListApprovalsOpts) ([]Approval, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	var b strings.Builder
	args := make([]any, 0, 2)
	b.WriteString(`
		SELECT a.id, a.task_id, a.kind, a.payload, a.decision, a.decided_via,
		       a.created_at, a.decided_at, t.title, t.agent
		FROM approvals a
		JOIN tasks t ON t.id = a.task_id
		WHERE 1=1`)
	if opts.Status != "" {
		b.WriteString(` AND a.decision = ?`)
		args = append(args, opts.Status)
	}
	b.WriteString(` ORDER BY a.created_at DESC LIMIT ?`)
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list approvals: %w", err)
	}
	defer rows.Close()

	out := make([]Approval, 0)
	for rows.Next() {
		var a Approval
		var payload string
		var decidedVia sql.NullString
		var decidedAt sql.NullInt64
		if err := rows.Scan(
			&a.ID, &a.TaskID, &a.Kind, &payload, &a.Decision,
			&decidedVia, &a.CreatedAt, &decidedAt,
			&a.TaskTitle, &a.TaskAgent,
		); err != nil {
			return nil, fmt.Errorf("scan approval: %w", err)
		}
		a.Payload = json.RawMessage(payload)
		if decidedVia.Valid {
			a.DecidedVia = &decidedVia.String
		}
		if decidedAt.Valid {
			a.DecidedAt = &decidedAt.Int64
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountApprovals returns how many approvals match decision status.
func (s *Store) CountApprovals(ctx context.Context, decision string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM approvals WHERE decision = ?`, decision,
	).Scan(&n)
	return n, err
}

// ErrAlreadyDecided is returned when deciding a non-pending approval.
var ErrAlreadyDecided = errors.New("approval already decided")

// DecideApproval sets decision/decided_at/decided_via only if still pending.
// Returns ErrNotFound if the row is missing; ErrAlreadyDecided if no longer pending.
func (s *Store) DecideApproval(ctx context.Context, id, decision, via string, decidedAt int64) (Approval, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE approvals
		SET decision = ?, decided_via = ?, decided_at = ?
		WHERE id = ? AND decision = ?`,
		decision, via, decidedAt, id, DecisionPending,
	)
	if err != nil {
		return Approval{}, fmt.Errorf("decide approval: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// Distinguish missing vs already decided.
		if _, err := s.GetApproval(ctx, id); errors.Is(err, ErrNotFound) {
			return Approval{}, ErrNotFound
		}
		return Approval{}, ErrAlreadyDecided
	}
	return s.GetApproval(ctx, id)
}

// ListPendingOlderThan returns pending approvals with created_at < cutoffMs.
func (s *Store) ListPendingOlderThan(ctx context.Context, cutoffMs int64) ([]Approval, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+approvalColumns+`
		FROM approvals
		WHERE decision = ? AND created_at < ?
		ORDER BY created_at ASC`, DecisionPending, cutoffMs)
	if err != nil {
		return nil, fmt.Errorf("list pending older: %w", err)
	}
	defer rows.Close()

	out := make([]Approval, 0)
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListPendingForTask returns pending approvals for a task.
func (s *Store) ListPendingForTask(ctx context.Context, taskID string) ([]Approval, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+approvalColumns+`
		FROM approvals
		WHERE task_id = ? AND decision = ?
		ORDER BY created_at ASC`, taskID, DecisionPending)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Approval, 0)
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
