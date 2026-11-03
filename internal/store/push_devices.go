package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// PushDevice is one native installation registered with this node.
//
// The token is a capability: whoever holds it can deliver to that phone through
// APNs. It is therefore never returned by the API or written to logs. install_id
// is the app's own stable id, so reinstalling the app (which mints a new token)
// replaces the row instead of leaving a dead token that keeps failing.
type PushDevice struct {
	ID          string
	InstallID   string
	Platform    string
	Token       string
	Environment string
	Name        string
	// OwnerUserID is the account whose work this installation should be told
	// about. Empty means an operator registered it and it receives every event.
	OwnerUserID string
	// OwnerDeviceID is the paired device credential that registered it. It is
	// what makes unpairing able to delete the registration: revoking a device
	// credential and leaving its APNs row behind would keep a phone that is no
	// longer paired ringing with task titles.
	OwnerDeviceID string
	// OwnerSessionID is the browser session that registered it. Empty for an
	// operator-wide row or a paired device. A session-bound row stops receiving
	// when that session ends (sign-out, revocation, expiry): a phone showing the
	// sign-in screen must not keep ringing with the previous account's work.
	OwnerSessionID string
	CreatedAt      int64
	UpdatedAt      int64
	LastOKAt       int64
	LastAttemptAt  int64
	LastError      string
}

// PushDevicesDDL creates the native push registry.
//
// Exported so the migration and the every-open reconciler apply the same text,
// the same way the share table is kept in one place.
const PushDevicesDDL = `
CREATE TABLE IF NOT EXISTS push_devices (
  id              TEXT PRIMARY KEY,
  install_id      TEXT NOT NULL UNIQUE,
  platform        TEXT NOT NULL,
  token           TEXT NOT NULL,
  environment     TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  owner_user_id    TEXT NOT NULL DEFAULT '',
  owner_device_id  TEXT NOT NULL DEFAULT '',
  owner_session_id TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_ok_at      INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_devices_token ON push_devices(token);
CREATE INDEX IF NOT EXISTS idx_push_devices_updated ON push_devices(updated_at);
CREATE INDEX IF NOT EXISTS idx_push_devices_owner ON push_devices(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_push_devices_session ON push_devices(owner_session_id);`

// SavePushDevice records a registration and returns the id the row really
// carries.
//
// The conflict target is install_id, not token: the same installation rotates
// its token (restore, reinstall, APNs reissue) and must keep one row, while two
// installations must never collide just because they briefly shared a token.
// A token that moved to a different installation is removed from the old row
// by the unique index: the phone that just registered is the one that can
// receive, and the stale row would only produce a 410 on every send.
func (s *Store) SavePushDevice(ctx context.Context, d PushDevice) (string, error) {
	if d.ID == "" || d.InstallID == "" || d.Platform == "" || d.Token == "" || d.Environment == "" || d.UpdatedAt <= 0 {
		return "", errors.New("save push device: missing required field")
	}
	if d.CreatedAt <= 0 {
		d.CreatedAt = d.UpdatedAt
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("save push device: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM push_devices WHERE token = ? AND install_id <> ?`,
		d.Token, d.InstallID,
	); err != nil {
		return "", fmt.Errorf("save push device: release token: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO push_devices
			(id, install_id, platform, token, environment, name,
			 owner_user_id, owner_device_id, owner_session_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(install_id) DO UPDATE SET
			platform = excluded.platform,
			token = excluded.token,
			environment = excluded.environment,
			name = excluded.name,
			owner_user_id = excluded.owner_user_id,
			owner_device_id = excluded.owner_device_id,
			owner_session_id = excluded.owner_session_id,
			updated_at = excluded.updated_at,
			last_error = ''`,
		d.ID, d.InstallID, d.Platform, d.Token, d.Environment, d.Name,
		d.OwnerUserID, d.OwnerDeviceID, d.OwnerSessionID, d.CreatedAt, d.UpdatedAt,
	); err != nil {
		return "", fmt.Errorf("save push device: %w", err)
	}
	var id string
	if err := tx.QueryRowContext(ctx,
		`SELECT id FROM push_devices WHERE install_id = ?`, d.InstallID).Scan(&id); err != nil {
		return "", fmt.Errorf("save push device: read id: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("save push device: %w", err)
	}
	return id, nil
}

// ListPushDevices returns every registration, oldest first.
func (s *Store) ListPushDevices(ctx context.Context) ([]PushDevice, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, install_id, platform, token, environment, name,
		       owner_user_id, owner_device_id, owner_session_id, created_at, updated_at,
		       last_ok_at, last_attempt_at, last_error
		FROM push_devices
		ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("list push devices: %w", err)
	}
	defer rows.Close()
	var out []PushDevice
	for rows.Next() {
		var d PushDevice
		if err := rows.Scan(&d.ID, &d.InstallID, &d.Platform, &d.Token, &d.Environment, &d.Name,
			&d.OwnerUserID, &d.OwnerDeviceID, &d.OwnerSessionID, &d.CreatedAt, &d.UpdatedAt,
			&d.LastOKAt, &d.LastAttemptAt, &d.LastError); err != nil {
			return nil, fmt.Errorf("scan push device: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ListPushDevicesForOwner returns the registrations one account should be
// notified through: the rows it registered, plus operator-wide rows that have
// no owner. An empty owner is the operator's own work, not "everyone": only
// ownerless rows belong to it. A member's phone must not ring with an
// operator's task title, and an operator-wide row is the one that receives
// every event.
func (s *Store) ListPushDevicesForOwner(ctx context.Context, ownerUserID string) ([]PushDevice, error) {
	devices, err := s.ListPushDevices(ctx)
	if err != nil {
		return nil, err
	}
	out := devices[:0]
	for _, d := range devices {
		if d.OwnerUserID == "" || d.OwnerUserID == ownerUserID {
			out = append(out, d)
		}
	}
	return out, nil
}

// GetPushDevice returns one registration by id.
func (s *Store) GetPushDevice(ctx context.Context, id string) (PushDevice, error) {
	var d PushDevice
	err := s.db.QueryRowContext(ctx, `
		SELECT id, install_id, platform, token, environment, name,
		       owner_user_id, owner_device_id, owner_session_id, created_at, updated_at,
		       last_ok_at, last_attempt_at, last_error
		FROM push_devices WHERE id = ?`, id).Scan(
		&d.ID, &d.InstallID, &d.Platform, &d.Token, &d.Environment, &d.Name,
		&d.OwnerUserID, &d.OwnerDeviceID, &d.OwnerSessionID, &d.CreatedAt, &d.UpdatedAt,
		&d.LastOKAt, &d.LastAttemptAt, &d.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return PushDevice{}, ErrNotFound
	}
	if err != nil {
		return PushDevice{}, fmt.Errorf("get push device: %w", err)
	}
	return d, nil
}

// DeletePushDevice removes one registration by id.
func (s *Store) DeletePushDevice(ctx context.Context, id string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM push_devices WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete push device: %w", err)
	}
	return nil
}

// DeletePushDeviceByInstall removes the registration an app holds, which is the
// only handle an unregister request needs after a reinstall.
func (s *Store) DeletePushDeviceByInstall(ctx context.Context, installID string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM push_devices WHERE install_id = ?`, installID); err != nil {
		return fmt.Errorf("delete push device: %w", err)
	}
	return nil
}

// DeletePushDeviceByToken removes a token APNs reported as expired.
func (s *Store) DeletePushDeviceByToken(ctx context.Context, token string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM push_devices WHERE token = ?`, token); err != nil {
		return fmt.Errorf("delete push device: %w", err)
	}
	return nil
}

// MarkPushDeviceResult records the outcome of the last send. An empty errMsg is
// a success and advances last_ok_at; any other value is kept so the settings
// page can show why this device did not ring.
func (s *Store) MarkPushDeviceResult(ctx context.Context, id string, at int64, errMsg string) error {
	if at <= 0 {
		return errors.New("mark push device: missing timestamp")
	}
	var err error
	if errMsg == "" {
		_, err = s.db.ExecContext(ctx,
			`UPDATE push_devices SET last_ok_at = ?, last_attempt_at = ?, last_error = '' WHERE id = ?`,
			at, at, id)
	} else {
		_, err = s.db.ExecContext(ctx,
			`UPDATE push_devices SET last_attempt_at = ?, last_error = ? WHERE id = ?`,
			at, errMsg, id)
	}
	if err != nil {
		return fmt.Errorf("mark push device: %w", err)
	}
	return nil
}

// CountPushDevices reports how many installations would receive a message.
func (s *Store) CountPushDevices(ctx context.Context) (int, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_devices`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count push devices: %w", err)
	}
	return n, nil
}
