package genericcli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/vuuihc/kin/internal/adapter/detect"
	"github.com/vuuihc/kin/internal/agent"
)

// PluginFactory registers one Tier-2 generic CLI agent from catalog + invocation.
type PluginFactory struct {
	spec detect.DiscoverySpec
	inv  detect.Invocation
	// LookPath is overridable in tests.
	LookPath func(file string) (string, error)
}

// NewPluginFactory returns a factory for one generic CLI agent.
func NewPluginFactory(spec detect.DiscoverySpec, inv detect.Invocation) *PluginFactory {
	return &PluginFactory{spec: spec, inv: inv}
}

// Descriptor implements agent.Factory.
func (f *PluginFactory) Descriptor() agent.Descriptor {
	caps := []agent.Capability{agent.CapabilityRun}
	// Resume is only declared when we have a known resume flag path (none today).
	return agent.Descriptor{
		ID:           f.spec.ID,
		Name:         f.spec.Name,
		Kind:         agent.KindCLI,
		Priority:     f.spec.Priority,
		Capabilities: caps,
	}
}

// Open implements agent.Factory.
func (f *PluginFactory) Open(ctx context.Context) (agent.Registration, error) {
	_ = ctx
	look := f.LookPath
	if look == nil {
		look = exec.LookPath
	}
	ad := &Adapter{
		ID:       f.spec.ID,
		Name:     f.spec.Name,
		Inv:      f.inv,
		Bins:     append([]string(nil), f.spec.Bins...),
		EnvBin:   f.spec.EnvBin,
		LookPath: look,
	}
	desc := f.Descriptor()
	inv := f.inv
	spec := f.spec
	return agent.Registration{
		Descriptor: desc,
		Runner:     ad,
		Status: func(context.Context) agent.Status {
			return statusFor(spec, inv, look)
		},
	}, nil
}

func statusFor(spec detect.DiscoverySpec, inv detect.Invocation, look func(string) (string, error)) agent.Status {
	if look == nil {
		look = exec.LookPath
	}
	path, reason := resolveStatusBinary(spec, inv, look)
	if path == "" {
		if reason == "" {
			reason = "not found on PATH"
		}
		return agent.Status{Installed: false, Available: false, Reason: reason}
	}
	if inv.NeedsVerification {
		return agent.Status{
			Installed: true,
			Available: false,
			Binary:    path,
			Reason:    "detected; awaiting Kin maintainer smoke test before enabling",
		}
	}
	return agent.Status{Installed: true, Available: true, Binary: path}
}

func resolveStatusBinary(spec detect.DiscoverySpec, inv detect.Invocation, look func(string) (string, error)) (string, string) {
	if env := strings.TrimSpace(spec.EnvBin); env != "" {
		if v := strings.TrimSpace(os.Getenv(env)); v != "" {
			if path, err := look(v); err == nil {
				return path, ""
			}
			if _, err := os.Stat(v); err == nil {
				return v, ""
			}
		}
	}
	candidates := inv.BinCandidates
	if len(candidates) == 0 {
		candidates = spec.Bins
	}
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if path, err := look(c); err == nil {
			return path, ""
		}
	}
	if len(candidates) == 0 {
		return "", "no binary candidates configured"
	}
	return "", fmt.Sprintf("binary not found (tried %v)", candidates)
}
