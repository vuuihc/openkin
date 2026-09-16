package provider

import (
	"context"
	"strings"

	"github.com/vuuihc/openkin/internal/store"
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
	values := map[string]string{
		KeyKind:    cfg.Kind,
		KeyBaseURL: cfg.BaseURL,
		KeyModel:   cfg.Model,
		KeyStream:  formatBoolSetting(cfg.Stream),
	}
	if clearAPIKey {
		values[KeyAPIKey] = ""
	} else if cfg.APIKey != "" && !looksMasked(cfg.APIKey) {
		key, _, err := externalizeAPIKey("legacy", cfg.APIKey)
		if err != nil {
			return err
		}
		values[KeyAPIKey] = key
	} else if cfg.APIKey == "" {
		// When mirroring an active entry with an empty key, clear the legacy
		// slot so Configured() stays consistent with the registry.
		values[KeyAPIKey] = ""
	}
	return st.SetSettings(ctx, values)
}

func looksMasked(s string) bool {
	return strings.Contains(s, "…") || strings.Contains(s, "••••")
}

// LooksMaskedAPIKey reports whether s is a masked key echoed back from
// GET /api/providers (see MaskAPIKey), not a real secret.
func LooksMaskedAPIKey(s string) bool {
	return looksMasked(s)
}
