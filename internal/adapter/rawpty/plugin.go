package rawpty

import (
	"context"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/agent"
)

// PluginFactory registers the opt-in raw PTY agent.
type PluginFactory struct{}

// NewPluginFactory returns a rawpty plugin factory.
func NewPluginFactory() *PluginFactory { return &PluginFactory{} }

// Descriptor implements agent.Factory.
func (f *PluginFactory) Descriptor() agent.Descriptor {
	return agent.Descriptor{
		ID:       "rawpty",
		Name:     "Raw PTY",
		Kind:     agent.KindCLI,
		Priority: 90,
		Capabilities: []agent.Capability{
			agent.CapabilityRun,
		},
	}
}

// Open implements agent.Factory.
func (f *PluginFactory) Open(ctx context.Context) (agent.Registration, error) {
	ad := New()
	return agent.Registration{
		Descriptor: f.Descriptor(),
		Runner:     ad,
		Status: func(context.Context) agent.Status {
			return agent.Status{Installed: true, Available: true, Binary: "/bin/sh"}
		},
	}, nil
}

var _ adapter.Adapter = (*Adapter)(nil)
