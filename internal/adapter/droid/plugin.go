package droid

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
)

// PluginConfig configures Droid discovery and Kin approval bridging.
type PluginConfig struct {
	Binary     string
	DaemonURL  string
	Token      string
	TokenFunc  func() string
	LookPath   func(file string) (string, error)
	HTTPClient *http.Client
	// ConfiguredModels returns optional provider-backed model overlays.
	ConfiguredModels func(context.Context) ([]agent.ModelOption, error)
}

// PluginFactory registers Factory Droid as a native Kin agent.
type PluginFactory struct {
	cfg PluginConfig
}

// NewPluginFactory returns a Droid plugin factory.
func NewPluginFactory(cfg PluginConfig) *PluginFactory {
	return &PluginFactory{cfg: cfg}
}

// Descriptor implements agent.Factory.
func (f *PluginFactory) Descriptor() agent.Descriptor {
	return agent.Descriptor{
		ID:       "droid",
		Name:     "Droid",
		Kind:     agent.KindCLI,
		Priority: 35,
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
	bin := strings.TrimSpace(f.cfg.Binary)
	if bin == "" {
		if value := strings.TrimSpace(os.Getenv("KIN_DROID_BIN")); value != "" {
			bin = value
		} else {
			bin = "droid"
		}
	}
	look := f.cfg.LookPath
	if look == nil {
		look = exec.LookPath
	}
	runner := New()
	runner.Binary = bin
	runner.LookPath = look
	runner.DaemonURL = f.cfg.DaemonURL
	runner.Token = f.cfg.Token
	runner.TokenFunc = f.cfg.TokenFunc
	runner.HTTPClient = f.cfg.HTTPClient

	return agent.Registration{
		Descriptor: f.Descriptor(),
		Runner:     runner,
		Status: func(context.Context) agent.Status {
			path, err := look(bin)
			if err != nil {
				return agent.Status{
					Installed: false,
					Available: false,
					Reason:    fmt.Sprintf("droid binary not found (%q)", bin),
				}
			}
			return agent.Status{Installed: true, Available: true, Binary: path}
		},
		Models: modelList(bin, look, f.cfg.ConfiguredModels),
	}, nil
}

var _ adapter.Adapter = (*Adapter)(nil)
