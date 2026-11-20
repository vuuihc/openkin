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

// ErrPromptOrderInvalid is returned by SetPendingPromptOrder when the list
// cannot express an order: an id is repeated or is not a row id at all. Nothing
// is written; this is a request-shape error rather than a stale queue.
var ErrPromptOrderInvalid = errors.New("pending prompt order is invalid")

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
	// Position is the delivery order within the task's queue: lower goes first,
	// and the id breaks a tie. Rows written before the column existed share 0,
	// which reproduces the old id order. It is an ordering key, not an index:
	// delivering a message leaves a hole and nothing renumbers the survivors.
	Position int64 `json:"position"`
}

const pendingPromptColumns = `
	id, task_id, prompt, agent, model, permission_mode, user_seq, queued_at, position`

func scanPendingPrompt(scanner interface {
	Scan(dest ...any) error
}) (PendingPrompt, error) {
	var p PendingPrompt
	var model, mode sql.NullString
	if err := scanner.Scan(
		&p.ID, &p.TaskID, &p.Prompt, &p.Agent, &model, &mode, &p.UserSeq, &p.QueuedAt, &p.Position,
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
	// The insert and the position read share one transaction: a turn boundary
	// can pop the message the instant it is visible, and a second statement
	// outside the transaction would read the position of a row that no longer
	// exists -- failing an append whose message was already queued (and
	// possibly already delivered).
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PendingPrompt{}, fmt.Errorf("begin append pending prompt: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx, `
		INSERT INTO task_pending_prompts (
			task_id, prompt, agent, model, permission_mode, user_seq, queued_at, position
		) VALUES (?, ?, ?, ?, ?, ?, ?,
			(SELECT COALESCE(MAX(position), 0) + 1 FROM task_pending_prompts WHERE task_id = ?))`,
		p.TaskID, p.Prompt, p.Agent, model, mode, p.UserSeq, p.QueuedAt, p.TaskID)
	if err != nil {
		return PendingPrompt{}, fmt.Errorf("append pending prompt: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return PendingPrompt{}, fmt.Errorf("append pending prompt id: %w", err)
	}
	p.ID = id
	if err := tx.QueryRowContext(ctx,
		`SELECT position FROM task_pending_prompts WHERE id = ?`, id).Scan(&p.Position); err != nil {
		return PendingPrompt{}, fmt.Errorf("append pending prompt position: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return PendingPrompt{}, fmt.Errorf("commit append pending prompt: %w", err)
	}
	return p, nil
}

// UndeliveredPromptsMessage is the sentence a report carries when a turn ends
// without delivering the messages queued behind it. It lives here because the
// transaction that ends the task writes it and the engine's tail-window report
// must say the same thing; tests and clients match on "not delivered".
func UndeliveredPromptsMessage(count int, reason string) string {
	return fmt.Sprintf("%d queued prompt(s) not delivered: %s", count, reason)
}

// pendingPromptsWatermarkTx reads a task's queue inside the caller's
// transaction: how many messages it holds, and the highest row id among them.
// The id is an AUTOINCREMENT rowid, so it only grows -- every message inserted
// after this read has a larger one. That is what lets the caller's tail settle
// tell a message accepted after the transition from one the transaction already
// named, even when a counted message is withdrawn in between (a plain count
// cannot: removing a named message from the head would hide a later one).
func pendingPromptsWatermarkTx(ctx context.Context, tx *sql.Tx, taskID string) (count int, maxID int64, err error) {
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(MAX(id), 0) FROM task_pending_prompts WHERE task_id = ?`, taskID,
	).Scan(&count, &maxID); err != nil {
		return 0, 0, fmt.Errorf("read pending prompt watermark: %w", err)
	}
	return count, maxID, nil
}

// ListPendingPrompts returns a task's queued messages in delivery order: the
// order the person set, oldest first for rows that share a position (every row
// written before ordering existed). An empty queue is an empty slice and no
// error.
func (s *Store) ListPendingPrompts(ctx context.Context, taskID string) ([]PendingPrompt, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+pendingPromptColumns+`
		FROM task_pending_prompts WHERE task_id = ? ORDER BY position ASC, id ASC`, taskID)
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

// PopPendingPrompt removes and returns the next queued message for a task, in
// delivery order. The bool is false when the queue is empty, which is a normal
// outcome (two turn boundaries can race for the same last message) rather than
// an error.
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
		FROM task_pending_prompts WHERE task_id = ? ORDER BY position ASC, id ASC LIMIT 1`, taskID))
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

// SetPendingPromptOrder rewrites a task's delivery order and returns the whole
// queue in the new order.
//
// ids must name every message currently queued for the task exactly once, in
// the order the next turns should answer them. Positions are rewritten 1..N in
// one transaction, so a message queued while this runs either lands before the
// rewrite (and must appear in ids) or after it (at the tail); it can never be
// silently skipped. Ids never move -- the finalize watermark reads MAX(id) and
// clients key rows on it -- and a reorder writes no transcript event, because
// the messages already exist and their wording does not change.
//
// The answer is the queue as it now stands, not a delta: a list applied to a
// queue that changed in between would compose an order that never existed.
//
// The errors are typed so the handler never needs a second read, which a
// delivery could invalidate between the read and the write:
//   - ErrPromptOrderInvalid for a duplicate or non-positive id;
//   - ErrNotFound for an unknown task;
//   - ErrConflict when the list is not exactly the current queue: a queued id
//     is omitted, or a submitted id is absent -- never queued, or already
//     delivered or withdrawn. One answer covers every stale-list case, because
//     a delivered id and a never-queued id are the same observable state once
//     the row is gone.
func (s *Store) SetPendingPromptOrder(ctx context.Context, taskID string, ids []int64) ([]PendingPrompt, error) {
	if strings.TrimSpace(taskID) == "" {
		return nil, fmt.Errorf("pending prompt task_id is required")
	}
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id <= 0 {
			return nil, fmt.Errorf("%w: id %d is not a row id", ErrPromptOrderInvalid, id)
		}
		if seen[id] {
			return nil, fmt.Errorf("%w: id %d appears twice", ErrPromptOrderInvalid, id)
		}
		seen[id] = true
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin reorder pending prompts: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var taskExists int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM tasks WHERE id = ?`, taskID).Scan(&taskExists); err != nil {
		return nil, fmt.Errorf("read pending prompt order task: %w", err)
	}
	if taskExists == 0 {
		return nil, fmt.Errorf("reorder pending prompts: %w", ErrNotFound)
	}

	rows, err := tx.QueryContext(ctx,
		`SELECT id FROM task_pending_prompts WHERE task_id = ?`, taskID)
	if err != nil {
		return nil, fmt.Errorf("read pending prompt order: %w", err)
	}
	queued := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan pending prompt order: %w", err)
		}
		queued[id] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate pending prompt order: %w", err)
	}
	rows.Close()

	// Every submitted id has to still be queued, and every queued id has to be
	// submitted. Both failures are the same stale-list answer: after a delivery
	// the row is gone, so an id that was delivered is indistinguishable from one
	// that was never queued, and the caller refetches either way.
	for _, id := range ids {
		if !queued[id] {
			return nil, fmt.Errorf("%w: id %d is not queued", ErrConflict, id)
		}
	}
	if len(ids) != len(queued) {
		return nil, fmt.Errorf("%w: the list is missing a queued message", ErrConflict)
	}

	for i, id := range ids {
		res, err := tx.ExecContext(ctx,
			`UPDATE task_pending_prompts SET position = ? WHERE id = ? AND task_id = ?`,
			int64(i+1), id, taskID)
		if err != nil {
			return nil, fmt.Errorf("write pending prompt position: %w", err)
		}
		changed, err := res.RowsAffected()
		if err != nil {
			return nil, fmt.Errorf("count pending prompt position: %w", err)
		}
		if changed != 1 {
			// The row left the queue after the read above. Roll back the
			// positions already written rather than answer with a half-order.
			return nil, fmt.Errorf("%w: id %d is not queued", ErrConflict, id)
		}
	}

	ordered, err := pendingPromptsTx(ctx, tx, taskID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit reorder pending prompts: %w", err)
	}
	return ordered, nil
}

// pendingPromptsTx reads a task's queue inside the caller's transaction, in
// delivery order.
func pendingPromptsTx(ctx context.Context, tx *sql.Tx, taskID string) ([]PendingPrompt, error) {
	rows, err := tx.QueryContext(ctx, `SELECT `+pendingPromptColumns+`
		FROM task_pending_prompts WHERE task_id = ? ORDER BY position ASC, id ASC`, taskID)
	if err != nil {
		return nil, fmt.Errorf("read reordered pending prompts: %w", err)
	}
	defer rows.Close()
	var out []PendingPrompt
	for rows.Next() {
		p, err := scanPendingPrompt(rows)
		if err != nil {
			return nil, fmt.Errorf("scan reordered pending prompt: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate reordered pending prompts: %w", err)
	}
	return out, nil
}

// WithdrawPendingPrompt removes one queued message and writes the transcript
// note that says it will not be delivered, returning the event for the caller to
// publish. The bool is false when the row was already gone.
//
// The note is why this is not a plain delete. A queued message is already in the
// transcript — the event was written when it was accepted — and events do not
// change once written, so withdrawing the queue row leaves the bubble on screen.
// Without a note every device would read that bubble as delivered; with one the
// transcript says, in order, what the sender did. The delete and the note share
// a transaction for the same reason the discard report does: a process that dies
// between them would leave a message nobody will answer and no record of why.
//
// The task id is part of the match, so a row id from one task cannot prune
// another task's queue. False is a normal answer rather than an error: a turn
// boundary may have drained the message between the list the console drew and
// the tap that withdrew it, and the next read of the queue says so.
func (s *Store) WithdrawPendingPrompt(ctx context.Context, taskID string, id int64) (*Event, bool, error) {
	if strings.TrimSpace(taskID) == "" {
		return nil, false, fmt.Errorf("pending prompt task_id is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, fmt.Errorf("withdraw pending prompt: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx,
		`DELETE FROM task_pending_prompts WHERE id = ? AND task_id = ?`, id, taskID)
	if err != nil {
		return nil, false, fmt.Errorf("withdraw pending prompt: %w", err)
	}
	removed, err := res.RowsAffected()
	if err != nil {
		return nil, false, fmt.Errorf("withdraw pending prompt count: %w", err)
	}
	if removed == 0 {
		if err := tx.Commit(); err != nil {
			return nil, false, fmt.Errorf("withdraw pending prompt: %w", err)
		}
		return nil, false, nil
	}
	// The message text is deliberately not repeated here: a withdrawal is often
	// the sender taking back something they wish they had not sent, and copying
	// it into a second event would keep a copy they just asked to remove.
	payload, _ := json.Marshal(map[string]any{
		"code":     "prompt_withdrawn",
		"message":  "A queued message was withdrawn before it was sent",
		"severity": "info",
	})
	ev, err := appendEventTx(ctx, tx, taskID, "notice", payload)
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, fmt.Errorf("withdraw pending prompt: %w", err)
	}
	return &ev, true, nil
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
