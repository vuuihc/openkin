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
	e.adapters["codex"] = defaultAdapter
	e.adapters["kin"] = kinAdapter
	e.adapters["claude-code"] = workerAdapter
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
	e.adapters["codex"] = codexAdapter
	e.adapters["kin"] = kinAdapter
	e.adapters["claude-code"] = workerAdapter
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
	e.adapters["codex"] = codexAdapter
	e.adapters["kin"] = kinAdapter
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
	e.adapters["codex"] = codexAdapter
	e.adapters["kin"] = kinAdapter
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
	e.adapters["codex"] = codexAdapter
	e.adapters["kin"] = kinAdapter
	e.adapters["claude-code"] = workerAdapter
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
