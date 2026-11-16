package server

import (
	"context"
	"errors"
	"os"
	"slices"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/acp"
	"github.com/vuuihc/openkin/internal/agent"
)

type providerCatalogStub struct {
	err error
}

func (c providerCatalogStub) List(context.Context, agent.SessionQuery) ([]agent.SessionInfo, error) {
	return nil, c.err
}

func (c providerCatalogStub) Inspect(context.Context, string) (agent.SessionInfo, error) {
	return agent.SessionInfo{}, c.err
}

func (c providerCatalogStub) ReadHistory(context.Context, string, agent.HistoryQuery) (agent.HistoryPage, error) {
	return agent.HistoryPage{}, c.err
}

func TestSessionCatalogStateRequiresHealthySource(t *testing.T) {
	tests := []struct {
		name string
		cat  agent.SessionCatalog
		want agent.ProviderState
	}{
		{name: "missing", want: agent.ProviderUnsupported},
		{name: "healthy", cat: providerCatalogStub{}, want: agent.ProviderAvailable},
		{name: "degraded", cat: providerCatalogStub{err: errors.New("root missing")}, want: agent.ProviderDegraded},
		{name: "permission", cat: providerCatalogStub{err: os.ErrPermission}, want: agent.ProviderPermissionRequired},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := sessionCatalogState(tt.cat)
			if got != tt.want {
				t.Fatalf("state=%q want %q", got, tt.want)
			}
		})
	}
}

// The ACP table is a data table, so the checks that matter are the ones a typo
// would break: ids the registry accepts, no id claimed twice, and no id borrowed
// from the native adapters that can be registered alongside them.
func TestACPAgentTableBuilds(t *testing.T) {
	cfgs := acpAgentConfigs()
	factories := make([]agent.Factory, 0, len(cfgs))
	for _, cfg := range cfgs {
		factories = append(factories, acp.NewPluginFactory(cfg))
	}
	reg, err := agent.Build(context.Background(), factories...)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	want := []string{"claude-acp", "codex-acp", "droid-acp", "pi-acp"}
	got := reg.IDs()
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("ids=%v want %v", got, want)
	}
	for _, native := range []string{"kin", "claude-code", "codex", "droid", "grok", "rawpty", "acp"} {
		if slices.Contains(got, native) {
			t.Fatalf("acp id %q collides with the native adapter", native)
		}
	}
}

// KIN_ACP_<KEY>_BIN overrides one agent and leaves the rest alone: the point of
// the per-agent env vars is that pointing codex at a custom build does not turn
// the other three into the same binary.
func TestACPAgentConfigsOverrideOneAgent(t *testing.T) {
	t.Setenv("KIN_ACP_PI_BIN", "/opt/pi-acp")
	t.Setenv("KIN_ACP_PI_ARGS", "--verbose --profile team")
	t.Setenv("KIN_ACP_CLAUDE_BIN", "/opt/claude-agent-acp")
	// An empty override is no override, so the developer's own environment does
	// not decide what the untouched agent looks like.
	t.Setenv("KIN_ACP_CODEX_BIN", "")
	t.Setenv("KIN_ACP_CODEX_ARGS", "")

	byID := make(map[string]acp.PluginConfig)
	for _, cfg := range acpAgentConfigs() {
		byID[cfg.ID] = cfg
	}

	pi := byID["pi-acp"]
	if pi.Binary != "/opt/pi-acp" || !slices.Equal(pi.Args, []string{"--verbose", "--profile", "team"}) {
		t.Fatalf("pi=%q %q", pi.Binary, pi.Args)
	}
	claude := byID["claude-acp"]
	if claude.Binary != "/opt/claude-agent-acp" || !slices.Equal(claude.Args, []string{"-y", "@zed-industries/claude-agent-acp@0.23.1"}) {
		t.Fatalf("claude=%q %q", claude.Binary, claude.Args)
	}
	if codex := byID["codex-acp"]; codex.Binary != "npx" || !slices.Contains(codex.Args, "@agentclientprotocol/codex-acp@2.3.0") {
		t.Fatalf("codex=%q %q", codex.Binary, codex.Args)
	}
}

// Every ACP agent must say which of its own mode ids means what Kin's modes
// mean, or the turn cannot lower an agent whose default approves everything
// (droid's does). The check is presence, not the ids: those are measured.
func TestACPAgentsBridgeKinModes(t *testing.T) {
	// An agent with no permission ladder (pi publishes thinking levels and never
	// asks) declares no bridge; every agent that declares one must cover all
	// three of Kin's modes.
	for _, entry := range acpAgents {
		if entry.Unattended {
			if entry.Modes != nil {
				t.Fatalf("%s is unattended and also claims a permission ladder", entry.ID)
			}
			continue
		}
		for _, mode := range []string{adapter.PermissionDefault, adapter.PermissionAcceptEdits, adapter.PermissionYOLO} {
			if entry.Modes[mode] == "" {
				t.Fatalf("%s: no mode id for %q", entry.ID, mode)
			}
		}
		// A bypass flag is about a rung that exists; without the mapping it
		// would say nothing the ceiling does not already say.
		if entry.AcceptEditsBypasses && entry.Modes[adapter.PermissionAcceptEdits] == "" {
			t.Fatalf("%s: accept-edits bypass without an accept-edits rung", entry.ID)
		}
	}
}
