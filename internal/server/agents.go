package server

import (
	"context"
	"fmt"
	"os"

	"github.com/vuuihc/kin/internal/adapter/claudecode"
	"github.com/vuuihc/kin/internal/adapter/codex"
	"github.com/vuuihc/kin/internal/adapter/detect"
	"github.com/vuuihc/kin/internal/adapter/genericcli"
	"github.com/vuuihc/kin/internal/adapter/grok"
	"github.com/vuuihc/kin/internal/adapter/kinagent"
	"github.com/vuuihc/kin/internal/adapter/rawpty"
	"github.com/vuuihc/kin/internal/agent"
	"github.com/vuuihc/kin/internal/store"
)

// buildAgentRegistry is the composition root for built-in agent plugins.
// One registration line per plugin is acceptable; behavioral ID switches are not.
// Tier-2 generic CLI agents are assembled from detect.GenericInvocations().
func buildAgentRegistry(
	ctx context.Context,
	st *store.Store,
	daemonURL string,
	tokenFn func() string,
) (*agent.Registry, error) {
	factories := []agent.Factory{
		kinagent.NewPluginFactory(st),
		claudecode.NewPluginFactory(claudecode.PluginConfig{
			DaemonURL: daemonURL,
			TokenFunc: tokenFn,
		}),
		codex.NewPluginFactory(),
		grok.NewPluginFactory(),
	}

	// Native first-class adapters — skip when assembling generic factories.
	native := map[string]bool{
		"kin":         true,
		"claude-code": true,
		"codex":       true,
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
		factories = append(factories, genericcli.NewPluginFactory(spec, inv))
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
