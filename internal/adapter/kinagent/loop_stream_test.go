package kinagent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/provider"
)

func TestStreamContentDeltaEmitterThrottlesAndFlushes(t *testing.T) {
	ch := make(chan adapter.Event, 32)
	onDelta, flush := streamContentDeltaEmitter(ch, "kin")

	onDelta("Hel")
	// First delta should flush immediately (lastEmit zero).
	select {
	case ev := <-ch:
		var p map[string]any
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			t.Fatal(err)
		}
		if p["partial"] != true {
			t.Fatalf("want partial true, got %#v", p["partial"])
		}
		text := extractEventText(p)
		if text != "Hel" {
			t.Fatalf("text %q", text)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting first partial")
	}

	onDelta("lo")
	// Within throttle window — may not emit yet.
	select {
	case ev := <-ch:
		t.Fatalf("unexpected early emit: %s", string(ev.Payload))
	case <-time.After(10 * time.Millisecond):
	}

	flush()
	select {
	case ev := <-ch:
		var p map[string]any
		_ = json.Unmarshal(ev.Payload, &p)
		if extractEventText(p) != "lo" {
			t.Fatalf("flush text %q", extractEventText(p))
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting flush")
	}
}

func extractEventText(p map[string]any) string {
	if s, ok := p["text"].(string); ok {
		return s
	}
	raw, ok := p["content"].([]any)
	if !ok || len(raw) == 0 {
		return ""
	}
	m, _ := raw[0].(map[string]any)
	if m == nil {
		return ""
	}
	s, _ := m["text"].(string)
	return s
}

func TestEmitPartialThenFinalIsCoalescableShape(t *testing.T) {
	// Ensure payload shape matches UI expectations (role/content/partial).
	ch := make(chan adapter.Event, 2)
	emitPartialMsg(ch, "kin", "Hi")
	emitMsg(ch, "kin", "Hi there")
	close(ch)
	var parts []string
	for ev := range ch {
		var p map[string]any
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			t.Fatal(err)
		}
		parts = append(parts, extractEventText(p))
		if len(parts) == 1 && p["partial"] != true {
			t.Fatal("first should be partial")
		}
		if len(parts) == 2 && p["partial"] != false {
			t.Fatalf("final partial=%#v", p["partial"])
		}
	}
	if strings.Join(parts, "|") != "Hi|Hi there" {
		t.Fatalf("parts %v", parts)
	}
}

func TestRunAgentLoopEmitsReasoningAndMessagePhases(t *testing.T) {
	call := provider.ToolCall{ID: "call-1", Type: "function"}
	call.Function.Name = "list_dir"
	call.Function.Arguments = `{"path":"."}`
	client := &scriptedChatClient{
		resps: []*provider.ChatResponse{
			{
				Reasoning:    "Inspect the workspace.",
				Content:      "I will inspect the workspace.",
				FinishReason: "tool_calls",
				ToolCalls:    []provider.ToolCall{call},
			},
			{
				Reasoning:    "The workspace is empty.",
				Content:      "The workspace is empty.",
				FinishReason: "stop",
			},
		},
		reasoningDeltas: [][]string{
			{"Inspect ", "the workspace."},
			nil,
		},
		contentDeltas: [][]string{
			{"I will inspect the workspace."},
			nil,
		},
	}

	ch := make(chan adapter.Event, 64)
	done := make(chan struct{})
	go func() {
		runAgentLoop(
			context.Background(),
			client,
			"m",
			"system",
			"inspect",
			t.TempDir(),
			"task-1",
			nil,
			nil,
			ch,
			make(chan struct{}),
		)
		close(ch)
		close(done)
	}()

	events := collectLoopEvents(ch, 3*time.Second)
	<-done

	var messages []map[string]any
	for _, event := range events {
		if event.Type != "message" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		messages = append(messages, payload)
	}

	var sawReasoningPartial, sawReasoningFinal, sawProgress, sawSummary bool
	var partialRoles []string
	for _, message := range messages {
		role, _ := message["role"].(string)
		phase, _ := message["phase"].(string)
		partial, _ := message["partial"].(bool)
		text := extractEventText(message)
		if partial {
			partialRoles = append(partialRoles, role)
		}
		switch {
		case role == "reasoning" && phase == "progress" && partial:
			sawReasoningPartial = sawReasoningPartial || strings.Contains(text, "Inspect")
		case role == "reasoning" && phase == "progress" && !partial:
			sawReasoningFinal = sawReasoningFinal || text == "The workspace is empty."
		case role == "assistant" && phase == "progress" && !partial:
			sawProgress = sawProgress || text == "I will inspect the workspace."
		case role == "assistant" && phase == "summary" && !partial:
			sawSummary = sawSummary || text == "The workspace is empty."
		}
	}
	if !sawReasoningPartial || !sawReasoningFinal || !sawProgress || !sawSummary {
		t.Fatalf(
			"missing phased messages: reasoning_partial=%v reasoning_final=%v progress=%v summary=%v payloads=%#v",
			sawReasoningPartial,
			sawReasoningFinal,
			sawProgress,
			sawSummary,
			messages,
		)
	}
	if strings.Join(partialRoles, ",") != "reasoning,reasoning,assistant" {
		t.Fatalf("partial role order = %v", partialRoles)
	}
}

func TestRunAgentLoopDoesNotRetryAfterPublishedDelta(t *testing.T) {
	client := &scriptedChatClient{
		resps: []*provider.ChatResponse{
			nil,
			{Content: "duplicate attempt", FinishReason: "stop"},
		},
		errs: []error{
			errors.New("context length exceeded"),
			nil,
		},
		reasoningDeltas: [][]string{{"Inspecting the context."}},
	}
	ch := make(chan adapter.Event, 64)

	runAgentLoop(
		context.Background(),
		client,
		"m",
		"system",
		"inspect",
		t.TempDir(),
		"task-1",
		nil,
		nil,
		ch,
		make(chan struct{}),
	)
	close(ch)

	if got := len(client.reqs); got != 1 {
		t.Fatalf("provider calls = %d, want 1 after a published delta", got)
	}
}
