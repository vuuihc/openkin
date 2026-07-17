package provider

import (
	"context"
	"strings"

	"github.com/vuuihc/kin/internal/store"
)

// LoadConfig reads provider settings from the store.
func LoadConfig(ctx context.Context, st *store.Store) (Config, error) {
	get := func(k string) string {
		v, err := st.GetSetting(ctx, k)
		if err != nil {
			return ""
		}
		return v
	}
	cfg := Config{
		Kind:    get(KeyKind),
		BaseURL: get(KeyBaseURL),
		APIKey:  get(KeyAPIKey),
		Model:   get(KeyModel),
	}.Normalize()
	return cfg, nil
}

// SaveConfig writes provider settings.
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
	if clearAPIKey {
		return st.SetSetting(ctx, KeyAPIKey, "")
	}
	if cfg.APIKey != "" && !looksMasked(cfg.APIKey) {
		return st.SetSetting(ctx, KeyAPIKey, cfg.APIKey)
	}
	return nil
}

func looksMasked(s string) bool {
	return strings.Contains(s, "…") || strings.Contains(s, "••••")
}
