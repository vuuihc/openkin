package provider

import (
	"context"
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
		Entries: []Entry{{ID: "openai", BaseURL: "https://example.test/v1", Model: "m", APIKey: "sk-private"}},
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
