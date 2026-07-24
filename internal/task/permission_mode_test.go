package task

import (
	"context"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
)

func TestCreateStoresPermissionMode(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)

	t1, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "p",
		PermissionMode: adapter.PermissionYOLO,
	})
	if err != nil {
		t.Fatal(err)
	}
	if t1.PermissionMode != adapter.PermissionYOLO {
		t.Fatalf("permission_mode=%q want yolo", t1.PermissionMode)
	}
	// Round-trip via Get.
	got, err := e.Get(ctx, t1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PermissionMode != adapter.PermissionYOLO {
		t.Fatalf("get permission_mode=%q", got.PermissionMode)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)
}

func TestCreateDefaultPermissionMode(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	t1, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	if t1.PermissionMode != adapter.PermissionDefault {
		t.Fatalf("permission_mode=%q want default", t1.PermissionMode)
	}
}

// Session permission mode is applied to the main agent run.
func TestSingleAgentReceivesPermissionMode(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)

	t1, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "do stuff",
		PermissionMode: adapter.PermissionYOLO,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)

	ad.mu.Lock()
	defer ad.mu.Unlock()
	if ad.started < 1 {
		t.Fatal("adapter never started")
	}
	if ad.lastSpec.PermissionMode != adapter.PermissionYOLO {
		t.Fatalf("spec.PermissionMode=%q want yolo", ad.lastSpec.PermissionMode)
	}
}

// Multi-@ workers inherit the session permission mode (same for every agent).
func TestOrchestratedWorkersInheritPermissionMode(t *testing.T) {
	ctx := context.Background()
	kinAd := &fakeAdapter{events: successEvents()}
	claudeAd := &fakeAdapter{events: successEvents()}
	codexAd := &fakeAdapter{events: successEvents()}

	e, _ := testEngine(t, 4, kinAd)
	e.putAdapter("kin", kinAd)
	e.putAdapter("claude-code", claudeAd)
	e.putAdapter("codex", codexAd)
	e.SetDefaultAgentFn(func() string { return "kin" })

	t1, err := e.Create(ctx, CreateRequest{
		Agent: "kin",
		Cwd:   "/tmp",
		// Explicit multi-@ so both workers start under the orchestrator.
		Prompt:         "Investigate: @claude-code find the bug @codex verify the fix",
		PermissionMode: adapter.PermissionYOLO,
	})
	if err != nil {
		t.Fatal(err)
	}
	if t1.PermissionMode != adapter.PermissionYOLO {
		t.Fatalf("task permission_mode=%q", t1.PermissionMode)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)

	for name, ad := range map[string]*fakeAdapter{
		"claude-code": claudeAd,
		"codex":       codexAd,
	} {
		ad.mu.Lock()
		started := ad.started
		mode := ad.lastSpec.PermissionMode
		specs := append([]adapter.TaskSpec(nil), ad.specs...)
		ad.mu.Unlock()
		if started < 1 {
			t.Fatalf("%s worker never started", name)
		}
		if mode != adapter.PermissionYOLO {
			t.Fatalf("%s lastSpec.PermissionMode=%q want yolo (specs=%+v)", name, mode, specs)
		}
		for i, s := range specs {
			if s.PermissionMode != adapter.PermissionYOLO {
				t.Fatalf("%s specs[%d].PermissionMode=%q", name, i, s.PermissionMode)
			}
		}
	}
}

// Accept-edits mode also propagates to workers.
func TestOrchestratedWorkersAcceptEditsMode(t *testing.T) {
	ctx := context.Background()
	kinAd := &fakeAdapter{events: successEvents()}
	claudeAd := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, kinAd)
	e.putAdapter("kin", kinAd)
	e.putAdapter("claude-code", claudeAd)
	e.SetDefaultAgentFn(func() string { return "kin" })

	t1, err := e.Create(ctx, CreateRequest{
		Agent:          "kin",
		Cwd:            "/tmp",
		Prompt:         "@claude fix the flaky test",
		PermissionMode: adapter.PermissionAcceptEdits,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)

	claudeAd.mu.Lock()
	defer claudeAd.mu.Unlock()
	if claudeAd.started < 1 {
		t.Fatal("claude worker never started")
	}
	if claudeAd.lastSpec.PermissionMode != adapter.PermissionAcceptEdits {
		t.Fatalf("PermissionMode=%q want accept_edits", claudeAd.lastSpec.PermissionMode)
	}
}

func TestOrchestratedWorkersReceivePerStepModels(t *testing.T) {
	ctx := context.Background()
	kinAd := &fakeAdapter{events: successEvents()}
	claudeAd := &fakeAdapter{events: successEvents()}
	codexAd := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, kinAd)
	e.putAdapter("kin", kinAd)
	e.putAdapter("claude-code", claudeAd)
	e.putAdapter("codex", codexAd)
	e.SetDefaultAgentFn(func() string { return "kin" })

	fallback := "task-default"
	t1, err := e.Create(ctx, CreateRequest{
		Agent:  "kin",
		Cwd:    "/tmp",
		Prompt: "@claude[opus] implement it @codex[gpt-5.5] review it",
		Model:  &fallback,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)

	claudeAd.mu.Lock()
	claudeModel := claudeAd.lastSpec.Model
	claudeAd.mu.Unlock()
	if claudeModel != "claude-opus-4-8" {
		t.Fatalf("claude model=%q want claude-opus-4-8 (normalized)", claudeModel)
	}

	codexAd.mu.Lock()
	codexModel := codexAd.lastSpec.Model
	codexAd.mu.Unlock()
	if codexModel != "gpt-5.5" {
		t.Fatalf("codex model=%q want gpt-5.5", codexModel)
	}
}

func TestOrchestratedWorkerModelDoesNotInheritHostModel(t *testing.T) {
	ctx := context.Background()
	kinAd := &fakeAdapter{events: successEvents()}
	codexAd := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, kinAd)
	e.putAdapter("kin", kinAd)
	e.putAdapter("codex", codexAd)
	e.SetDefaultAgentFn(func() string { return "kin" })

	// Host model must not leak to a different worker agent (Claude/Kin aliases
	// are invalid on other backends). Empty worker model → adapter default.
	hostModel := "opus"
	t1, err := e.Create(ctx, CreateRequest{
		Agent: "kin", Cwd: "/tmp", Prompt: "@codex review it", Model: &hostModel,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)

	codexAd.mu.Lock()
	got := codexAd.lastSpec.Model
	codexAd.mu.Unlock()
	if got != "" {
		t.Fatalf("codex model=%q want empty (adapter default), not host %q", got, hostModel)
	}
}

func TestOrchestratedKinWorkerDoesNotInheritClaudeOpus(t *testing.T) {
	ctx := context.Background()
	claudeAd := &fakeAdapter{events: successEvents()}
	kinAd := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, claudeAd)
	e.putAdapter("claude-code", claudeAd)
	e.putAdapter("kin", kinAd)
	e.SetDefaultAgentFn(func() string { return "claude-code" })

	opus := "opus"
	t1, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "@kin compare with main", Model: &opus,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)

	kinAd.mu.Lock()
	got := kinAd.lastSpec.Model
	kinAd.mu.Unlock()
	if got != "" {
		t.Fatalf("kin worker model=%q want empty (provider default), not inherited %q", got, opus)
	}
}
