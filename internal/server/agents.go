package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/acp"
	"github.com/vuuihc/openkin/internal/adapter/claudecode"
	"github.com/vuuihc/openkin/internal/adapter/codex"
	"github.com/vuuihc/openkin/internal/adapter/detect"
	"github.com/vuuihc/openkin/internal/adapter/droid"
	"github.com/vuuihc/openkin/internal/adapter/genericcli"
	"github.com/vuuihc/openkin/internal/adapter/grok"
	"github.com/vuuihc/openkin/internal/adapter/kinagent"
	"github.com/vuuihc/openkin/internal/adapter/rawpty"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/connectors"
	"github.com/vuuihc/openkin/internal/routing"
	"github.com/vuuihc/openkin/internal/store"
)

func listAgentProviders(reg *agent.Registry) []agent.ProviderInfo {
	if reg == nil {
		return []agent.ProviderInfo{}
	}
	now := time.Now().UTC()
	presence := make(map[string]detect.Presence)
	for _, item := range detect.ScanPresence("") {
		presence[item.ID] = item
	}

	out := make([]agent.ProviderInfo, 0, len(reg.IDs())+len(presence))
	seen := make(map[string]bool)
	for _, item := range reg.List(context.Background(), "") {
		registration, _ := reg.Get(item.ID)
		p := presence[item.ID]
		sessionState, sessionEvidence := sessionCatalogState(registration.Catalog)
		state := providerState(item.Installed, item.Available, false)
		row := agent.ProviderInfo{
			ID:            item.ID,
			Name:          item.Name,
			Kind:          item.Kind,
			State:         state,
			Installed:     item.Installed,
			Available:     item.Available,
			Binary:        item.Binary,
			Source:        p.Source,
			Reason:        item.Reason,
			LastScannedAt: now,
		}
		if row.Source == "" {
			row.Source = "registry"
		}
		addPresenceEvidence(&row, p)
		for _, capability := range registration.Descriptor.Capabilities {
			capState := state
			evidence := "registered plugin capability"
			if strings.HasPrefix(string(capability), "session_") {
				if registration.Catalog == nil {
					capState = agent.ProviderUnsupported
					evidence = "no session catalog registered"
				} else {
					capState = sessionState
					evidence = sessionEvidence
				}
			}
			row.Capabilities = append(row.Capabilities, agent.CapabilityEvidence{
				Capability: capability,
				State:      capState,
				Evidence:   evidence,
			})
		}
		out = append(out, row)
		seen[item.ID] = true
	}

	for _, p := range presence {
		if seen[p.ID] {
			continue
		}
		spec, _ := detect.DiscoverySpecFor(p.ID)
		state := providerState(p.Installed, false, spec.SessionMode == "presence_only")
		reason := p.Reason
		if spec.UnsupportedReason != "" && p.Installed {
			reason = spec.UnsupportedReason
		}
		row := agent.ProviderInfo{
			ID:            p.ID,
			Name:          p.Name,
			Kind:          agent.KindCLI,
			State:         state,
			Installed:     p.Installed,
			Available:     false,
			Binary:        p.Binary,
			Source:        p.Source,
			Reason:        reason,
			LastScannedAt: now,
		}
		addPresenceEvidence(&row, p)
		for _, capability := range []agent.Capability{
			agent.CapabilitySessionList,
			agent.CapabilitySessionInspect,
			agent.CapabilitySessionHistoryRead,
			agent.CapabilitySessionAttach,
		} {
			capState := state
			evidence := reason
			if !p.Installed {
				capState = agent.ProviderNotDetected
			} else {
				capState = agent.ProviderUnsupported
			}
			row.Capabilities = append(row.Capabilities, agent.CapabilityEvidence{
				Capability: capability,
				State:      capState,
				Evidence:   evidence,
			})
		}
		out = append(out, row)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].State != out[j].State {
			return providerStateRank(out[i].State) < providerStateRank(out[j].State)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func providerStateRank(state agent.ProviderState) int {
	switch state {
	case agent.ProviderAvailable:
		return 0
	case agent.ProviderDetected:
		return 1
	case agent.ProviderDegraded:
		return 2
	case agent.ProviderPermissionRequired:
		return 3
	case agent.ProviderUnsupported:
		return 4
	default:
		return 5
	}
}

func providerState(installed, available, unsupported bool) agent.ProviderState {
	switch {
	case unsupported && installed:
		return agent.ProviderUnsupported
	case available:
		return agent.ProviderAvailable
	case installed:
		return agent.ProviderDetected
	default:
		return agent.ProviderNotDetected
	}
}

func sessionCatalogState(catalog agent.SessionCatalog) (agent.ProviderState, string) {
	if catalog == nil {
		return agent.ProviderUnsupported, "no session catalog registered"
	}
	_, err := catalog.List(context.Background(), agent.SessionQuery{Limit: 1})
	if err == nil {
		return agent.ProviderAvailable, "bounded session source scan succeeded"
	}
	if errors.Is(err, os.ErrPermission) {
		return agent.ProviderPermissionRequired, "session source permission denied"
	}
	return agent.ProviderDegraded, "session source scan failed: " + err.Error()
}

func addPresenceEvidence(row *agent.ProviderInfo, p detect.Presence) {
	if p.Binary != "" {
		row.Evidence = append(row.Evidence, "binary: "+p.Binary)
	}
	if p.ConfigPath != "" {
		row.Evidence = append(row.Evidence, "config: "+p.ConfigPath)
	}
}

// buildAgentRegistry is the composition root for built-in agent plugins.
// One registration line per plugin is acceptable; behavioral ID switches are not.
// Tier-2 generic CLI agents are assembled from detect.GenericInvocations().
func buildAgentRegistry(
	ctx context.Context,
	st *store.Store,
	daemonURL string,
	tokenFn func() string,
	catalog *routing.Catalog,
	connectorHost connectors.Host,
	version string,
) (*agent.Registry, error) {
	factories := []agent.Factory{
		kinagent.NewPluginFactoryWithConfig(kinagent.PluginConfig{
			Store:      st,
			Connectors: connectorHost,
		}),
		claudecode.NewPluginFactory(claudecode.PluginConfig{
			DaemonURL: daemonURL,
			TokenFunc: tokenFn,
		}),
		codex.NewPluginFactory(),
		droid.NewPluginFactory(droid.PluginConfig{
			DaemonURL: daemonURL,
			TokenFunc: tokenFn,
			ConfiguredModels: func(ctx context.Context) ([]agent.ModelOption, error) {
				models, err := catalog.ModelsForAgent(ctx, "droid", routing.ProviderKindSubscription)
				if err != nil {
					return nil, err
				}
				out := make([]agent.ModelOption, len(models))
				for i, model := range models {
					out[i] = agent.ModelOption{ID: model.ID, Tier: model.Tier}
				}
				return out, nil
			},
		}),
		grok.NewPluginFactory(),
	}

	// ACP agents: one client per agent. The protocol is the contract, so the
	// binary is what decides which agent Kin is talking to; the table in
	// acpAgentConfigs names them, and each can be pointed elsewhere with
	// KIN_ACP_<NAME>_BIN / KIN_ACP_<NAME>_ARGS.
	for _, cfg := range acpAgentConfigs() {
		cfg.DaemonURL = daemonURL
		cfg.TokenFunc = tokenFn
		// The handshake names this client and its version. It is this daemon's
		// version, not the agent's: the claude adapter rejects an `initialize`
		// whose clientInfo has no version (-32602), and the other three accept
		// it silently, which is how a missing field stayed invisible.
		cfg.Version = version
		factories = append(factories, acp.NewPluginFactory(cfg))
	}

	// Native first-class adapters — skip when assembling generic factories.
	native := map[string]bool{
		"kin":         true,
		"claude-code": true,
		"codex":       true,
		"droid":       true,
		"grok":        true,
		"rawpty":      true,
	}
	invocations := detect.GenericInvocations()
	for _, spec := range detect.SkillsDiscoveryCatalog() {
		if native[spec.ID] {
			continue
		}
		inv, ok := invocations[spec.ID]
		if !ok {
			continue
		}
		f := genericcli.NewPluginFactory(spec, inv)
		f.Store = st
		factories = append(factories, f)
	}

	if os.Getenv("KIN_ENABLE_RAWPTY") == "1" {
		factories = append(factories, rawpty.NewPluginFactory())
	}
	reg, err := agent.Build(ctx, factories...)
	if err != nil {
		return nil, fmt.Errorf("build agent registry: %w", err)
	}
	return reg, nil
}

// acpAgent is one ACP agent Kin knows how to start.
type acpAgent struct {
	ID     string
	Name   string
	Binary string
	Args   []string
	// Modes maps Kin's permission modes to this agent's own mode ids, as the
	// agent publishes them in `session/new`. The ids are the agent's vocabulary,
	// not Kin's: this table is the only place that translation lives, and a
	// missing entry means the turn runs on the agent's own default with a
	// warning rather than a guess.
	Modes map[string]string
	// Unattended marks an agent that never asks before running a tool: it has no
	// permission ladder, and Kin cannot put a card in front of a question the
	// agent does not ask. Every mode on such an agent is a bypass, and the turn
	// says so once rather than pretending the default mode gates anything.
	Unattended bool
	// AcceptEditsBypasses marks an agent whose graded rung was measured
	// approving everything: accept_edits is then a bypass for the node's
	// permission ceiling, even though the rung exists.
	AcceptEditsBypasses bool
}

// acpAgents is the table of ACP agents every node registers.
//
// The ids are deliberately not the native adapters' ids (`claude-code`, `codex`,
// `droid`): both paths can be installed at once while the ACP route proves
// itself, and the picker has to be able to tell them apart. The commands are
// the ones the agents (or their vendor adapters) publish, pinned to the version
// measured in the ACP matrix: `codex-acp` moved to
// `@agentclientprotocol/codex-acp` (the `@zed-industries` package is deprecated
// and its 0.12 build rejects a current `~/.codex/config.toml`), and `pi-acp`
// 0.0.34 calls a pi RPC that pi 0.80.3 does not have, while 0.0.30 on the same
// pi opens a session. Bumping any line here is a visible decision.
var acpAgents = []acpAgent{
	{
		ID:     "claude-acp",
		Name:   "Claude Code (ACP)",
		Binary: "npx",
		Args:   []string{"-y", "@zed-industries/claude-agent-acp@0.23.1"},
		Modes: map[string]string{
			adapter.PermissionDefault:     "default",
			adapter.PermissionAcceptEdits: "acceptEdits",
			adapter.PermissionYOLO:        "bypassPermissions",
		},
	},
	{
		ID:     "codex-acp",
		Name:   "Codex (ACP)",
		Binary: "npx",
		Args:   []string{"-y", "@agentclientprotocol/codex-acp@2.3.0"},
		Modes: map[string]string{
			adapter.PermissionDefault:     "read-only",
			adapter.PermissionAcceptEdits: "workspace-write",
			adapter.PermissionYOLO:        "agent-full-access",
		},
	},
	{
		ID:     "droid-acp",
		Name:   "Droid (ACP)",
		Binary: "droid",
		Args:   []string{"exec", "--output-format", "acp"},
		// Droid's own default is `auto-high`, which approves everything without
		// asking; `normal` is the rung that matches Kin's default (reads only).
		//
		// `auto-low` is called "auto-approve edits and low-risk actions", but in
		// measurement it approved an out-of-workspace write and a shell command
		// (both rated low by droid) without asking, so accept_edits is reported
		// to the node as a bypass rather than a gate.
		Modes: map[string]string{
			adapter.PermissionDefault:     "normal",
			adapter.PermissionAcceptEdits: "auto-low",
			adapter.PermissionYOLO:        "auto-high",
		},
		AcceptEditsBypasses: true,
	},
	{
		ID:     "pi-acp",
		Name:   "Pi (ACP)",
		Binary: "npx",
		Args:   []string{"-y", "pi-acp@0.0.30"},
		// Pi's `modes` are thinking levels (off/minimal/low/medium/high/xhigh),
		// not a permission ladder, and it ran a file write without asking on
		// every turn measured. Mapping Kin's modes onto those ids would turn
		// reasoning off and call it a permission mode, so the honest statement is
		// that this agent has no approval channel at all.
		Unattended: true,
	},
}

// acpAgentConfigs applies the per-agent overrides to the table above:
// KIN_ACP_CODEX_BIN / KIN_ACP_CODEX_ARGS for `codex-acp`, and so on. Args are
// split on spaces, which is all one variable can honestly carry — an argument
// with a space in it needs a config file, not a bigger parser.
func acpAgentConfigs() []acp.PluginConfig {
	out := make([]acp.PluginConfig, 0, len(acpAgents))
	for _, entry := range acpAgents {
		key := strings.ToUpper(strings.ReplaceAll(strings.TrimSuffix(entry.ID, "-acp"), "-", "_"))
		cfg := acp.PluginConfig{
			ID: entry.ID, Name: entry.Name, Binary: entry.Binary, Args: entry.Args,
			Modes: entry.Modes, Unattended: entry.Unattended,
			AcceptEditsBypasses: entry.AcceptEditsBypasses,
		}
		if v := strings.TrimSpace(os.Getenv("KIN_ACP_" + key + "_BIN")); v != "" {
			cfg.Binary = v
		}
		if v := strings.TrimSpace(os.Getenv("KIN_ACP_" + key + "_ARGS")); v != "" {
			cfg.Args = strings.Fields(v)
		}
		out = append(out, cfg)
	}
	return out
}
