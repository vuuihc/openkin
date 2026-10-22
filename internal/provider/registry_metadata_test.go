package provider

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

// recordingSecrets stands in for the platform credential backend. On macOS a
// Get is a Keychain lookup that can stop on a system dialog, so a test can
// assert on reads alone: a path that reads nothing cannot prompt anyone.
type recordingSecrets struct {
	mu     sync.Mutex
	reads  []string
	writes map[string]string
}

func (r *recordingSecrets) Get(ref string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reads = append(r.reads, ref)
	if value, ok := r.writes[ref]; ok {
		return value, nil
	}
	return "", errors.New("no secret stored")
}

func (r *recordingSecrets) Put(ref, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.writes == nil {
		r.writes = map[string]string{}
	}
	r.writes[ref] = value
	return nil
}

func (r *recordingSecrets) Delete(ref string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.writes, ref)
	return nil
}

func (r *recordingSecrets) readCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.reads)
}

func metadataTestStore(t *testing.T) (*store.Store, *recordingSecrets) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	secrets := &recordingSecrets{}
	SetSecretStore(secrets)
	t.Cleanup(func() { SetSecretStore(nil) })
	return st, secrets
}

// TestLoadConfigMetadataDoesNotReadTheSecretStore is the regression guard for
// a daemon that could not start unattended: the startup probe read the API key
// it never needed, and on macOS that read is a Keychain lookup that blocks on a
// dialog. Configured() is answered by base URL and model alone.
func TestLoadConfigMetadataDoesNotReadTheSecretStore(t *testing.T) {
	ctx := context.Background()

	t.Run("registry entry", func(t *testing.T) {
		st, secrets := metadataTestStore(t)
		if err := SaveRegistry(ctx, st, Registry{
			ActiveID: "openai",
			Entries: []Entry{{
				ID:      "openai",
				BaseURL: "https://example.test/v1",
				Model:   "m",
				APIKey:  "sk-private",
			}},
		}); err != nil {
			t.Fatal(err)
		}
		secrets.mu.Lock()
		secrets.reads = nil
		secrets.mu.Unlock()

		cfg, err := LoadConfigMetadata(ctx, st)
		if err != nil {
			t.Fatal(err)
		}
		if !cfg.Configured() {
			t.Fatalf("metadata lost the configuration: %+v", cfg)
		}
		if cfg.APIKey != "" {
			t.Fatalf("metadata returned a credential %q", cfg.APIKey)
		}
		if n := secrets.readCount(); n != 0 {
			t.Fatalf("metadata read the secret store %d times (%v)", n, secrets.reads)
		}
	})

	t.Run("legacy slot", func(t *testing.T) {
		st, secrets := metadataTestStore(t)
		// Only the legacy single-slot keys, and a key stored externally: the
		// migration path must not hydrate either.
		if err := st.SetSettings(ctx, map[string]string{
			KeyBaseURL: "https://example.test/v1",
			KeyModel:   "m",
			KeyAPIKey:  "secret://secret-provider-legacy",
		}); err != nil {
			t.Fatal(err)
		}

		cfg, err := LoadConfigMetadata(ctx, st)
		if err != nil {
			t.Fatal(err)
		}
		if !cfg.Configured() {
			t.Fatalf("metadata lost the configuration: %+v", cfg)
		}
		if n := secrets.readCount(); n != 0 {
			t.Fatalf("metadata read the secret store %d times (%v)", n, secrets.reads)
		}
	})
}

// TestLoadConfigMetadataSurvivesABrokenRegistry covers the branches a status
// probe actually hits on a half-written or hand-edited settings row: a pointer
// at an entry that is gone, and JSON that does not parse.
func TestLoadConfigMetadataSurvivesABrokenRegistry(t *testing.T) {
	ctx := context.Background()

	t.Run("dangling active pointer", func(t *testing.T) {
		st, secrets := metadataTestStore(t)
		if err := SaveRegistry(ctx, st, Registry{
			ActiveID: "openai",
			Entries: []Entry{{
				ID:      "openai",
				BaseURL: "https://example.test/v1",
				Model:   "m",
				APIKey:  "sk-private",
			}},
		}); err != nil {
			t.Fatal(err)
		}
		if err := st.SetSettings(ctx, map[string]string{KeyActiveProvider: "gone"}); err != nil {
			t.Fatal(err)
		}
		secrets.mu.Lock()
		secrets.reads = nil
		secrets.mu.Unlock()

		cfg, err := LoadConfigMetadata(ctx, st)
		if err != nil {
			t.Fatal(err)
		}
		// The loader repairs the pointer to the first entry, so the answer is the
		// same as a healthy registry's.
		if !cfg.Configured() {
			t.Fatalf("metadata lost the configuration: %+v", cfg)
		}
		if n := secrets.readCount(); n != 0 {
			t.Fatalf("metadata read the secret store %d times (%v)", n, secrets.reads)
		}
	})

	t.Run("malformed registry", func(t *testing.T) {
		st, _ := metadataTestStore(t)
		if err := st.SetSettings(ctx, map[string]string{KeyProviders: "{not json"}); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfigMetadata(ctx, st); err == nil {
			t.Fatal("malformed registry was accepted")
		}
	})
}

// TestLoadConfigStillHydratesTheKey is the control: the same fixture through
// the runtime loader must read the store, or the guard above would pass for the
// wrong reason.
func TestLoadConfigStillHydratesTheKey(t *testing.T) {
	ctx := context.Background()
	st, secrets := metadataTestStore(t)
	if err := SaveRegistry(ctx, st, Registry{
		ActiveID: "openai",
		Entries: []Entry{{
			ID:      "openai",
			BaseURL: "https://example.test/v1",
			Model:   "m",
			APIKey:  "sk-private",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	secrets.mu.Lock()
	secrets.reads = nil
	secrets.mu.Unlock()

	cfg, err := LoadConfig(ctx, st)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "sk-private" {
		t.Fatalf("runtime loader did not hydrate the key: %q", cfg.APIKey)
	}
	if n := secrets.readCount(); n == 0 {
		t.Fatal("runtime loader never read the secret store")
	}
}
