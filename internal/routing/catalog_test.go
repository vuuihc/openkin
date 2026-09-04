package routing

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/store"
)

func openCatalogTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestCatalogRejectsMalformedPersistedRoutingConfig(t *testing.T) {
	tests := []struct {
		name string
		key  string
		load func(*Catalog) error
	}{
		{
			name: "profiles",
			key:  keyProfiles,
			load: func(c *Catalog) error {
				_, err := c.ListTeamProfiles(context.Background())
				return err
			},
		},
		{
			name: "defaults",
			key:  keyDefaults,
			load: func(c *Catalog) error {
				_, err := c.GetRoutingDefaults(context.Background())
				return err
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			st := openCatalogTestStore(t)
			if err := st.SetSetting(context.Background(), test.key, `{"broken":`); err != nil {
				t.Fatal(err)
			}
			err := test.load(NewCatalog(st, nil))
			if err == nil {
				t.Fatal("expected malformed persisted config error")
			}
			if !strings.Contains(err.Error(), "parse "+test.key) {
				t.Fatalf("error=%q", err)
			}
		})
	}
}

func TestCatalogRejectsInvalidPersistedDefaults(t *testing.T) {
	st := openCatalogTestStore(t)
	if err := st.SetSetting(context.Background(), keyDefaults, `{"enabled":true,"objective":"balanced"}`); err != nil {
		t.Fatal(err)
	}

	_, err := NewCatalog(st, nil).GetRoutingDefaults(context.Background())
	if err == nil || !strings.Contains(err.Error(), "default team is required") {
		t.Fatalf("error=%v", err)
	}
}

func TestCatalogModelsForAgentUsesEnabledProviderOverlays(t *testing.T) {
	st := openCatalogTestStore(t)
	enabled := true
	disabled := false
	if err := provider.SaveRegistry(context.Background(), st, provider.Registry{
		Entries: []provider.Entry{
			{
				ID: "enabled", Name: "Enabled", Kind: string(ProviderKindSubscription),
				Enabled: &enabled, SupportsAgents: []string{"droid"},
				Models: []provider.ModelSpec{{ID: "configured-smart", Tier: "smart"}},
			},
			{
				ID: "disabled", Name: "Disabled", Kind: string(ProviderKindSubscription),
				Enabled: &disabled, SupportsAgents: []string{"droid"},
				Models: []provider.ModelSpec{{ID: "disabled-model", Tier: "fast"}},
			},
			{
				ID: "wrong-kind", Name: "Wrong Kind", Kind: string(ProviderKindOpenAICompatible),
				Enabled: &enabled, SupportsAgents: []string{"droid"},
				Models: []provider.ModelSpec{{ID: "wrong-kind-model", Tier: "fast"}},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}

	models, err := NewCatalog(st, nil).ModelsForAgent(
		context.Background(), "droid", ProviderKindSubscription,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "configured-smart" || models[0].Tier != "smart" {
		t.Fatalf("models=%+v", models)
	}
}

func TestCatalogRejectsProviderChangeThatInvalidatesTeam(t *testing.T) {
	st := openCatalogTestStore(t)
	ctx := context.Background()
	catalog := NewCatalog(st, func(id string) bool { return id == "droid" })
	if err := catalog.SaveProviderProfiles(ctx, []ProviderProfile{{
		ID: "subscription", Name: "Subscription", Kind: ProviderKindSubscription,
		Enabled: true, SupportsAgents: []string{"droid"},
		Models: []ModelSpec{{ID: "model-a", Tier: "smart"}},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := catalog.SaveTeamProfiles(ctx, []TeamProfile{{
		ID: "team", Name: "Team", Enabled: true,
		Phases: map[RoutePhase]PhasePolicy{
			PhaseExecute: {
				Agent: "droid", Tier: "smart", ProviderPriority: []string{"subscription"},
			},
		},
	}}); err != nil {
		t.Fatal(err)
	}

	err := catalog.SaveProviderProfiles(ctx, []ProviderProfile{{
		ID: "subscription", Name: "Subscription", Kind: ProviderKindSubscription,
		Enabled: false, SupportsAgents: []string{"droid"},
		Models: []ModelSpec{{ID: "model-a", Tier: "smart"}},
	}})
	if !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("error=%v want ErrInvalidConfig", err)
	}
	reg, err := provider.LoadRegistry(ctx, st)
	if err != nil {
		t.Fatal(err)
	}
	if entry, ok := reg.ByID("subscription"); !ok || entry.Enabled == nil || !*entry.Enabled {
		t.Fatalf("provider changed after rejected write: %+v", entry)
	}
}

func TestCatalogRejectsRemovingDefaultTeam(t *testing.T) {
	st := openCatalogTestStore(t)
	ctx := context.Background()
	catalog := NewCatalog(st, func(id string) bool { return id == "droid" })
	if err := catalog.SaveProviderProfiles(ctx, []ProviderProfile{{
		ID: "subscription", Name: "Subscription", Kind: ProviderKindSubscription,
		Enabled: true, SupportsAgents: []string{"droid"},
		Models: []ModelSpec{{ID: "model-a", Tier: "smart"}},
	}}); err != nil {
		t.Fatal(err)
	}
	team := TeamProfile{
		ID: "team", Name: "Team", Enabled: true,
		Phases: map[RoutePhase]PhasePolicy{
			PhaseExecute: {
				Agent: "droid", Tier: "smart", ProviderPriority: []string{"subscription"},
			},
		},
	}
	if err := catalog.SaveTeamProfiles(ctx, []TeamProfile{team}); err != nil {
		t.Fatal(err)
	}
	defaults := DefaultRoutingDefaults()
	defaults.Enabled = true
	defaults.DefaultTeam = team.ID
	if err := catalog.SaveRoutingDefaults(ctx, defaults); err != nil {
		t.Fatal(err)
	}
	if err := catalog.SaveTeamProfiles(ctx, nil); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("error=%v want ErrInvalidConfig", err)
	}
}

func TestCatalogDoesNotClassifyPersistedRoutingCorruptionAsClientError(t *testing.T) {
	st := openCatalogTestStore(t)
	if err := st.SetSetting(context.Background(), keyProfiles, `{"profiles":`); err != nil {
		t.Fatal(err)
	}
	catalog := NewCatalog(st, func(string) bool { return true })
	_, err := catalog.UpsertProvider(context.Background(), provider.Entry{
		ID: "p1", Name: "P1", Kind: "openai-compatible",
		BaseURL: "https://example.com/v1", Model: "m1",
	}, true, false, false)
	if err == nil {
		t.Fatal("expected persisted routing parse error")
	}
	if errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("storage/configuration corruption misclassified as client input: %v", err)
	}
}

func TestCatalogSetActiveProvider(t *testing.T) {
	tests := []struct {
		name      string
		candidate provider.Entry
		wantErr   bool
	}{
		{
			name: "runtime ready",
			candidate: provider.Entry{
				ID: "candidate", Kind: "openai-compatible",
				BaseURL: "https://candidate.example/v1", Model: "candidate-model",
			},
		},
		{
			name: "routing only subscription",
			candidate: provider.Entry{
				ID: "candidate", Kind: string(ProviderKindSubscription),
				SupportsAgents: []string{"droid"},
				Models:         []provider.ModelSpec{{ID: "route-model", Tier: "smart"}},
			},
			wantErr: true,
		},
		{
			name: "unsupported runtime kind",
			candidate: provider.Entry{
				ID: "candidate", Kind: string(ProviderKindSubscription),
				BaseURL: "https://candidate.example/v1", Model: "candidate-model",
			},
			wantErr: true,
		},
		{
			name: "incomplete runtime config",
			candidate: provider.Entry{
				ID: "candidate", Kind: "openai-compatible", Model: "candidate-model",
			},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			st := openCatalogTestStore(t)
			ctx := context.Background()
			old := provider.Entry{
				ID: "old", Kind: "openai-compatible",
				BaseURL: "https://old.example/v1", Model: "old-model",
			}
			if err := provider.SaveRegistry(ctx, st, provider.Registry{
				ActiveID: old.ID,
				Entries:  []provider.Entry{old, test.candidate},
			}); err != nil {
				t.Fatal(err)
			}

			reg, err := NewCatalog(st, nil).SetActiveProvider(ctx, test.candidate.ID)
			if !test.wantErr {
				if err != nil {
					t.Fatal(err)
				}
				if reg.ActiveID != test.candidate.ID {
					t.Fatalf("active provider=%q want %q", reg.ActiveID, test.candidate.ID)
				}
				return
			}
			if !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("error=%v want ErrInvalidConfig", err)
			}
			persisted, loadErr := provider.LoadRegistry(ctx, st)
			if loadErr != nil {
				t.Fatal(loadErr)
			}
			if persisted.ActiveID != old.ID {
				t.Fatalf("active provider changed after rejected activation: %q", persisted.ActiveID)
			}
			for key, want := range map[string]string{
				provider.KeyActiveProvider: old.ID,
				provider.KeyBaseURL:        old.BaseURL,
				provider.KeyModel:          old.Model,
			} {
				got, getErr := st.GetSetting(ctx, key)
				if getErr != nil {
					t.Fatal(getErr)
				}
				if got != want {
					t.Fatalf("%s changed after rejected activation: got %q want %q", key, got, want)
				}
			}
		})
	}
}
