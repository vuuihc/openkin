package droid

import (
	"context"
	"errors"
	"testing"

	"github.com/vuuihc/openkin/internal/agent"
)

func TestPluginDescriptor(t *testing.T) {
	descriptor := NewPluginFactory(PluginConfig{}).Descriptor()
	if descriptor.ID != "droid" || descriptor.Kind != agent.KindCLI {
		t.Fatalf("descriptor=%+v", descriptor)
	}
	for _, capability := range []agent.Capability{
		agent.CapabilityRun,
		agent.CapabilityResume,
		agent.CapabilityTools,
		agent.CapabilityApprovals,
	} {
		if !descriptor.Has(capability) {
			t.Errorf("missing capability %q", capability)
		}
	}
	if descriptor.Has(agent.CapabilityOrchestrate) || descriptor.Has(agent.CapabilityLazyWorkspace) {
		t.Fatalf("Droid must not declare orchestrate/lazy_workspace: %v", descriptor.Capabilities)
	}
}

func TestPluginStatusAndEnvironmentOverride(t *testing.T) {
	tests := []struct {
		name      string
		env       string
		lookPath  func(string) (string, error)
		installed bool
		binary    string
	}{
		{
			name: "environment override",
			env:  "/opt/factory/droid",
			lookPath: func(file string) (string, error) {
				if file != "/opt/factory/droid" {
					t.Fatalf("lookPath(%q)", file)
				}
				return file, nil
			},
			installed: true,
			binary:    "/opt/factory/droid",
		},
		{
			name: "missing",
			lookPath: func(file string) (string, error) {
				if file != "droid" {
					t.Fatalf("lookPath(%q)", file)
				}
				return "", errors.New("missing")
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("KIN_DROID_BIN", test.env)
			factory := NewPluginFactory(PluginConfig{LookPath: test.lookPath})
			registration, err := factory.Open(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			status := registration.Status(context.Background())
			if status.Installed != test.installed || status.Available != test.installed || status.Binary != test.binary {
				t.Fatalf("status=%+v", status)
			}
			if registration.Controller != nil || registration.LazyWorkspace != nil {
				t.Fatal("Droid must not expose orchestrate or lazy workspace handlers")
			}
		})
	}
}
