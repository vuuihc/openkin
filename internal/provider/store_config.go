package provider

import (
	"context"
	"strings"

	"github.com/vuuihc/kin/internal/store"
)

// SaveConfig writes the legacy single-slot provider settings.
// Prefer SaveRegistry / UpsertEntry for multi-provider management; this remains
// so the active entry can be mirrored and older call sites keep working.
// API key: empty + clearAPIKey clears; masked values (from GET) are ignored; otherwise set.
func SaveConfig(ctx context.Context, st *store.Store, cfg Config, clearAPIKey bool) error {
	cfg = cfg.Normalize()
	if cfg.Kind == "" {
		cfg.Kind = "openai-compatible"
	}
	if err := st.SetSetting(ctx, KeyKind, cfg.Kind); err != nil {
		return err
	}
	if err := st.SetSetting(ctx, KeyBaseURL, cfg.BaseURL); err != nil {
		return err
	}
	if err := st.SetSetting(ctx, KeyModel, cfg.Model); err != nil {
		return err
	}
	if err := st.SetSetting(ctx, KeyStream, formatBoolSetting(cfg.Stream)); err != nil {
		return err
	}
	if clearAPIKey {
		return st.SetSetting(ctx, KeyAPIKey, "")
	}
	if cfg.APIKey != "" && !looksMasked(cfg.APIKey) {
		return st.SetSetting(ctx, KeyAPIKey, cfg.APIKey)
	}
	// When mirroring an active entry with an empty key, clear the legacy slot
	// so Configured() stays consistent with the registry.
	if cfg.APIKey == "" {
		return st.SetSetting(ctx, KeyAPIKey, "")
	}
	return nil
}

func looksMasked(s string) bool {
	return strings.Contains(s, "…") || strings.Contains(s, "••••")
}
