package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

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
