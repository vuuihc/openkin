package acp

import (
	"context"
	"fmt"
	"net/http"
	"os/exec"
	"strings"

	"github.com/vuuihc/openkin/internal/agent"
)

// PluginConfig configures one ACP agent.
//
// ACP is a protocol, not a product: several agents speak it, and which one Kin
// is running is decided by the binary. So the agent id and the binary travel
// together, and a daemon that wants two ACP agents registers two factories.
type PluginConfig struct {
	// ID and Name are the agent's identity in Kin. Empty means "acp".
	ID   string
	Name string
	// Binary is the executable that speaks ACP over stdio. Registration resolves
	// it (per-agent environment overrides live there, not here); empty falls back
	// to "codex-acp" so a zero config still names something honest in an error.
	Binary string
	// Args are passed to the binary on every start.
	Args     []string
	LookPath func(file string) (string, error)

	// Modes bridges Kin's permission modes to this agent's own mode ids. The
	// agent publishes its ladder; only the registration knows which rung means
	// "ask", "accept edits", or "do not ask" for that agent.
	Modes map[string]string
	// Unattended marks an agent with no approval channel: it runs every tool
	// call without asking, so no mode can gate it and the ceiling says so.
	Unattended bool
	// AcceptEditsBypasses marks an agent whose graded rung approves everything
	// measured, so its accept_edits turn is reported to the node as a bypass.
	AcceptEditsBypasses bool

	// DaemonURL and Token are this machine's own daemon — the approval inbox the
	// agent's questions go into. Secrets stay here: an ACP agent authenticates
	// itself, and Kin never routes provider credentials into it (ADR 0022 D7).
	DaemonURL  string
	Token      string
	TokenFunc  func() string
	HTTPClient *http.Client
	Version    string
}

// PluginFactory registers one ACP agent.
type PluginFactory struct {
	cfg PluginConfig
}

// NewPluginFactory returns an ACP plugin factory.
func NewPluginFactory(cfg PluginConfig) *PluginFactory {
	return &PluginFactory{cfg: cfg}
}

// Descriptor implements agent.Factory.
//
// The capability list is the honest one for a protocol that has: a prompt, a
// session that can be loaded, tools the agent runs itself, and permission
// questions Kin answers. Everything else — the filesystem and the terminal —
// belongs to the agent, which is exactly what ACP says.
func (f *PluginFactory) Descriptor() agent.Descriptor {
	return agent.Descriptor{
		ID:       f.agentID(),
		Name:     f.agentName(),
		Kind:     agent.KindCLI,
		Priority: 40,
		Capabilities: []agent.Capability{
			agent.CapabilityRun,
			agent.CapabilityResume,
			agent.CapabilityTools,
			agent.CapabilityApprovals,
		},
	}
}

// Open implements agent.Factory.
func (f *PluginFactory) Open(context.Context) (agent.Registration, error) {
	bin := f.binary()
	look := f.cfg.LookPath
	if look == nil {
		look = exec.LookPath
	}
	runner := New(bin)
	runner.Args = f.args()
	runner.LookPath = look
	runner.Modes = f.cfg.Modes
	runner.Unattended = f.cfg.Unattended
	runner.AcceptEditsBypasses = f.cfg.AcceptEditsBypasses
	runner.DaemonURL = f.cfg.DaemonURL
	runner.Token = f.cfg.Token
	runner.TokenFunc = f.cfg.TokenFunc
	runner.HTTPClient = f.cfg.HTTPClient
	runner.Version = f.cfg.Version

	return agent.Registration{
		Descriptor: f.Descriptor(),
		Runner:     runner,
		Status: func(context.Context) agent.Status {
			path, err := look(bin)
			if err != nil {
				return agent.Status{
					Installed: false,
					Available: false,
					Reason:    fmt.Sprintf("ACP agent %q not found (%v)", bin, err),
				}
			}
			return agent.Status{Installed: true, Available: true, Binary: path}
		},
		// There is no way to ask an ACP agent what models it offers without
		// opening a session first, and Kin has no session at startup. Saying so is
		// better than a list this daemon made up; a task that names a model gets
		// the session's own answer, and a model the agent does not offer fails the
		// turn instead of running on something else (see applyModel).
		Models: func(context.Context) agent.ModelList {
			return agent.ModelList{Source: "none", Status: "default_only"}
		},
	}, nil
}

func (f *PluginFactory) agentID() string {
	if id := strings.TrimSpace(f.cfg.ID); id != "" {
		return id
	}
	return "acp"
}

func (f *PluginFactory) agentName() string {
	if name := strings.TrimSpace(f.cfg.Name); name != "" {
		return name
	}
	return "ACP"
}

// binary is the executable this factory starts: what the caller configured, or
// the ACP agent that is most often installed when the config names nothing.
func (f *PluginFactory) binary() string {
	if bin := strings.TrimSpace(f.cfg.Binary); bin != "" {
		return bin
	}
	return "codex-acp"
}

// args are the flags the agent needs to start.
func (f *PluginFactory) args() []string {
	return f.cfg.Args
}

var _ agent.Factory = (*PluginFactory)(nil)
