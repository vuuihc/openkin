package provider

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/secret"
	"github.com/vuuihc/openkin/internal/store"
)

func TestProviderKeysUseSecretStore(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	secrets, err := secret.NewFileStore(filepath.Join(t.TempDir(), "secrets"))
	if err != nil {
		t.Fatal(err)
	}
	SetSecretStore(secrets)
	t.Cleanup(func() { SetSecretStore(nil) })

	ctx := context.Background()
	reg := Registry{
		ActiveID: "openai",
		Entries:  []Entry{{ID: "openai", BaseURL: "https://example.test/v1", Model: "m", APIKey: "sk-private"}},
	}
	if err := SaveRegistry(ctx, st, reg); err != nil {
		t.Fatal(err)
	}
	raw, err := st.GetSetting(ctx, KeyProviders)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "sk-private") {
		t.Fatal("provider key remained in SQLite")
	}
	loaded, err := LoadRegistry(ctx, st)
	if err != nil {
		t.Fatal(err)
	}
	active, _ := loaded.Active()
	if active.APIKey != "sk-private" {
		t.Fatalf("loaded API key = %q", active.APIKey)
	}
}

func TestProviderSecretDeletedWhenEntryClearedOrRemoved(t *testing.T) {
	ctx := context.Background()
	secrets, err := secret.NewFileStore(filepath.Join(t.TempDir(), "secrets"))
	if err != nil {
		t.Fatal(err)
	}
	SetSecretStore(secrets)
	t.Cleanup(func() { SetSecretStore(nil) })

	t.Run("clear", func(t *testing.T) {
		st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = st.Close() })

		const id = "openai"
		if _, err := UpsertEntry(ctx, st, Entry{
			ID:      id,
			Name:    "OpenAI",
			BaseURL: "https://example.test/v1",
			Model:   "m",
			APIKey:  "sk-clear",
		}, true); err != nil {
			t.Fatal(err)
		}
		if got, err := secrets.Get(secretReference(id)); err != nil || got != "sk-clear" {
			t.Fatalf("secret before clear = %q err=%v", got, err)
		}

		if _, err := ClearEntryAPIKey(ctx, st, id); err != nil {
			t.Fatal(err)
		}
		if _, err := secrets.Get(secretReference(id)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("secret after clear err=%v, want not exist", err)
		}
	})

	t.Run("delete", func(t *testing.T) {
		st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = st.Close() })

		const id = "anthropic"
		if _, err := UpsertEntry(ctx, st, Entry{
			ID:      id,
			Name:    "Anthropic",
			BaseURL: "https://example.test/v1",
			Model:   "m",
			APIKey:  "sk-delete",
		}, true); err != nil {
			t.Fatal(err)
		}
		if got, err := secrets.Get(secretReference(id)); err != nil || got != "sk-delete" {
			t.Fatalf("secret before delete = %q err=%v", got, err)
		}

		if _, err := DeleteEntry(ctx, st, id); err != nil {
			t.Fatal(err)
		}
		if _, err := secrets.Get(secretReference(id)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("secret after delete err=%v, want not exist", err)
		}
	})
}
