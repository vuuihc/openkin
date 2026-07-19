package agent

import (
	"context"
	"errors"
	"testing"

	"github.com/vuuihc/kin/internal/adapter"
)

type stubAdapter struct{}

func (stubAdapter) Start(context.Context, adapter.TaskSpec) (adapter.RunHandle, error) {
	return nil, errors.New("not implemented")
}

type stubController struct{}

func (stubController) Complete(context.Context, ControlRequest) (ControlResult, error) {
	return ControlResult{Text: "ok"}, nil
}

type stubFactory struct {
	desc Descriptor
	reg  Registration
	err  error
}

func (f stubFactory) Descriptor() Descriptor { return f.desc }
func (f stubFactory) Open(context.Context) (Registration, error) {
	if f.err != nil {
		return Registration{}, f.err
	}
	return f.reg, nil
}

func TestBuildRejectsDuplicateIDs(t *testing.T) {
	f := stubFactory{
		desc: Descriptor{ID: "kin", Name: "Kin", Priority: 10, Capabilities: []Capability{CapabilityRun}},
		reg: Registration{
			Runner: stubAdapter{},
			Status: func(context.Context) Status { return Status{Installed: true, Available: true} },
		},
	}
	_, err := Build(context.Background(), f, f)
	if err == nil {
		t.Fatal("expected duplicate id error")
	}
}

func TestBuildRejectsInvalidID(t *testing.T) {
	f := stubFactory{
		desc: Descriptor{ID: "Bad_ID", Name: "Bad", Priority: 1, Capabilities: []Capability{CapabilityRun}},
		reg: Registration{
			Runner: stubAdapter{},
			Status: func(context.Context) Status { return Status{Installed: true, Available: true} },
		},
	}
	_, err := Build(context.Background(), f)
	if err == nil {
		t.Fatal("expected invalid id error")
	}
}

func TestBuildRejectsOrchestrateWithoutController(t *testing.T) {
	f := stubFactory{
		desc: Descriptor{
			ID: "kin", Name: "Kin", Priority: 10,
			Capabilities: []Capability{CapabilityRun, CapabilityOrchestrate},
		},
		reg: Registration{
			Runner: stubAdapter{},
			Status: func(context.Context) Status { return Status{Installed: true, Available: true} },
		},
	}
	_, err := Build(context.Background(), f)
	if err == nil {
		t.Fatal("expected orchestrate requires controller")
	}
}

func TestDefaultPrefersConfiguredReady(t *testing.T) {
	r := MustRegistry(
		Entry{ID: "claude-code", Name: "Claude", Priority: 20, Runner: stubAdapter{}},
		Entry{ID: "codex", Name: "Codex", Priority: 30, Runner: stubAdapter{}},
		Entry{ID: "kin", Name: "Kin", Priority: 10, Runner: stubAdapter{}},
	)
	got := r.Default(context.Background(), "codex")
	if got != "codex" {
		t.Fatalf("default=%s want codex", got)
	}
}

func TestDefaultFallsBackByPriority(t *testing.T) {
	r := MustRegistry(
		Entry{
			ID: "claude-code", Name: "Claude", Priority: 20, Runner: stubAdapter{},
			Status: func(context.Context) Status { return Status{Installed: false, Available: false, Reason: "missing"} },
		},
		Entry{ID: "codex", Name: "Codex", Priority: 30, Runner: stubAdapter{}},
		Entry{
			ID: "kin", Name: "Kin", Priority: 10, Runner: stubAdapter{},
			Status: func(context.Context) Status { return Status{Installed: true, Available: false, Reason: "no provider"} },
		},
	)
	got := r.Default(context.Background(), "kin")
	if got != "codex" {
		t.Fatalf("default=%s want codex (only ready)", got)
	}
}

func TestGetRunnableErrors(t *testing.T) {
	r := MustRegistry(
		Entry{
			ID: "kin", Name: "Kin", Priority: 10, Runner: stubAdapter{},
			Status: func(context.Context) Status { return Status{Installed: true, Available: false, Reason: "no provider"} },
		},
		Entry{
			ID: "meta", Name: "Meta", Priority: 50,
			Caps:   []Capability{CapabilityOrchestrate},
			Runner: nil,
			Controller: stubController{},
			Status: func(context.Context) Status { return Status{Installed: true, Available: true} },
		},
	)
	_, err := r.GetRunnable(context.Background(), "missing")
	if !errors.Is(err, ErrUnknownAgent) {
		t.Fatalf("unknown: %v", err)
	}
	_, err = r.GetRunnable(context.Background(), "kin")
	if !errors.Is(err, ErrAgentUnavailable) {
		t.Fatalf("unavailable: %v", err)
	}
	_, err = r.GetRunnable(context.Background(), "meta")
	if !errors.Is(err, ErrAgentNotRunnable) {
		t.Fatalf("not runnable: %v", err)
	}
}

func TestListMarksExactlyOneDefault(t *testing.T) {
	r := MustRegistry(
		Entry{ID: "claude-code", Name: "Claude", Priority: 20, Runner: stubAdapter{}},
		Entry{ID: "codex", Name: "Codex", Priority: 30, Runner: stubAdapter{}},
	)
	list := r.List(context.Background(), "codex")
	if len(list) != 2 {
		t.Fatalf("len=%d", len(list))
	}
	var defaults int
	for _, info := range list {
		if info.Default {
			defaults++
			if info.ID != "codex" {
				t.Fatalf("default id=%s", info.ID)
			}
		}
	}
	if defaults != 1 {
		t.Fatalf("defaults=%d want 1", defaults)
	}
}

func TestCapabilityDedupeStableOrder(t *testing.T) {
	r := MustRegistry(Entry{
		ID: "kin", Name: "Kin", Priority: 10, Runner: stubAdapter{},
		Controller: stubController{},
		Caps: []Capability{
			CapabilityOrchestrate, CapabilityRun, CapabilityRun, CapabilityTools, CapabilityResume,
		},
	})
	reg, _ := r.Get("kin")
	want := []Capability{CapabilityRun, CapabilityResume, CapabilityTools, CapabilityOrchestrate}
	if len(reg.Descriptor.Capabilities) != len(want) {
		t.Fatalf("caps=%v", reg.Descriptor.Capabilities)
	}
	for i := range want {
		if reg.Descriptor.Capabilities[i] != want[i] {
			t.Fatalf("caps=%v want %v", reg.Descriptor.Capabilities, want)
		}
	}
}

func TestResetSession(t *testing.T) {
	var resetFor string
	r := MustRegistry(Entry{
		ID: "kin", Name: "Kin", Priority: 10, Runner: stubAdapter{},
		Sessions: sessionHookFunc(func(_ context.Context, taskID string) error {
			resetFor = taskID
			return nil
		}),
	})
	if err := r.ResetSession(context.Background(), "kin", "task-1"); err != nil {
		t.Fatal(err)
	}
	if resetFor != "task-1" {
		t.Fatalf("resetFor=%q", resetFor)
	}
	if err := r.ResetSession(context.Background(), "missing", "task-1"); err != nil {
		t.Fatal(err)
	}
}

type sessionHookFunc func(context.Context, string) error

func (f sessionHookFunc) Reset(ctx context.Context, taskID string) error { return f(ctx, taskID) }
