package acp

import (
	"context"
	"fmt"
	"net/http"
	"os"
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
	// Binary is the executable that speaks ACP over stdio. Empty means
	// $KIN_ACP_BIN, then "codex-acp".
	Binary string
	// Args are passed to the binary on every start. Empty means $KIN_ACP_ARGS,
	// split on spaces.
	Args     []string
	LookPath func(file string) (string, error)

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

// binary is the ACP agent this factory starts: what the caller configured, then
// the environment, then the ACP agent that is most often installed.
func (f *PluginFactory) binary() string {
	if bin := strings.TrimSpace(f.cfg.Binary); bin != "" {
		return bin
	}
	if bin := strings.TrimSpace(os.Getenv("KIN_ACP_BIN")); bin != "" {
		return bin
	}
	return "codex-acp"
}

// args are the flags the agent needs to start. They are split on spaces, which
// is all a single environment variable can honestly carry: an argument with a
// space in it needs a config file, not a bigger parser.
func (f *PluginFactory) args() []string {
	if len(f.cfg.Args) > 0 {
		return f.cfg.Args
	}
	return strings.Fields(os.Getenv("KIN_ACP_ARGS"))
}

var _ agent.Factory = (*PluginFactory)(nil)
