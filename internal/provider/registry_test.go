package provider

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

func openTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestRegistryLegacyMigrationAndLoadConfig(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	if err := SaveConfig(ctx, st, Config{
		Kind:    "openai-compatible",
		BaseURL: "https://api.openai.com/v1",
		APIKey:  "sk-legacy-secret",
		Model:   "gpt-4o",
	}, false); err != nil {
		t.Fatal(err)
	}

	reg, err := LoadRegistry(ctx, st)
	if err != nil {
		t.Fatal(err)
	}
	if len(reg.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(reg.Entries))
	}
	if reg.ActiveID != "legacy" {
		t.Fatalf("active = %q", reg.ActiveID)
	}
	if reg.Entries[0].APIKey != "sk-legacy-secret" {
		t.Fatalf("api key not migrated")
	}

	// LoadConfig should resolve active entry.
	cfg, err := LoadConfig(ctx, st)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Model != "gpt-4o" || cfg.BaseURL != "https://api.openai.com/v1" {
		t.Fatalf("cfg = %+v", cfg)
	}

	// Second load should hit the registry path (providers key present).
	raw, err := st.GetSetting(ctx, KeyProviders)
	if err != nil || raw == "" {
		t.Fatalf("providers key not persisted: %v %q", err, raw)
	}
}

func TestUpsertSwitchDelete(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	reg, err := UpsertEntry(ctx, st, Entry{
		Name:    "OpenAI",
		BaseURL: "https://api.openai.com/v1",
		APIKey:  "sk-openai",
		Model:   "gpt-4o",
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(reg.Entries) != 1 || reg.ActiveID == "" {
		t.Fatalf("reg = %+v", reg)
	}
	firstID := reg.ActiveID

	reg, err = UpsertEntry(ctx, st, Entry{
		Name:    "Local Ollama",
		BaseURL: "http://127.0.0.1:11434/v1",
		Model:   "llama3",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(reg.Entries) != 2 {
		t.Fatalf("entries = %d", len(reg.Entries))
	}
	if reg.ActiveID != firstID {
		t.Fatalf("active changed unexpectedly to %q", reg.ActiveID)
	}
	var secondID string
	for _, e := range reg.Entries {
		if e.ID != firstID {
			secondID = e.ID
			break
		}
	}
	if secondID == "" {
		t.Fatal("missing second id")
	}

	reg, err = SetActive(ctx, st, secondID)
	if err != nil {
		t.Fatal(err)
	}
	if reg.ActiveID != secondID {
		t.Fatalf("active = %q want %q", reg.ActiveID, secondID)
	}
	cfg, err := LoadConfig(ctx, st)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Model != "llama3" {
		t.Fatalf("mirrored model = %q", cfg.Model)
	}
	// Legacy keys must mirror active.
	legacyModel, _ := st.GetSetting(ctx, KeyModel)
	if legacyModel != "llama3" {
		t.Fatalf("legacy model = %q", legacyModel)
	}

	// Update first entry with masked key → preserve secret.
	reg, err = UpsertEntry(ctx, st, Entry{
		ID:      firstID,
		Name:    "OpenAI",
		BaseURL: "https://api.openai.com/v1",
		APIKey:  MaskAPIKey("sk-openai"),
		Model:   "gpt-4.1",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	e, ok := reg.ByID(firstID)
	if !ok || e.APIKey != "sk-openai" {
		t.Fatalf("key not preserved: %+v", e)
	}
	if e.Model != "gpt-4.1" {
		t.Fatalf("model not updated: %q", e.Model)
	}

	// Delete active → falls back to remaining.
	reg, err = DeleteEntry(ctx, st, secondID)
	if err != nil {
		t.Fatal(err)
	}
	if len(reg.Entries) != 1 || reg.ActiveID != firstID {
		t.Fatalf("after delete: %+v", reg)
	}
	cfg, err = LoadConfig(ctx, st)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Model != "gpt-4.1" {
		t.Fatalf("cfg after delete = %+v", cfg)
	}

	// Delete last → unconfigured.
	reg, err = DeleteEntry(ctx, st, firstID)
	if err != nil {
		t.Fatal(err)
	}
	if len(reg.Entries) != 0 || reg.ActiveID != "" {
		t.Fatalf("want empty registry, got %+v", reg)
	}
	cfg, err = LoadConfig(ctx, st)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Configured() {
		t.Fatalf("want unconfigured after delete-all, got %+v", cfg)
	}
}

func TestSetActiveUnknown(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if _, err := SetActive(ctx, st, "missing"); err == nil {
		t.Fatal("expected error")
	}
}

func TestRegistryPublicMasksKeys(t *testing.T) {
	reg := Registry{
		ActiveID: "a",
		Entries: []Entry{
			{ID: "a", Name: "A", BaseURL: "https://x/v1", APIKey: "sk-abcdefghij", Model: "m"},
		},
	}
	pub := reg.Public()
	if len(pub) != 1 {
		t.Fatalf("len=%d", len(pub))
	}
	if pub[0].APIKey == "sk-abcdefghij" || pub[0].APIKey == "" {
		t.Fatalf("api key not masked: %q", pub[0].APIKey)
	}
	if !pub[0].Active {
		t.Fatal("want active")
	}
}

func TestSaveRegistryIsAtomicWithLegacyMirrors(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	old := Registry{
		ActiveID: "old",
		Entries: []Entry{{
			ID: "old", Name: "Old", Kind: "openai-compatible",
			BaseURL: "https://old.example/v1", APIKey: "old-key", Model: "old-model",
		}},
	}
	if err := SaveRegistry(ctx, st, old); err != nil {
		t.Fatal(err)
	}
	keys := []string{KeyProviders, KeyActiveProvider, KeyKind, KeyBaseURL, KeyAPIKey, KeyModel, KeyStream}
	before := make(map[string]string, len(keys))
	for _, key := range keys {
		value, err := st.GetSetting(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		before[key] = value
	}
	if _, err := st.DB().Exec(`
		CREATE TRIGGER fail_provider_model
		BEFORE UPDATE OF value ON settings
		WHEN OLD.key = 'provider.model' AND NEW.value = 'new-model'
		BEGIN
			SELECT RAISE(ABORT, 'injected provider mirror failure');
		END`); err != nil {
		t.Fatal(err)
	}

	err := SaveRegistry(ctx, st, Registry{
		ActiveID: "new",
		Entries: []Entry{{
			ID: "new", Name: "New", Kind: "openai-compatible",
			BaseURL: "https://new.example/v1", APIKey: "new-key", Model: "new-model",
		}},
	})
	if err == nil {
		t.Fatal("expected injected save failure")
	}
	for _, key := range keys {
		value, getErr := st.GetSetting(ctx, key)
		if getErr != nil {
			t.Fatal(getErr)
		}
		if value != before[key] {
			t.Fatalf("%s changed after rolled-back save: got %q want %q", key, value, before[key])
		}
	}
}

func TestLoadRegistryReportsMigrationPersistenceFailure(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := SaveConfig(ctx, st, Config{
		Kind: "openai-compatible", BaseURL: "https://legacy.example/v1", Model: "legacy-model",
	}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().Exec(`
		CREATE TRIGGER fail_provider_migration
		BEFORE INSERT ON settings
		WHEN NEW.key = 'providers'
		BEGIN
			SELECT RAISE(ABORT, 'injected migration failure');
		END`); err != nil {
		t.Fatal(err)
	}

	_, err := LoadRegistry(ctx, st)
	if err == nil || !strings.Contains(err.Error(), "persist legacy provider migration") {
		t.Fatalf("error=%v", err)
	}
	if _, err := st.GetSetting(ctx, KeyProviders); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("providers key should not survive failed migration: %v", err)
	}
	model, err := st.GetSetting(ctx, KeyModel)
	if err != nil || model != "legacy-model" {
		t.Fatalf("legacy model=%q err=%v", model, err)
	}
}

func TestLoadRegistryReportsStorageErrors(t *testing.T) {
	st := openTestStore(t)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadRegistry(context.Background(), st); err == nil {
		t.Fatal("expected closed-store error")
	}
}
