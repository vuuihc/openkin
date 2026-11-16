package agent

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
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

// bypassAdapter is an agent that answers the permission-ceiling probe: it has no
// approval channel, so it treats accept_edits as the bypass yolo is.
type bypassAdapter struct{ stubAdapter }

func (bypassAdapter) AutoApprovesAll(mode string) bool {
	return adapter.NormalizePermissionMode(mode) == adapter.PermissionAcceptEdits ||
		adapter.NormalizePermissionMode(mode) == adapter.PermissionYOLO
}

// TestGetRunnableKeepsTheAdaptersOwnAnswers: every runner the registry hands out
// goes through a wrapper of its own (cwd validation today), and a wrapper that
// only implements Start silently swallows anything else asked of the adapter.
// The permission ceiling asks exactly this question, and a swallowed answer
// reads as "safe mode" — the wrong way round for the agents that need it.
func TestGetRunnableKeepsTheAdaptersOwnAnswers(t *testing.T) {
	r := MustRegistry(Entry{
		ID: "opencode", Name: "OpenCode", Priority: 10, Runner: bypassAdapter{},
		Status: func(context.Context) Status { return Status{Installed: true, Available: true} },
	})
	reg, err := r.GetRunnable(context.Background(), "opencode")
	if err != nil {
		t.Fatal(err)
	}
	for mode, want := range map[string]bool{
		adapter.PermissionAcceptEdits: true,
		adapter.PermissionYOLO:        true,
		adapter.PermissionDefault:     false,
	} {
		if got := adapter.AutoApprovesAll(reg.Runner, mode); got != want {
			t.Fatalf("AutoApprovesAll(%q) through the registry = %v, want %v (runner is %T)",
				mode, got, want, reg.Runner)
		}
	}
}

// recordingCatalog is a provider catalog that answers with one session and
// remembers what it was asked.
type recordingCatalog struct {
	mu       sync.Mutex
	asked    []SessionQuery
	askedRef []string
}

func (c *recordingCatalog) List(_ context.Context, q SessionQuery) ([]SessionInfo, error) {
	c.mu.Lock()
	c.asked = append(c.asked, q)
	c.mu.Unlock()
	return []SessionInfo{{AgentID: "provider", ExternalRef: "ref-1"}}, nil
}

func (c *recordingCatalog) ReadHistory(_ context.Context, ref string, _ HistoryQuery) (HistoryPage, error) {
	c.mu.Lock()
	c.askedRef = append(c.askedRef, ref)
	c.mu.Unlock()
	return HistoryPage{Items: []HistoryItem{{Text: "hello"}}}, nil
}

func (c *recordingCatalog) Inspect(_ context.Context, ref string) (SessionInfo, error) {
	c.mu.Lock()
	c.askedRef = append(c.askedRef, ref)
	c.mu.Unlock()
	return SessionInfo{AgentID: "provider", ExternalRef: ref}, nil
}

// The remote node walks every registered agent and asks each one for its
// sessions, then skips the ones that answer "I have no catalog" so that a Mac
// with one session-aware provider does not report an error per provider that
// has none. That skip is only correct while two things stay true: a provider
// without a catalog is still *listed* here, and its refusal is this sentinel.
// Both are properties of this package, so they are pinned here rather than
// only in the node that reads them.
func TestAProviderWithNoCatalogRefusesWithTheSentinelItIsStillListedUnder(t *testing.T) {
	catalog := &recordingCatalog{}
	ctx := context.Background()
	reg, err := Build(ctx,
		stubFactory{
			desc: Descriptor{
				ID: "with-catalog", Name: "With Catalog", Priority: 1,
				Capabilities: []Capability{CapabilityRun, CapabilitySessionList, CapabilitySessionHistoryRead},
			},
			reg: Registration{
				Runner: stubAdapter{}, Catalog: catalog,
				Status: func(context.Context) Status { return Status{Installed: true, Available: true} },
			},
		},
		stubFactory{
			desc: Descriptor{
				ID: "no-catalog", Name: "No Catalog", Priority: 2,
				Capabilities: []Capability{CapabilityRun},
			},
			reg: Registration{
				Runner: stubAdapter{},
				Status: func(context.Context) Status { return Status{Installed: true, Available: true} },
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}

	ids := reg.IDs()
	if len(ids) != 2 {
		t.Fatalf("IDs() = %v, want both providers: a caller cannot skip what it is not shown", ids)
	}

	for _, call := range []struct {
		name string
		run  func() error
	}{
		{"ListSessions", func() error { _, err := reg.ListSessions(ctx, "no-catalog", SessionQuery{}); return err }},
		{"ReadSessionHistory", func() error {
			_, err := reg.ReadSessionHistory(ctx, "no-catalog", "ref-1", HistoryQuery{})
			return err
		}},
		{"InspectSession", func() error { _, err := reg.InspectSession(ctx, "no-catalog", "ref-1"); return err }},
	} {
		err := call.run()
		if !errors.Is(err, ErrSessionCatalogUnavailable) {
			t.Fatalf("%s on a catalog-less provider = %v, want ErrSessionCatalogUnavailable", call.name, err)
		}
		// The node's message reaches a person on another machine, and the whole
		// point of skipping unnamed providers is that when one *is* named the
		// answer has to say which provider could not answer.
		if !strings.Contains(err.Error(), "no-catalog") {
			t.Fatalf("%s = %q, want the provider named", call.name, err)
		}
	}

	// The provider that does have one is not collateral damage: the same
	// registry serves both, and the query travels unchanged.
	if _, err := reg.ListSessions(ctx, "with-catalog", SessionQuery{Limit: 7, Query: "auth"}); err != nil {
		t.Fatalf("ListSessions on a provider with a catalog: %v", err)
	}
	if len(catalog.asked) != 1 || catalog.asked[0].Limit != 7 || catalog.asked[0].Query != "auth" {
		t.Fatalf("the catalog was asked %+v, want the caller's query", catalog.asked)
	}

	// An agent id nobody registered is refused the same way, and deliberately:
	// the node's unnamed loop walks IDs(), so it never asks about an id that is
	// not there, and its skip rule keys on the sentinel rather than on whether
	// the provider exists. A distinct error here would be a new case for that
	// loop to handle, not a fix.
	if err := func() error { _, err := reg.ListSessions(ctx, "nobody", SessionQuery{}); return err }(); !errors.Is(err, ErrSessionCatalogUnavailable) {
		t.Fatalf("ListSessions on an unregistered id = %v, want ErrSessionCatalogUnavailable", err)
	}
}
