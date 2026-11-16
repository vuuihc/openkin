package kinagent

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/store"
)

// countingSecrets stands in for the platform credential backend so the test can
// see whether a code path asked for a credential at all.
type countingSecrets struct {
	mu     sync.Mutex
	reads  int
	writes map[string]string
}

func (c *countingSecrets) Get(ref string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reads++
	if value, ok := c.writes[ref]; ok {
		return value, nil
	}
	return "", errors.New("no secret stored")
}

func (c *countingSecrets) Put(ref, value string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.writes == nil {
		c.writes = map[string]string{}
	}
	c.writes[ref] = value
	return nil
}

func (c *countingSecrets) Delete(ref string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.writes, ref)
	return nil
}

func (c *countingSecrets) readCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.reads
}

// TestStatusProbeDoesNotReadTheSecretStore covers the daemon startup path:
// buildAgentRegistry → Registry.List → this Status closure. On macOS reading a
// provider key is a Keychain lookup that waits on a dialog, so a startup probe
// that reads one turns "launch Kin" into "find the person who can click Allow".
func TestStatusProbeDoesNotReadTheSecretStore(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	secrets := &countingSecrets{}
	provider.SetSecretStore(secrets)
	t.Cleanup(func() { provider.SetSecretStore(nil) })

	if err := provider.SaveRegistry(ctx, st, provider.Registry{
		ActiveID: "openai",
		Entries: []provider.Entry{{
			ID:      "openai",
			BaseURL: "https://example.test/v1",
			Model:   "m",
			APIKey:  "sk-private",
		}},
	}); err != nil {
		t.Fatal(err)
	}

	// Opening the plugin is part of startup too, so the count starts here rather
	// than after it: a read during Open is the same bug as a read during Status.
	reg, err := NewPluginFactory(st).Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if reg.Status == nil {
		t.Fatal("registration has no status probe")
	}
	if got := secrets.readCount(); got != 0 {
		t.Fatalf("opening the plugin read the secret store %d times", got)
	}

	status := reg.Status(ctx)
	if !status.Available {
		t.Fatalf("configured provider reported unavailable: %+v", status)
	}
	if got := secrets.readCount(); got != 0 {
		t.Fatalf("startup status probe read the secret store %d times", got)
	}

	// The probe has to stay a probe: a status closure that answered "available"
	// unconditionally would pass the read assertions above while telling every
	// unconfigured daemon that Kin is ready.
	empty, err := store.Open(filepath.Join(t.TempDir(), "empty.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer empty.Close()
	emptyReg, err := NewPluginFactory(empty).Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if status := emptyReg.Status(ctx); status.Available {
		t.Fatalf("unconfigured provider reported available: %+v", status)
	}

	// Control: running a turn does need the key, so the same fixture must read
	// it there — otherwise the assertion above would pass for the wrong reason.
	controller, ok := reg.Controller.(*Controller)
	if !ok {
		t.Fatalf("unexpected controller type %T", reg.Controller)
	}
	if _, _, err := controller.Resolve(ctx); err != nil {
		t.Fatalf("turn-time resolve failed: %v", err)
	}
	if got := secrets.readCount(); got == 0 {
		t.Fatal("turn-time resolve never read the secret store")
	}
}
