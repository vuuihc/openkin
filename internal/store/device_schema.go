package store

import "fmt"

func (s *Store) ensureDeviceSchema() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS pairing_sessions (
  secret_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_expires ON pairing_sessions(expires_at, used_at);
CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_credentials_active ON device_credentials(revoked_at, created_at DESC);`)
	if err != nil {
		return fmt.Errorf("ensure device schema: %w", err)
	}
	return nil
}
