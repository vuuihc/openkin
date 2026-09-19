package droid

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/sessioncatalog"
)

func TestPluginDescriptor(t *testing.T) {
	descriptor := NewPluginFactory(PluginConfig{}).Descriptor()
	if descriptor.ID != "droid" || descriptor.Kind != agent.KindCLI {
		t.Fatalf("descriptor=%+v", descriptor)
	}
	for _, capability := range []agent.Capability{
		agent.CapabilityRun,
		agent.CapabilityResume,
		agent.CapabilityTools,
		agent.CapabilityApprovals,
		agent.CapabilitySessionList,
		agent.CapabilitySessionInspect,
		agent.CapabilitySessionHistoryRead,
		agent.CapabilitySessionAttach,
	} {
		if !descriptor.Has(capability) {
			t.Errorf("missing capability %q", capability)
		}
	}
	if descriptor.Has(agent.CapabilityOrchestrate) || descriptor.Has(agent.CapabilityLazyWorkspace) {
		t.Fatalf("Droid must not declare orchestrate/lazy_workspace: %v", descriptor.Capabilities)
	}
}

func TestRegistryListsDiscoveredDroidModels(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary")
	}
	binary := filepath.Join(t.TempDir(), "droid")
	script := `#!/bin/sh
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
cat <<'HELP'
Usage: droid exec [options] [prompt]

Available Models:
  auto                                       Auto Model
  deepseek-v4-flash-0731                     DeepSeek V4 Flash 0731 (Droid Core)
  claude-opus-5                              Opus 5 (default)
  custom:local                               Local Custom Model

Custom Models:
  custom:other                               Other Custom Model
HELP
  exit 0
fi
exit 2
`
	if err := os.WriteFile(binary, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	factory := NewPluginFactory(PluginConfig{
		Binary:   binary,
		LookPath: func(string) (string, error) { return binary, nil },
	})
	registry, err := agent.Build(context.Background(), factory)
	if err != nil {
		t.Fatal(err)
	}

	list := registry.List(context.Background(), "droid")
	if len(list) != 1 {
		t.Fatalf("agents=%d", len(list))
	}
	info := list[0]
	if info.ModelSource != "discovered" || info.ModelStatus != "available" {
		t.Fatalf("model metadata source=%q status=%q", info.ModelSource, info.ModelStatus)
	}
	if len(info.Models) != 3 {
		t.Fatalf("models=%+v", info.Models)
	}
	if got := info.Models[1]; got.ID != "deepseek-v4-flash-0731" ||
		got.Label != "DeepSeek V4 Flash 0731 (Droid Core)" || got.Tier != "fast" {
		t.Fatalf("discovered model=%+v", got)
	}
	for _, model := range info.Models {
		if model.ID == "custom:local" {
			t.Fatalf("custom model must not be listed: %+v", info.Models)
		}
	}
}

func TestRegistryPrefersConfiguredDroidModels(t *testing.T) {
	factory := NewPluginFactory(PluginConfig{
		LookPath: func(string) (string, error) { return "/missing/droid", errors.New("missing") },
		ConfiguredModels: func(context.Context) ([]agent.ModelOption, error) {
			return []agent.ModelOption{
				{ID: "team-droid-smart", Tier: "smart"},
				{ID: "team-droid-fast", Tier: "fast"},
			}, nil
		},
	})
	registry, err := agent.Build(context.Background(), factory)
	if err != nil {
		t.Fatal(err)
	}

	info := registry.List(context.Background(), "")[0]
	if info.ModelSource != "configured" || info.ModelStatus != "available" {
		t.Fatalf("model metadata source=%q status=%q", info.ModelSource, info.ModelStatus)
	}
	if len(info.Models) != 2 || info.Models[0].ID != "team-droid-smart" || info.Models[1].ID != "team-droid-fast" {
		t.Fatalf("configured models=%+v", info.Models)
	}
}

func TestRegistrySurfacesConfiguredModelFailure(t *testing.T) {
	factory := NewPluginFactory(PluginConfig{
		Binary:   "droid",
		LookPath: func(string) (string, error) { return "/opt/droid", nil },
		ConfiguredModels: func(context.Context) ([]agent.ModelOption, error) {
			return nil, errors.New("provider catalog unavailable")
		},
	})
	registry, err := agent.Build(context.Background(), factory)
	if err != nil {
		t.Fatal(err)
	}
	info := registry.List(context.Background(), "")[0]
	if info.ModelSource != "configured" || info.ModelStatus != "unavailable" {
		t.Fatalf("model metadata=%+v", info)
	}
	if len(info.Models) != 0 {
		t.Fatalf("models=%+v want none on catalog failure", info.Models)
	}
}

func TestPluginStatusAndEnvironmentOverride(t *testing.T) {
	tests := []struct {
		name      string
		env       string
		lookPath  func(string) (string, error)
		installed bool
		binary    string
	}{
		{
			name: "environment override",
			env:  "/opt/factory/droid",
			lookPath: func(file string) (string, error) {
				if file != "/opt/factory/droid" {
					t.Fatalf("lookPath(%q)", file)
				}
				return file, nil
			},
			installed: true,
			binary:    "/opt/factory/droid",
		},
		{
			name: "missing",
			lookPath: func(file string) (string, error) {
				if file != "droid" {
					t.Fatalf("lookPath(%q)", file)
				}
				return "", errors.New("missing")
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("KIN_DROID_BIN", test.env)
			factory := NewPluginFactory(PluginConfig{LookPath: test.lookPath})
			registration, err := factory.Open(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			status := registration.Status(context.Background())
			if status.Installed != test.installed || status.Available != test.installed || status.Binary != test.binary {
				t.Fatalf("status=%+v", status)
			}
			if registration.Controller != nil || registration.LazyWorkspace != nil {
				t.Fatal("Droid must not expose orchestrate or lazy workspace handlers")
			}
			if registration.Catalog == nil {
				t.Fatal("Droid must expose its metadata-only session catalog")
			}
		})
	}
}

func TestPluginUsesFactoryConfigDirForSessions(t *testing.T) {
	root := filepath.Join(t.TempDir(), "factory")
	t.Setenv("FACTORY_CONFIG_DIR", root)
	factory := NewPluginFactory(PluginConfig{
		LookPath: func(string) (string, error) { return "/opt/droid", nil },
	})
	registration, err := factory.Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	catalog, ok := registration.Catalog.(*sessioncatalog.FileCatalog)
	if !ok {
		t.Fatalf("catalog type=%T", registration.Catalog)
	}
	want := filepath.Join(root, "sessions")
	if len(catalog.Roots) != 1 || catalog.Roots[0] != want {
		t.Fatalf("catalog roots=%v want %q", catalog.Roots, want)
	}
}
