package task

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
)

func TestCreateDelegationPreservesConfiguredHost(t *testing.T) {
	ctx := context.Background()
	defaultAdapter := &fakeAdapter{events: successEvents()}
	kinAdapter := &fakeAdapter{events: successEvents()}
	workerAdapter := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, defaultAdapter)
	e.putAdapter("codex", defaultAdapter)
	e.putAdapter("kin", kinAdapter)
	e.putAdapter("claude-code", workerAdapter)
	e.SetDefaultAgentFn(func() string { return "codex" })

	task, err := e.Create(ctx, CreateRequest{
		Cwd:    "/tmp",
		Prompt: "@claude-code inspect the failing test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.Agent != "codex" {
		t.Fatalf("agent=%q want configured host codex", task.Agent)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
}

func TestFollowUpDelegationPreservesSessionHost(t *testing.T) {
	ctx := context.Background()
	codexAdapter := &fakeAdapter{events: successEvents()}
	kinAdapter := &fakeAdapter{events: successEvents()}
	workerAdapter := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, codexAdapter)
	e.putAdapter("codex", codexAdapter)
	e.putAdapter("kin", kinAdapter)
	e.putAdapter("claude-code", workerAdapter)
	e.SetDefaultAgentFn(func() string { return "codex" })

	task, err := e.Create(ctx, CreateRequest{
		Agent:  "codex",
		Cwd:    "/tmp",
		Prompt: "first turn",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)

	task, err = e.FollowUp(ctx, task.ID, "@claude-code inspect the failing test")
	if err != nil {
		t.Fatal(err)
	}
	if task.Agent != "codex" {
		t.Fatalf("agent=%q want existing host codex", task.Agent)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
}

func TestMentionOfSessionHostDoesNotDelegateToItself(t *testing.T) {
	ctx := context.Background()
	codexAdapter := &fakeAdapter{events: successEvents()}
	kinAdapter := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, codexAdapter)
	e.putAdapter("codex", codexAdapter)
	e.putAdapter("kin", kinAdapter)
	e.SetDefaultAgentFn(func() string { return "codex" })

	task, err := e.Create(ctx, CreateRequest{
		Agent:  "codex",
		Cwd:    "/tmp",
		Prompt: "@codex inspect the failing test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.Agent != "codex" {
		t.Fatalf("agent=%q want codex", task.Agent)
	}
	if plan, ok := e.shouldOrchestrate(task); ok {
		t.Fatalf("host mention must stay a direct turn, got plan=%+v", plan)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
}

func TestFollowUpMentionOfSessionHostKeepsResume(t *testing.T) {
	ctx := context.Background()
	codexAdapter := &fakeAdapter{events: successEvents()}
	kinAdapter := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, codexAdapter)
	e.putAdapter("codex", codexAdapter)
	e.putAdapter("kin", kinAdapter)
	e.SetDefaultAgentFn(func() string { return "codex" })

	task, err := e.Create(ctx, CreateRequest{
		Agent:  "codex",
		Cwd:    "/tmp",
		Prompt: "first turn",
	})
	if err != nil {
		t.Fatal(err)
	}
	task = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
	if task.SessionRef == nil || *task.SessionRef == "" {
		t.Fatal("first Codex turn did not persist a session ref")
	}
	wantSessionRef := *task.SessionRef

	task, err = e.FollowUp(ctx, task.ID, "@codex continue the same work")
	if err != nil {
		t.Fatal(err)
	}
	if task.Agent != "codex" {
		t.Fatalf("agent=%q want codex", task.Agent)
	}
	if task.SessionRef == nil || *task.SessionRef != wantSessionRef {
		t.Fatalf("session_ref=%v want preserved %q", task.SessionRef, wantSessionRef)
	}
	if plan, ok := e.shouldOrchestrate(task); ok {
		t.Fatalf("host mention must stay a direct resumed turn, got plan=%+v", plan)
	}
	events, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	foundUserGuide := false
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Type != "message" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(events[i].Payload, &payload); err != nil || payload["role"] != "user" {
			continue
		}
		foundUserGuide = true
		if payload["source"] != "follow_up" {
			t.Fatalf("user guide source=%v want follow_up", payload["source"])
		}
		break
	}
	if !foundUserGuide {
		t.Fatal("follow-up user guide event not found")
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
}

func TestWorkerRetryMessageUsesSessionHostSpeaker(t *testing.T) {
	ctx := context.Background()
	codexAdapter := &fakeAdapter{events: successEvents()}
	kinAdapter := &fakeAdapter{events: successEvents()}
	workerAdapter := &fakeAdapter{events: []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{"session_id":"worker"}`)},
		{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"I am a task worker; reply with findings only."}],"partial":false}`)},
		{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)},
	}}
	e, _ := testEngine(t, 4, codexAdapter)
	e.putAdapter("codex", codexAdapter)
	e.putAdapter("kin", kinAdapter)
	e.putAdapter("claude-code", workerAdapter)
	e.SetDefaultAgentFn(func() string { return "codex" })

	task, err := e.Create(ctx, CreateRequest{
		Cwd:    "/tmp",
		Prompt: "@claude-code inspect the failing test",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusFailed, 3*time.Second)

	events, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	foundRetry := false
	for _, event := range events {
		if event.Type != "message" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			continue
		}
		content, _ := payload["content"].([]any)
		if len(content) == 0 {
			continue
		}
		part, _ := content[0].(map[string]any)
		text, _ := part["text"].(string)
		if text == "" || !strings.Contains(text, "retrying once") {
			continue
		}
		foundRetry = true
		if payload["speaker"] != "codex" {
			t.Fatalf("retry speaker=%v want codex", payload["speaker"])
		}
	}
	if !foundRetry {
		t.Fatal("worker retry message not found")
	}
}

func TestSameAgentModelSwitchOrchestrates(t *testing.T) {
	ctx := context.Background()
	hostAd := &fakeAdapter{events: successEvents()}
	// Same agent id used as worker — putAdapter once, capture specs from hostAd.
	e, _ := testEngine(t, 4, hostAd)
	e.putAdapter("claude-code", hostAd)
	e.SetDefaultAgentFn(func() string { return "claude-code" })

	opus := "claude-opus-4-8"
	task, err := e.Create(ctx, CreateRequest{
		Agent:  "claude-code",
		Cwd:    "/tmp",
		Prompt: "plan only",
		Model:  &opus,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)

	// Reset capture after create turn.
	hostAd.mu.Lock()
	hostAd.specs = nil
	hostAd.started = 0
	hostAd.mu.Unlock()

	task, err = e.FollowUp(ctx, task.ID, "@claude-code[haiku] implement the plan")
	if err != nil {
		t.Fatal(err)
	}
	if task.Agent != "claude-code" {
		t.Fatalf("host must stay claude-code, got %q", task.Agent)
	}
	// After follow-up patch the prompt is set; shouldOrchestrate on the updated task.
	if plan, ok := e.shouldOrchestrate(task); !ok {
		t.Fatalf("expected orchestration for same-agent model switch, plan=%+v", plan)
	} else if len(plan.Steps) != 1 || plan.Steps[0].Model == "" {
		t.Fatalf("worker step model missing: %+v", plan.Steps)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	hostAd.mu.Lock()
	specs := append([]adapter.TaskSpec(nil), hostAd.specs...)
	hostAd.mu.Unlock()
	if len(specs) == 0 {
		t.Fatal("expected worker Start")
	}
	// Last start should be the haiku worker (normalized).
	last := specs[len(specs)-1]
	if last.Model != "claude-haiku-4-5" && last.Model != "haiku" {
		// effectiveStepModel normalizes to catalog id
		t.Fatalf("worker model=%q want haiku family, specs=%+v", last.Model, specs)
	}
	if last.Agent != "claude-code" {
		t.Fatalf("worker agent=%q", last.Agent)
	}
}

func TestFollowUpModelUpdatesTaskAndSpec(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	e.putAdapter("claude-code", ad)

	opus := "claude-opus-4-8"
	task, err := e.Create(ctx, CreateRequest{
		Agent:  "claude-code",
		Cwd:    "/tmp",
		Prompt: "first",
		Model:  &opus,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)

	ad.mu.Lock()
	ad.specs = nil
	ad.mu.Unlock()

	haiku := "haiku"
	task, err = e.FollowUpWith(ctx, task.ID, FollowUpRequest{
		Prompt: "now execute cheaply",
		Model:  &haiku,
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.Model == nil || *task.Model != "claude-haiku-4-5" {
		t.Fatalf("task.Model=%v want claude-haiku-4-5", task.Model)
	}
	// Model switch should clear session_ref for a clean Start with --model.
	if task.SessionRef != nil && *task.SessionRef != "" {
		t.Fatalf("session_ref should clear on model switch, got %v", task.SessionRef)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)

	ad.mu.Lock()
	specs := append([]adapter.TaskSpec(nil), ad.specs...)
	ad.mu.Unlock()
	if len(specs) == 0 {
		t.Fatal("expected Start after follow-up")
	}
	last := specs[len(specs)-1]
	if last.Model != "claude-haiku-4-5" {
		t.Fatalf("Start model=%q want claude-haiku-4-5", last.Model)
	}
}

func TestBareHostMentionStillDirectTurn(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	e.putAdapter("claude-code", ad)

	opus := "claude-opus-4-8"
	task, err := e.Create(ctx, CreateRequest{
		Agent:  "claude-code",
		Cwd:    "/tmp",
		Prompt: "first",
		Model:  &opus,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)

	task, err = e.FollowUp(ctx, task.ID, "@claude-code continue without model switch")
	if err != nil {
		t.Fatal(err)
	}
	if plan, ok := e.shouldOrchestrate(task); ok {
		t.Fatalf("bare host mention must not orchestrate: %+v", plan)
	}
}
