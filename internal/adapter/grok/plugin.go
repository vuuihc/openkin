package grok

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/agent"
)

// PluginConfig configures Grok discovery.
type PluginConfig struct {
	Binary   string
	LookPath func(file string) (string, error)
}

// PluginFactory registers the Grok CLI agent.
type PluginFactory struct {
	cfg PluginConfig
}

// NewPluginFactory returns a Grok plugin factory.
func NewPluginFactory() *PluginFactory {
	return &PluginFactory{}
}

// NewPluginFactoryWithConfig returns a Grok plugin factory with overrides.
func NewPluginFactoryWithConfig(cfg PluginConfig) *PluginFactory {
	return &PluginFactory{cfg: cfg}
}

// Descriptor implements agent.Factory.
func (f *PluginFactory) Descriptor() agent.Descriptor {
	return agent.Descriptor{
		ID:       "grok",
		Name:     "Grok",
		Kind:     agent.KindCLI,
		Priority: 40,
		Capabilities: []agent.Capability{
			agent.CapabilityRun,
			agent.CapabilityResume,
			agent.CapabilityTools,
			// No orchestrate: deterministic fallback only when hosting multi-agent turns.
		},
	}
}

// Open implements agent.Factory.
func (f *PluginFactory) Open(ctx context.Context) (agent.Registration, error) {
	bin := strings.TrimSpace(f.cfg.Binary)
	if bin == "" {
		if v := strings.TrimSpace(os.Getenv("KIN_GROK_BIN")); v != "" {
			bin = v
		} else {
			bin = "grok"
		}
	}
	look := f.cfg.LookPath
	if look == nil {
		look = exec.LookPath
	}
	ad := New()
	ad.Binary = bin
	ad.LookPath = look

	return agent.Registration{
		Descriptor: f.Descriptor(),
		Runner:     ad,
		Status: func(context.Context) agent.Status {
			path, err := look(bin)
			if err != nil {
				return agent.Status{
					Installed: false,
					Available: false,
					Reason:    fmt.Sprintf("grok binary not found (%q)", bin),
				}
			}
			return agent.Status{Installed: true, Available: true, Binary: path}
		},
	}, nil
}

var _ adapter.Adapter = (*Adapter)(nil)
