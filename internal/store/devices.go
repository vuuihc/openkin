package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// PairingSession is a one-time secret issued to a local/master-authenticated
// client. SecretHash is never returned to callers.
type PairingSession struct {
	SecretHash string
	Label      string
	CreatedAt  int64
	ExpiresAt  int64
	UsedAt     *int64
}

// DeviceCredential is a revocable scoped credential for a native client.
// TokenHash is never returned to API clients.
type DeviceCredential struct {
	ID         string
	TokenHash  string
	Label      string
	CreatedAt  int64
	LastUsedAt *int64
	RevokedAt  *int64
}

func (s *Store) CreatePairingSession(ctx context.Context, session PairingSession) error {
	if session.SecretHash == "" || session.CreatedAt <= 0 || session.ExpiresAt <= session.CreatedAt {
		return fmt.Errorf("invalid pairing session")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO pairing_sessions (secret_hash, label, created_at, expires_at)
		VALUES (?, ?, ?, ?)`,
		session.SecretHash, session.Label, session.CreatedAt, session.ExpiresAt)
	if err != nil {
		return fmt.Errorf("create pairing session: %w", err)
	}
	return nil
}

// ConsumePairingSession atomically consumes a non-expired session.
func (s *Store) ConsumePairingSession(ctx context.Context, secretHash string, now int64) (PairingSession, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PairingSession{}, fmt.Errorf("begin pairing exchange: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var session PairingSession
	var usedAt sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT secret_hash, label, created_at, expires_at, used_at
		FROM pairing_sessions WHERE secret_hash = ?`, secretHash).
		Scan(&session.SecretHash, &session.Label, &session.CreatedAt, &session.ExpiresAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return PairingSession{}, ErrNotFound
	}
	if err != nil {
		return PairingSession{}, fmt.Errorf("read pairing session: %w", err)
	}
	if usedAt.Valid || session.ExpiresAt <= now {
		return PairingSession{}, ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE pairing_sessions SET used_at = ? WHERE secret_hash = ? AND used_at IS NULL`,
		now, secretHash); err != nil {
		return PairingSession{}, fmt.Errorf("consume pairing session: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return PairingSession{}, fmt.Errorf("commit pairing exchange: %w", err)
	}
	session.UsedAt = &now
	return session, nil
}

func (s *Store) InsertDeviceCredential(ctx context.Context, credential DeviceCredential) error {
	if credential.ID == "" || credential.TokenHash == "" || credential.CreatedAt <= 0 {
		return fmt.Errorf("invalid device credential")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO device_credentials (id, token_hash, label, created_at)
		VALUES (?, ?, ?, ?)`,
		credential.ID, credential.TokenHash, credential.Label, credential.CreatedAt)
	if err != nil {
		return fmt.Errorf("insert device credential: %w", err)
	}
	return nil
}

func (s *Store) AuthenticateDevice(ctx context.Context, tokenHash string, now int64) (DeviceCredential, error) {
	var credential DeviceCredential
	var lastUsed, revoked sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, token_hash, label, created_at, last_used_at, revoked_at
		FROM device_credentials
		WHERE token_hash = ? AND revoked_at IS NULL`, tokenHash).
		Scan(&credential.ID, &credential.TokenHash, &credential.Label, &credential.CreatedAt, &lastUsed, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return DeviceCredential{}, ErrNotFound
	}
	if err != nil {
		return DeviceCredential{}, fmt.Errorf("authenticate device: %w", err)
	}
	if lastUsed.Valid {
		value := lastUsed.Int64
		credential.LastUsedAt = &value
	}
	if revoked.Valid {
		value := revoked.Int64
		credential.RevokedAt = &value
	}
	_, err = s.db.ExecContext(ctx, `UPDATE device_credentials SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL`, now, credential.ID)
	if err != nil {
		return DeviceCredential{}, fmt.Errorf("touch device credential: %w", err)
	}
	value := now
	credential.LastUsedAt = &value
	return credential, nil
}

// DeviceActive reports whether a credential remains usable after a long-lived
// connection has already passed the initial authentication handshake.
func (s *Store) DeviceActive(ctx context.Context, id string) (bool, error) {
	var active int
	err := s.db.QueryRowContext(ctx, `
		SELECT CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END
		FROM device_credentials WHERE id = ?`, id).Scan(&active)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrNotFound
	}
	if err != nil {
		return false, fmt.Errorf("check device credential: %w", err)
	}
	return active == 1, nil
}

func (s *Store) ListDeviceCredentials(ctx context.Context) ([]DeviceCredential, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, token_hash, label, created_at, last_used_at, revoked_at
		FROM device_credentials ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list device credentials: %w", err)
	}
	defer rows.Close()
	out := make([]DeviceCredential, 0)
	for rows.Next() {
		var credential DeviceCredential
		var lastUsed, revoked sql.NullInt64
		if err := rows.Scan(&credential.ID, &credential.TokenHash, &credential.Label, &credential.CreatedAt, &lastUsed, &revoked); err != nil {
			return nil, fmt.Errorf("scan device credential: %w", err)
		}
		if lastUsed.Valid {
			value := lastUsed.Int64
			credential.LastUsedAt = &value
		}
		if revoked.Valid {
			value := revoked.Int64
			credential.RevokedAt = &value
		}
		out = append(out, credential)
	}
	return out, rows.Err()
}

func (s *Store) RevokeDeviceCredential(ctx context.Context, id string, now int64) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE device_credentials SET revoked_at = ?
		WHERE id = ? AND revoked_at IS NULL`, now, id)
	if err != nil {
		return fmt.Errorf("revoke device credential: %w", err)
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RevokeAllDeviceCredentials(ctx context.Context, now int64) error {
	if _, err := s.db.ExecContext(ctx, `
		UPDATE device_credentials SET revoked_at = ?
		WHERE revoked_at IS NULL`, now); err != nil {
		return fmt.Errorf("revoke device credentials: %w", err)
	}
	return nil
}

func UnixMillis(t time.Time) int64 { return t.UnixMilli() }
