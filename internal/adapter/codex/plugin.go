package codex

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
)

// PluginConfig configures Codex discovery.
type PluginConfig struct {
	Binary   string
	LookPath func(file string) (string, error)
}

// PluginFactory registers the Codex CLI agent.
type PluginFactory struct {
	cfg PluginConfig
}

// NewPluginFactory returns a Codex plugin factory.
func NewPluginFactory() *PluginFactory {
	return &PluginFactory{}
}

// NewPluginFactoryWithConfig returns a Codex plugin factory with overrides.
func NewPluginFactoryWithConfig(cfg PluginConfig) *PluginFactory {
	return &PluginFactory{cfg: cfg}
}

// Descriptor implements agent.Factory.
func (f *PluginFactory) Descriptor() agent.Descriptor {
	return agent.Descriptor{
		ID:       "codex",
		Name:     "Codex",
		Kind:     agent.KindCLI,
		Priority: 30,
		Capabilities: []agent.Capability{
			agent.CapabilityRun,
			agent.CapabilityResume,
			agent.CapabilityTools,
			agent.CapabilityOrchestrate,
			agent.CapabilityLazyWorkspace,
		},
	}
}

// Open implements agent.Factory.
func (f *PluginFactory) Open(ctx context.Context) (agent.Registration, error) {
	bin := strings.TrimSpace(f.cfg.Binary)
	if bin == "" {
		if v := strings.TrimSpace(os.Getenv("KIN_CODEX_BIN")); v != "" {
			bin = v
		} else {
			bin = "codex"
		}
	}
	look := f.cfg.LookPath
	if look == nil {
		look = exec.LookPath
	}
	ad := New()
	ad.Binary = bin
	ad.LookPath = look

	controller := &Controller{Binary: bin, LookPath: look}

	return agent.Registration{
		Descriptor: f.Descriptor(),
		Runner:     ad,
		Controller: controller,
		Status: func(context.Context) agent.Status {
			path, err := look(bin)
			if err != nil {
				return agent.Status{
					Installed: false,
					Available: false,
					Reason:    fmt.Sprintf("codex binary not found (%q)", bin),
				}
			}
			return agent.Status{Installed: true, Available: true, Binary: path}
		},
		LazyWorkspace: func(ctx context.Context) agent.LazyWorkspaceSupport {
			return probeCodexLazyWorkspace(ctx, bin, look)
		},
	}, nil
}

// probeCodexLazyWorkspace checks whether the installed codex binary supports
// --sandbox read-only and -c features.hooks=false flags.
func probeCodexLazyWorkspace(ctx context.Context, bin string, look func(string) (string, error)) agent.LazyWorkspaceSupport {
	path, err := look(bin)
	if err != nil {
		return agent.LazyWorkspaceSupport{
			Supported: false,
			Reason:    fmt.Sprintf("codex not found: %v", err),
		}
	}
	// Probe: codex --help should mention --sandbox
	cmd := exec.CommandContext(ctx, path, "--help")
	out, err := cmd.Output()
	if err != nil {
		return agent.LazyWorkspaceSupport{
			Supported: false,
			Reason:    fmt.Sprintf("codex --help failed: %v", err),
		}
	}
	help := string(out)
	if !strings.Contains(help, "--sandbox") {
		return agent.LazyWorkspaceSupport{
			Supported: false,
			Reason:    "codex does not support --sandbox flag",
		}
	}
	return agent.LazyWorkspaceSupport{
		Supported: true,
		Version:   "codex",
	}
}

var _ adapter.Adapter = (*Adapter)(nil)
