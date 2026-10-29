package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// SessionShare is a public, revocable, read-only window onto one task.
//
// The link's token is never stored — only its digest, the same way device
// credentials are kept. A database read therefore cannot mint a working link,
// and revoking is a row update rather than a hunt for copies of a secret.
type SessionShare struct {
	ID        string
	TaskID    string
	TokenHash string
	CreatedAt int64
	// ExpiresAt bounds the link's life; 0 means it lives until revoked.
	ExpiresAt int64
	// RevokedAt is when the owner withdrew it; 0 means live.
	RevokedAt int64
}

// SessionSharesDDL creates the share table and its lookup index.
//
// Exported so the migration and the every-open reconciler apply the same text:
// one definition, two callers, no chance of the two drifting apart.
const SessionSharesDDL = `
CREATE TABLE IF NOT EXISTS session_shares (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_shares_task ON session_shares(task_id);`

// InsertSessionShare records a newly minted link.
func (s *Store) InsertSessionShare(ctx context.Context, share SessionShare) error {
	if share.ID == "" || share.TaskID == "" || share.TokenHash == "" || share.CreatedAt <= 0 {
		return errors.New("insert session share: missing required field")
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO session_shares (id, task_id, token_hash, created_at, expires_at, revoked_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		share.ID, share.TaskID, share.TokenHash, share.CreatedAt, share.ExpiresAt, share.RevokedAt,
	); err != nil {
		return fmt.Errorf("insert session share: %w", err)
	}
	return nil
}

// ReplaceSessionShare revokes every live link for a task and records the new
// one, in one transaction.
//
// Minting a link is how an owner replaces one they have lost, so the old link
// must stop working in the same step — otherwise "create a new link" leaves two
// doors open. Doing it in two statements also meant a failed insert destroyed
// the old link and returned an error with nothing to show for it.
func (s *Store) ReplaceSessionShare(ctx context.Context, share SessionShare) error {
	if share.ID == "" || share.TaskID == "" || share.TokenHash == "" || share.CreatedAt <= 0 {
		return errors.New("replace session share: missing required field")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("replace session share: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		UPDATE session_shares SET revoked_at = ?
		WHERE task_id = ? AND revoked_at = 0`, share.CreatedAt, share.TaskID); err != nil {
		return fmt.Errorf("replace session share: revoke: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO session_shares (id, task_id, token_hash, created_at, expires_at, revoked_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		share.ID, share.TaskID, share.TokenHash, share.CreatedAt, share.ExpiresAt, share.RevokedAt,
	); err != nil {
		return fmt.Errorf("replace session share: insert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("replace session share: commit: %w", err)
	}
	return nil
}

// ActiveSessionShare returns the live link for a task, if there is one.
//
// One live link per task is the contract the API keeps (creating a new one
// revokes the old one), so a caller can treat this as "the link".
func (s *Store) ActiveSessionShare(ctx context.Context, taskID string, now int64) (SessionShare, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, task_id, token_hash, created_at, expires_at, revoked_at
		FROM session_shares
		WHERE task_id = ? AND revoked_at = 0 AND (expires_at = 0 OR expires_at > ?)
		ORDER BY created_at DESC
		LIMIT 1`, taskID, now)
	share, err := scanSessionShare(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionShare{}, false, nil
	}
	if err != nil {
		return SessionShare{}, false, fmt.Errorf("active session share: %w", err)
	}
	return share, true, nil
}

// SessionShareByTokenHash resolves a presented token digest to a live link.
func (s *Store) SessionShareByTokenHash(ctx context.Context, tokenHash string, now int64) (SessionShare, bool, error) {
	if tokenHash == "" {
		return SessionShare{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT id, task_id, token_hash, created_at, expires_at, revoked_at
		FROM session_shares
		WHERE token_hash = ? AND revoked_at = 0 AND (expires_at = 0 OR expires_at > ?)`,
		tokenHash, now)
	share, err := scanSessionShare(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionShare{}, false, nil
	}
	if err != nil {
		return SessionShare{}, false, fmt.Errorf("session share by token: %w", err)
	}
	return share, true, nil
}

// RevokeSessionShares withdraws every live link for a task and reports how many
// it closed. Revoking twice is not an error: the second call closes nothing.
func (s *Store) RevokeSessionShares(ctx context.Context, taskID string, now int64) (int64, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE session_shares SET revoked_at = ?
		WHERE task_id = ? AND revoked_at = 0`, now, taskID)
	if err != nil {
		return 0, fmt.Errorf("revoke session shares: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("revoke session shares: %w", err)
	}
	return n, nil
}

// ListMessageEvents returns a task's message events in order, oldest first.
//
// The public share reads the conversation through this rather than the whole
// event log: tool calls, usage records and raw stream chunks are not what a
// reader came for, and not what an owner meant to publish. A non-positive limit
// returns every message row; callers serving an unauthenticated request pass
// one.
//
// A limit keeps the *newest* rows and the answer is still oldest-first: a link
// is usually shared for what just happened, and a page that stops before the
// conclusion answers the reader's question least of all. The console pages a
// long transcript the same way, from the end backwards.
func (s *Store) ListMessageEvents(ctx context.Context, taskID string, limit int) ([]Event, error) {
	query := `
		SELECT e.task_id, t.event_epoch, e.seq, e.ts, e.type, e.payload
		FROM events e
		JOIN tasks t ON t.id = e.task_id
		WHERE e.task_id = ? AND e.type = 'message'`
	args := []any{taskID}
	if limit > 0 {
		query += ` ORDER BY e.seq DESC LIMIT ?`
		args = append(args, limit)
	} else {
		query += ` ORDER BY e.seq ASC`
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list message events: %w", err)
	}
	defer rows.Close()

	out := make([]Event, 0)
	for rows.Next() {
		var e Event
		var payload string
		if err := rows.Scan(&e.TaskID, &e.EventEpoch, &e.Seq, &e.TS, &e.Type, &payload); err != nil {
			return nil, fmt.Errorf("scan message event: %w", err)
		}
		e.Payload = json.RawMessage(payload)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if limit > 0 {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	return out, nil
}

func scanSessionShare(row *sql.Row) (SessionShare, error) {
	var share SessionShare
	err := row.Scan(&share.ID, &share.TaskID, &share.TokenHash, &share.CreatedAt, &share.ExpiresAt, &share.RevokedAt)
	return share, err
}
