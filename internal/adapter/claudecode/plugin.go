package claudecode

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
)

// PluginConfig configures Claude Code discovery and the approval bridge.
type PluginConfig struct {
	Binary    string
	DaemonURL string
	Token     string
	TokenFunc func() string
	LookPath  func(file string) (string, error)
}

// PluginFactory registers the Claude Code CLI agent.
type PluginFactory struct {
	cfg PluginConfig
}

// NewPluginFactory returns a Claude Code plugin factory.
func NewPluginFactory(cfg PluginConfig) *PluginFactory {
	return &PluginFactory{cfg: cfg}
}

// Descriptor implements agent.Factory.
func (f *PluginFactory) Descriptor() agent.Descriptor {
	return agent.Descriptor{
		ID:       "claude-code",
		Name:     "Claude Code",
		Kind:     agent.KindCLI,
		Priority: 20,
		Capabilities: []agent.Capability{
			agent.CapabilityRun,
			agent.CapabilityResume,
			agent.CapabilityTools,
			agent.CapabilityApprovals,
			agent.CapabilityOrchestrate,
			agent.CapabilityLazyWorkspace,
		},
	}
}

// Open implements agent.Factory.
func (f *PluginFactory) Open(ctx context.Context) (agent.Registration, error) {
	bin := strings.TrimSpace(f.cfg.Binary)
	if bin == "" {
		if v := strings.TrimSpace(os.Getenv("KIN_CLAUDE_BIN")); v != "" {
			bin = v
		} else {
			bin = "claude"
		}
	}
	look := f.cfg.LookPath
	if look == nil {
		look = exec.LookPath
	}
	ad := New()
	ad.Binary = bin
	ad.LookPath = look
	ad.DaemonURL = f.cfg.DaemonURL
	ad.Token = f.cfg.Token
	ad.TokenFunc = f.cfg.TokenFunc

	controller := &Controller{
		Binary:   bin,
		LookPath: look,
	}

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
					Reason:    fmt.Sprintf("claude binary not found (%q)", bin),
				}
			}
			return agent.Status{Installed: true, Available: true, Binary: path}
		},
		LazyWorkspace: func(ctx context.Context) agent.LazyWorkspaceSupport {
			return probeClaudeLazyWorkspace(ctx, bin, look)
		},
	}, nil
}

// probeClaudeLazyWorkspace checks whether the installed claude binary supports
// --permission-mode plan and --allowedTools/--disallowedTools flags.
func probeClaudeLazyWorkspace(ctx context.Context, bin string, look func(string) (string, error)) agent.LazyWorkspaceSupport {
	path, err := look(bin)
	if err != nil {
		return agent.LazyWorkspaceSupport{
			Supported: false,
			Reason:    fmt.Sprintf("claude not found: %v", err),
		}
	}
	// Probe: claude --help should mention --permission-mode
	cmd := exec.CommandContext(ctx, path, "--help")
	out, err := cmd.Output()
	if err != nil {
		return agent.LazyWorkspaceSupport{
			Supported: false,
			Reason:    fmt.Sprintf("claude --help failed: %v", err),
		}
	}
	help := string(out)
	if !strings.Contains(help, "--permission-mode") {
		return agent.LazyWorkspaceSupport{
			Supported: false,
			Reason:    "claude does not support --permission-mode flag",
		}
	}
	return agent.LazyWorkspaceSupport{
		Supported: true,
		Version:   "claude",
	}
}

var _ adapter.Adapter = (*Adapter)(nil)
