package genericcli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/vuuihc/openkin/internal/adapter/detect"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/store"
)

// PluginFactory registers one Tier-2 generic CLI agent from catalog + invocation.
type PluginFactory struct {
	Spec     detect.DiscoverySpec
	Inv      detect.Invocation
	LookPath func(file string) (string, error)
	// Store, when set, lets Status honor local smoke results over NeedsVerification.
	Store *store.Store
}

// NewPluginFactory returns a factory for one generic CLI agent.
func NewPluginFactory(spec detect.DiscoverySpec, inv detect.Invocation) *PluginFactory {
	return &PluginFactory{Spec: spec, Inv: inv}
}

// Descriptor implements agent.Factory.
func (f *PluginFactory) Descriptor() agent.Descriptor {
	return agent.Descriptor{
		ID:           f.Spec.ID,
		Name:         f.Spec.Name,
		Kind:         agent.KindCLI,
		Capabilities: []agent.Capability{agent.CapabilityRun},
	}
}

// Open implements agent.Factory.
func (f *PluginFactory) Open(ctx context.Context) (agent.Registration, error) {
	_ = ctx
	look := f.LookPath
	if look == nil {
		look = exec.LookPath
	}
	adapter := &Adapter{
		ID:       f.Spec.ID,
		Inv:      f.Inv,
		LookPath: look,
		EnvBin:   f.Spec.EnvBin,
		Bins:     f.Spec.Bins,
	}
	st := f.Store
	inv := f.Inv
	spec := f.Spec
	return agent.Registration{
		Descriptor: f.Descriptor(),
		Runner:     adapter,
		Status: func(c context.Context) agent.Status {
			return statusFor(c, spec, inv, look, st)
		},
	}, nil
}

func statusFor(
	ctx context.Context,
	spec detect.DiscoverySpec,
	inv detect.Invocation,
	look func(string) (string, error),
	st *store.Store,
) agent.Status {
	path, reason := resolveStatusBinary(spec, inv, look)
	if path == "" {
		if reason == "" {
			reason = "not found on PATH"
		}
		return agent.Status{Installed: false, Available: false, Reason: reason}
	}

	// Local smoke success overrides static NeedsVerification.
	if st != nil {
		if r, ok, err := st.GetAgentSmoke(ctx, spec.ID); err == nil && ok {
			if r.OK {
				return agent.Status{
					Installed: true,
					Available: true,
					Binary:    path,
					Reason:    "smoke ok",
				}
			}
			detail := strings.TrimSpace(r.Detail)
			if detail == "" {
				detail = "smoke failed"
			}
			return agent.Status{
				Installed: true,
				Available: false,
				Binary:    path,
				Reason:    "smoke failed: " + detail,
			}
		}
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
