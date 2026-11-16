package task

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/routing"
	"github.com/vuuihc/openkin/internal/store"
)

func TestNewConfiguredEngineValidatesRequiredDependencies(t *testing.T) {
	_, err := NewConfiguredEngine(EngineConfig{})
	if err == nil {
		t.Fatal("expected configuration error")
	}
	for _, dependency := range []string{
		"Store",
		"Agents",
		"Workspace",
		"DefaultPreference",
		"RoutingResolver",
		"ProviderEntryResolver",
	} {
		if !strings.Contains(err.Error(), dependency) {
			t.Errorf("error %q does not name %s", err, dependency)
		}
	}
}

func TestConfiguredEngineRejectsCreateUntilRecoveryCompletes(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	ctx := context.Background()
	orphanID := "01ORPHANSTARTUP00000000001"
	if err := st.InsertTask(ctx, store.Task{
		ID: orphanID, Title: "orphan", Agent: "claude-code", Cwd: "/tmp",
		Prompt: "p", Status: StatusRunning, CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}

	engine := newConfiguredTestEngine(t, st)
	defer engine.Close()
	if engine.Started() {
		t.Fatal("configured engine reported started before Start")
	}
	if _, err := engine.Create(ctx, CreateRequest{Cwd: "/tmp", Prompt: "too early"}); !errors.Is(err, ErrEngineNotStarted) {
		t.Fatalf("Create before Start error=%v", err)
	}
	before, err := st.GetTask(ctx, orphanID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Status != StatusRunning {
		t.Fatalf("orphan status changed before Start: %s", before.Status)
	}

	if err := engine.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if !engine.Started() {
		t.Fatal("configured engine did not report started")
	}
	after, err := st.GetTask(ctx, orphanID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != StatusFailed {
		t.Fatalf("orphan status=%s want failed", after.Status)
	}
	if err := engine.Start(ctx); err != nil {
		t.Fatalf("second Start should be idempotent: %v", err)
	}
}

func TestConfiguredEngineExpiryOutlivesStartupContext(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	engine := newConfiguredTestEngine(t, st)
	defer engine.Close()
	engine.expiryInterval = time.Millisecond
	engine.SetApprovalTTL(time.Millisecond)
	startCtx, cancel := context.WithCancel(context.Background())
	if err := engine.Start(startCtx); err != nil {
		t.Fatal(err)
	}
	cancel()

	taskID := "01EXPIRYENGINECONTEXT00001"
	if err := st.InsertTask(context.Background(), store.Task{
		ID: taskID, Title: "expiry", Agent: "claude-code", Cwd: "/tmp",
		Prompt: "p", Status: StatusSucceeded, CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	approvalID := "01EXPIRYAPPROVAL000000001"
	if err := st.InsertApproval(context.Background(), store.Approval{
		ID: approvalID, TaskID: taskID, Kind: "tool", Payload: json.RawMessage(`{}`),
		Decision: store.DecisionPending, CreatedAt: store.NowMilli() - 100,
	}); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		approval, err := st.GetApproval(context.Background(), approvalID)
		if err != nil {
			t.Fatal(err)
		}
		if approval.Decision == store.DecisionExpired {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("approval expiry loop stopped with startup context")
}

func newConfiguredTestEngine(t *testing.T, st *store.Store) *Engine {
	t.Helper()
	ad := &fakeAdapter{events: successEvents()}
	reg := agent.MustRegistry(agent.Entry{
		ID:     "claude-code",
		Name:   "Claude Code",
		Runner: ad,
		Status: func(context.Context) agent.Status {
			return agent.Status{Installed: true, Available: true}
		},
	})
	engine, err := NewConfiguredEngine(EngineConfig{
		Store:             st,
		Agents:            reg,
		Workspace:         &fakeWorkspaceRuntime{},
		DefaultPreference: func(context.Context) (string, error) { return "claude-code", nil },
		RoutingResolver:   startupRoutingResolver{},
		ProviderEntryResolver: func(context.Context, string) (adapter.ProviderConfig, error) {
			return adapter.ProviderConfig{}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

type startupRoutingResolver struct{}

func (startupRoutingResolver) Resolve(context.Context, routing.ResolveRequest) (routing.Decision, error) {
	return routing.Decision{}, errors.New("not used")
}

func (startupRoutingResolver) Next(context.Context, routing.Decision, routing.Failure) (routing.Decision, bool) {
	return routing.Decision{}, false
}

func (startupRoutingResolver) LookupProvider(context.Context, string) (routing.ProviderProfile, error) {
	return routing.ProviderProfile{}, errors.New("not used")
}

func (startupRoutingResolver) Defaults(context.Context) (routing.RoutingDefaults, error) {
	return routing.DefaultRoutingDefaults(), nil
}
