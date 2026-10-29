package store

import (
	"context"
	"errors"
	"fmt"
)

// PushSubscription is one browser's registration with its push service.
//
// The endpoint is a capability: anyone holding it can deliver to that browser,
// and the keys are what make the delivery readable only there. The row carries
// no account or device id — a browser that subscribes is the only thing that
// can unsubscribe, and the daemon has no reason to know more.
type PushSubscription struct {
	ID        string
	Endpoint  string
	P256DH    string
	Auth      string
	CreatedAt int64
}

// PushSubscriptionsDDL creates the push registry.
//
// Exported so the migration and the every-open reconciler apply the same text,
// the same way the share table is kept in one place.
const PushSubscriptionsDDL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_created ON push_subscriptions(created_at);`

// SavePushSubscription records a registration, replacing the keys of an
// endpoint that is already known, and returns the id the row really carries.
//
// Browsers hand back the same endpoint when the same installation subscribes
// again after a key rotation, so the conflict target is the endpoint: a second
// row for one browser would double every notification it receives. That also
// means the id the caller proposed is not necessarily the stored one — a
// re-subscribe keeps the original row — and the caller is told which it is.
func (s *Store) SavePushSubscription(ctx context.Context, sub PushSubscription) (string, error) {
	if sub.ID == "" || sub.Endpoint == "" || sub.P256DH == "" || sub.Auth == "" || sub.CreatedAt <= 0 {
		return "", errors.New("save push subscription: missing required field")
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(endpoint) DO UPDATE SET
			p256dh = excluded.p256dh,
			auth = excluded.auth`,
		sub.ID, sub.Endpoint, sub.P256DH, sub.Auth, sub.CreatedAt,
	); err != nil {
		return "", fmt.Errorf("save push subscription: %w", err)
	}
	var id string
	if err := s.db.QueryRowContext(ctx,
		`SELECT id FROM push_subscriptions WHERE endpoint = ?`, sub.Endpoint).Scan(&id); err != nil {
		return "", fmt.Errorf("save push subscription: read id: %w", err)
	}
	return id, nil
}

// ListPushSubscriptions returns every registration, oldest first.
func (s *Store) ListPushSubscriptions(ctx context.Context) ([]PushSubscription, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, endpoint, p256dh, auth, created_at
		FROM push_subscriptions
		ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("list push subscriptions: %w", err)
	}
	defer rows.Close()
	var out []PushSubscription
	for rows.Next() {
		var sub PushSubscription
		if err := rows.Scan(&sub.ID, &sub.Endpoint, &sub.P256DH, &sub.Auth, &sub.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan push subscription: %w", err)
		}
		out = append(out, sub)
	}
	return out, rows.Err()
}

// DeletePushSubscription removes one registration by id.
func (s *Store) DeletePushSubscription(ctx context.Context, id string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM push_subscriptions WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete push subscription: %w", err)
	}
	return nil
}

// DeletePushSubscriptionByEndpoint removes the registration the calling browser
// holds, which is the only handle an unsubscribe request carries.
func (s *Store) DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint); err != nil {
		return fmt.Errorf("delete push subscription: %w", err)
	}
	return nil
}

// CountPushSubscriptions reports how many browsers would receive a message.
func (s *Store) CountPushSubscriptions(ctx context.Context) (int, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count push subscriptions: %w", err)
	}
	return n, nil
}
