package kinagent

import (
	"context"
	"fmt"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/agent"
	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/store"
)

// PluginConfig configures the Kin built-in plugin factory.
type PluginConfig struct {
	Store *store.Store
	// Resolve optional override; default loads provider config from Store.
	Resolve Resolver
}

// PluginFactory registers the built-in Kin agent.
type PluginFactory struct {
	cfg PluginConfig
}

// NewPluginFactory returns a Kin plugin factory.
func NewPluginFactory(st *store.Store) *PluginFactory {
	return &PluginFactory{cfg: PluginConfig{Store: st}}
}

// NewPluginFactoryWithConfig returns a Kin plugin factory with overrides.
func NewPluginFactoryWithConfig(cfg PluginConfig) *PluginFactory {
	return &PluginFactory{cfg: cfg}
}

// Descriptor implements agent.Factory.
func (f *PluginFactory) Descriptor() agent.Descriptor {
	return agent.Descriptor{
		ID:       AgentID,
		Name:     "Kin",
		Kind:     agent.KindBuiltin,
		Priority: 10,
		Capabilities: []agent.Capability{
			agent.CapabilityRun,
			agent.CapabilityResume,
			agent.CapabilityTools,
			agent.CapabilityOrchestrate,
		},
	}
}

// Open implements agent.Factory.
func (f *PluginFactory) Open(ctx context.Context) (agent.Registration, error) {
	st := f.cfg.Store
	resolve := f.cfg.Resolve
	if resolve == nil {
		if st == nil {
			return agent.Registration{}, fmt.Errorf("kin plugin: store required")
		}
		resolve = func(c context.Context) (provider.Client, provider.Config, error) {
			cfg, err := provider.LoadConfig(c, st)
			if err != nil {
				return nil, cfg, err
			}
			if !cfg.Configured() {
				return nil, cfg, fmt.Errorf("provider not configured (Settings → Cognition)")
			}
			cli, err := provider.NewClient(cfg)
			return cli, cfg, err
		}
	}

	ad := New(resolve)
	if st != nil {
		bridge := StoreTranscript{Store: st}
		ad.Transcript = bridge
		ad.Search = bridge
	}

	controller := &Controller{Resolve: resolve}
	sessions := &sessionHooks{store: st}

	return agent.Registration{
		Descriptor: f.Descriptor(),
		Runner:     ad,
		Controller: controller,
		Sessions:   sessions,
		Status: func(c context.Context) agent.Status {
			if st == nil {
				return agent.Status{Installed: true, Available: false, Reason: "no store"}
			}
			cfg, err := provider.LoadConfig(c, st)
			if err != nil {
				return agent.Status{Installed: true, Available: false, Reason: err.Error()}
			}
			if !cfg.Configured() {
				return agent.Status{
					Installed: true,
					Available: false,
					Reason:    "configure provider.base_url + provider.model in Settings",
				}
			}
			return agent.Status{
				Installed: true,
				Available: true,
				Binary:    cfg.BaseURL,
			}
		},
	}, nil
}

type sessionHooks struct {
	store *store.Store
}

func (h *sessionHooks) Reset(ctx context.Context, taskID string) error {
	if h == nil || h.store == nil {
		return nil
	}
	return h.store.ClearKinMessages(ctx, taskID)
}

// Ensure Adapter satisfies adapter.Adapter.
var _ adapter.Adapter = (*Adapter)(nil)
