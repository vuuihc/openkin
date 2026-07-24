package genericcli

import (
	"context"
	"fmt"
	"testing"

	"github.com/vuuihc/kin/internal/adapter/detect"
	"github.com/vuuihc/kin/internal/agent"
)

func TestPluginFactoryDescriptor(t *testing.T) {
	spec := detect.DiscoverySpec{ID: "gemini-cli", Name: "Gemini CLI", Priority: 40, Bins: []string{"gemini"}}
	inv := detect.Invocation{Mode: "json", Args: []string{"--prompt", "{{prompt}}"}}
	f := NewPluginFactory(spec, inv)
	d := f.Descriptor()
	if d.ID != "gemini-cli" || d.Kind != agent.KindCLI {
		t.Fatalf("%+v", d)
	}
	if d.Has(agent.CapabilityApprovals) || d.Has(agent.CapabilityOrchestrate) || d.Has(agent.CapabilityTools) {
		t.Fatalf("tier2 must not declare approvals/orchestrate/tools: %+v", d.Capabilities)
	}
	if !d.Has(agent.CapabilityRun) {
		t.Fatal("missing run")
	}
}

func TestPluginStatusNeedsVerification(t *testing.T) {
	spec := detect.DiscoverySpec{ID: "pi", Name: "Pi", Bins: []string{"pi"}}
	inv := detect.Invocation{
		Mode:              "json",
		Args:              []string{"-p", "{{prompt}}"},
		NeedsVerification: true,
	}
	f := NewPluginFactory(spec, inv)
	f.LookPath = func(file string) (string, error) {
		if file == "pi" {
			return "/usr/bin/pi", nil
		}
		return "", fmt.Errorf("not found")
	}
	reg, err := f.Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	st := reg.Status(context.Background())
	if !st.Installed {
		t.Fatalf("installed=%v", st.Installed)
	}
	if st.Available {
		t.Fatal("NeedsVerification must keep Available=false")
	}
	if st.Reason == "" {
		t.Fatal("expected reason")
	}
}

func TestPluginStatusNotInstalled(t *testing.T) {
	spec := detect.DiscoverySpec{ID: "gemini-cli", Name: "Gemini CLI", Bins: []string{"gemini"}}
	inv := detect.Invocation{Mode: "json", Args: []string{"--prompt", "{{prompt}}"}}
	f := NewPluginFactory(spec, inv)
	f.LookPath = func(string) (string, error) { return "", fmt.Errorf("missing") }
	reg, err := f.Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	st := reg.Status(context.Background())
	if st.Installed || st.Available {
		t.Fatalf("%+v", st)
	}
}

func TestPluginStatusAvailable(t *testing.T) {
	spec := detect.DiscoverySpec{ID: "gemini-cli", Name: "Gemini CLI", Bins: []string{"gemini"}}
	inv := detect.Invocation{Mode: "json", Args: []string{"--prompt", "{{prompt}}"}}
	f := NewPluginFactory(spec, inv)
	f.LookPath = func(file string) (string, error) {
		if file == "gemini" {
			return "/bin/gemini", nil
		}
		return "", fmt.Errorf("missing")
	}
	reg, err := f.Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	st := reg.Status(context.Background())
	if !st.Installed || !st.Available || st.Binary != "/bin/gemini" {
		t.Fatalf("%+v", st)
	}
}
