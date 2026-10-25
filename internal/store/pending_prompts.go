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

// PendingPrompt is a message the user sent while the task was still running,
// waiting for the next turn boundary.
//
// It is durable rather than in-memory because the sender is usually a phone
// that has since been locked: the promise made when the message is accepted is
// "this will be delivered", and a slot in a map cannot keep that promise across
// a daemon restart.
//
// UserSeq ties the row to the message the user can see. The event is written
// first, at accept time, and this row follows it, so the queue can always be
// read back as "these visible messages have not been answered yet" -- which is
// also what the turn that finally answers one uses as its checkpoint anchor. A
// failure between the two writes leaves a visible message the sender is told
// about, never a queued message nobody can see.
type PendingPrompt struct {
	ID     int64  `json:"id"`
	TaskID string `json:"task_id"`
	Prompt string `json:"prompt"`
	Agent  string `json:"agent,omitempty"`
	// Model and PermissionMode are nil when the sender said nothing, which is a
	// different instruction from an empty string (clear the setting). The same
	// distinction exists in the request these were built from.
	Model          *string `json:"model,omitempty"`
	PermissionMode *string `json:"permission_mode,omitempty"`
	// UserSeq is the seq of the "message" event this row promises to deliver.
	// Zero means the event was never written, and the delivery path writes it
	// then, so a queue row is never a message that exists only in the queue.
	UserSeq  int   `json:"user_seq,omitempty"`
	QueuedAt int64 `json:"queued_at"`
}

const pendingPromptColumns = `
	id, task_id, prompt, agent, model, permission_mode, user_seq, queued_at`

func scanPendingPrompt(scanner interface {
	Scan(dest ...any) error
}) (PendingPrompt, error) {
	var p PendingPrompt
	var model, mode sql.NullString
	if err := scanner.Scan(
		&p.ID, &p.TaskID, &p.Prompt, &p.Agent, &model, &mode, &p.UserSeq, &p.QueuedAt,
	); err != nil {
		return PendingPrompt{}, err
	}
	p.Model = nullableStringPtr(model)
	p.PermissionMode = nullableStringPtr(mode)
	return p, nil
}

// TasksWithPendingPrompts lists every task that has a message waiting, in no
// particular order.
//
// Recovery is why this exists: after a restart the set of tasks needing a
// deliverer cannot be derived from task status, because a queue is accepted for
// statuses a restart does not fail (a task waiting on a user question keeps its
// status, and its queue with it). Ask the queue which tasks need delivering and
// the answer cannot go stale as statuses change.
func (s *Store) TasksWithPendingPrompts(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT DISTINCT task_id FROM task_pending_prompts`)
	if err != nil {
		return nil, fmt.Errorf("list tasks with pending prompts: %w", err)
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
	return ids, rows.Err()
}

// AppendPendingPrompt adds a message to the tail of a task's queue and returns
// it with its assigned id.
func (s *Store) AppendPendingPrompt(ctx context.Context, p PendingPrompt) (PendingPrompt, error) {
	if strings.TrimSpace(p.TaskID) == "" {
		return PendingPrompt{}, fmt.Errorf("pending prompt task_id is required")
	}
	if strings.TrimSpace(p.Prompt) == "" {
		return PendingPrompt{}, fmt.Errorf("pending prompt text is required")
	}
	if p.QueuedAt <= 0 {
		p.QueuedAt = time.Now().UnixMilli()
	}
	var model, mode any
	if p.Model != nil {
		model = *p.Model
	}
	if p.PermissionMode != nil {
		mode = *p.PermissionMode
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO task_pending_prompts (
			task_id, prompt, agent, model, permission_mode, user_seq, queued_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		p.TaskID, p.Prompt, p.Agent, model, mode, p.UserSeq, p.QueuedAt)
	if err != nil {
		return PendingPrompt{}, fmt.Errorf("append pending prompt: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return PendingPrompt{}, fmt.Errorf("append pending prompt id: %w", err)
	}
	p.ID = id
	return p, nil
}

// ListPendingPrompts returns a task's queued messages in the order they were
// sent, oldest first. An empty queue is an empty slice and no error.
func (s *Store) ListPendingPrompts(ctx context.Context, taskID string) ([]PendingPrompt, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+pendingPromptColumns+`
		FROM task_pending_prompts WHERE task_id = ? ORDER BY id ASC`, taskID)
	if err != nil {
		return nil, fmt.Errorf("list pending prompts: %w", err)
	}
	defer rows.Close()
	var out []PendingPrompt
	for rows.Next() {
		p, err := scanPendingPrompt(rows)
		if err != nil {
			return nil, fmt.Errorf("scan pending prompt: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pending prompts: %w", err)
	}
	return out, nil
}

// PopPendingPrompt removes and returns the oldest queued message for a task.
// The bool is false when the queue is empty, which is a normal outcome (two
// turn boundaries can race for the same last message) rather than an error.
//
// Select-then-delete in one transaction, so two drains cannot take the same row
// and the second one gets the next message instead of a duplicate.
func (s *Store) PopPendingPrompt(ctx context.Context, taskID string) (PendingPrompt, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PendingPrompt{}, false, fmt.Errorf("begin pop pending prompt: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	p, err := scanPendingPrompt(tx.QueryRowContext(ctx, `SELECT `+pendingPromptColumns+`
		FROM task_pending_prompts WHERE task_id = ? ORDER BY id ASC LIMIT 1`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return PendingPrompt{}, false, nil
	}
	if err != nil {
		return PendingPrompt{}, false, fmt.Errorf("read pending prompt head: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM task_pending_prompts WHERE id = ?`, p.ID); err != nil {
		return PendingPrompt{}, false, fmt.Errorf("pop pending prompt: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return PendingPrompt{}, false, fmt.Errorf("commit pop pending prompt: %w", err)
	}
	return p, true, nil
}

// DiscardPendingPrompts drops a task's whole queue and writes the transcript report
// that says how many messages went with it, returning the event for the caller to
// publish. Nil means the queue was empty.
//
// The delete and the report are one transaction, and the count is why: nobody
// outside this transaction ever learns how many messages were dropped, so a report
// written afterwards is one the process can die before making -- leaving a user whose
// messages are gone with nothing that says so. The retry that rewinds a transcript
// writes its own discard report the same way, for the same reason.
func (s *Store) DiscardPendingPrompts(ctx context.Context, taskID string) (*Event, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("discard pending prompts: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx, `DELETE FROM task_pending_prompts WHERE task_id = ?`, taskID)
	if err != nil {
		return nil, fmt.Errorf("clear pending prompts: %w", err)
	}
	changed, err := res.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("clear pending prompts count: %w", err)
	}
	if changed == 0 {
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("discard pending prompts: %w", err)
		}
		return nil, nil
	}
	payload, _ := json.Marshal(map[string]any{
		"message": fmt.Sprintf("%d queued prompt(s) discarded with the canceled task", changed),
		"count":   int(changed),
	})
	ev, err := appendEventTx(ctx, tx, taskID, "error", payload)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("discard pending prompts: %w", err)
	}
	return &ev, nil
}

func nullableStringPtr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}
