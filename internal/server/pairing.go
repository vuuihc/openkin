package server

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

func issuePairingURL(ctx context.Context, st *store.Store, rawURL, label string, identity desktopIdentity) (string, error) {
	secret, err := remote.NewSecret()
	if err != nil {
		return "", err
	}
	now := time.Now().UnixMilli()
	if err := st.InvalidatePairingSessions(ctx, label, now); err != nil {
		return "", fmt.Errorf("invalidate previous pairing sessions: %w", err)
	}
	if err := st.CreatePairingSession(ctx, store.PairingSession{
		SecretHash: remote.HashToken(secret),
		Label:      label, CreatedAt: now, ExpiresAt: now + (5 * time.Minute).Milliseconds(),
	}); err != nil {
		return "", fmt.Errorf("create pairing session: %w", err)
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("parse pairing URL: %w", err)
	}
	query := u.Query()
	query.Set("token", secret)
	query.Set("pairing", "1")
	if trimmed := strings.TrimSpace(identity.ID); trimmed != "" {
		query.Set("desktop_id", trimmed)
	}
	if trimmed := strings.TrimSpace(identity.Name); trimmed != "" {
		query.Set("desktop_name", trimmed)
	}
	u.RawQuery = query.Encode()
	return u.String(), nil
}
