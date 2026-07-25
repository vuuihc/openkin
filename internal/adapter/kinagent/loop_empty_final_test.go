package kinagent

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/provider"
)

// scriptedChatClient returns canned ChatResponse values in order.
type scriptedChatClient struct {
	mu    sync.Mutex
	resps []*provider.ChatResponse
	errs  []error
	reqs  []provider.ChatRequest
}

func (s *scriptedChatClient) Chat(ctx context.Context, req provider.ChatRequest) (*provider.ChatResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reqs = append(s.reqs, req)
	idx := len(s.reqs) - 1
	var err error
	if idx < len(s.errs) {
		err = s.errs[idx]
	}
	if err != nil {
		return nil, err
	}
	if idx >= len(s.resps) {
		return &provider.ChatResponse{Content: "", FinishReason: "stop"}, nil
	}
	return s.resps[idx], nil
}

func (s *scriptedChatClient) Kind() string         { return "scripted" }
func (s *scriptedChatClient) ModelDefault() string { return "scripted" }

func collectLoopEvents(ch <-chan adapter.Event, timeout time.Duration) []adapter.Event {
	var out []adapter.Event
	deadline := time.After(timeout)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return out
			}
			out = append(out, ev)
			if ev.Type == "result" || ev.Type == "error" {
				drain := time.After(20 * time.Millisecond)
				for {
					select {
					case ev2, ok2 := <-ch:
						if !ok2 {
							return out
						}
						out = append(out, ev2)
					case <-drain:
						return out
					}
				}
			}
		case <-deadline:
			return out
		}
	}
}

func messageTexts(events []adapter.Event) []string {
	var texts []string
	for _, ev := range events {
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(ev.Payload, &m); err != nil {
			continue
		}
		if partial, _ := m["partial"].(bool); partial {
			continue
		}
		raw, _ := json.Marshal(m["content"])
		var parts []map[string]string
		_ = json.Unmarshal(raw, &parts)
		var b strings.Builder
		for _, p := range parts {
			if p["type"] == "text" {
				b.WriteString(p["text"])
			}
		}
		if s := b.String(); s != "" {
			texts = append(texts, s)
		}
	}
	return texts
}

func TestRunAgentLoopEmptyAfterToolsContinues(t *testing.T) {
	cwd := t.TempDir()
	tc := provider.ToolCall{ID: "call_1", Type: "function"}
	tc.Function.Name = "list_dir"
	tc.Function.Arguments = `{"path":"."}`

	// Second empty stop after tools should inject continue; third can answer.
	finalAnswer := "Directory is empty; nothing to note."
	client := &scriptedChatClient{
		resps: []*provider.ChatResponse{
			{
				Content:      "",
				FinishReason: "tool_calls",
				ToolCalls:    []provider.ToolCall{tc},
				Usage:        provider.Usage{PromptTokens: 10, CompletionTokens: 5},
			},
			{
				Content:      "",
				FinishReason: "stop",
				Usage:        provider.Usage{PromptTokens: 20, CompletionTokens: 1},
			},
			{
				Content:      finalAnswer,
				FinishReason: "stop",
				Usage:        provider.Usage{PromptTokens: 25, CompletionTokens: 12},
			},
		},
	}

	ch := make(chan adapter.Event, 64)
	cancel := make(chan struct{})
	done := make(chan []provider.Message, 1)
	go func() {
		msgs := runAgentLoop(context.Background(), client, "m", "sys", "list files", cwd, "task1", nil, nil, ch, cancel)
		done <- msgs
		close(ch)
	}()

	events := collectLoopEvents(ch, 3*time.Second)
	finalMsgs := <-done

	texts := messageTexts(events)
	joined := strings.Join(texts, "\n")
	if strings.Contains(joined, "(agent finished with no message)") {
		t.Fatalf("placeholder should not appear on recovered path; messages=%v", texts)
	}
	found := false
	for _, ttxt := range texts {
		if strings.Contains(ttxt, finalAnswer) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected recovered final answer, got messages=%v", texts)
	}

	client.mu.Lock()
	nreq := len(client.reqs)
	var last provider.ChatRequest
	if nreq > 0 {
		last = client.reqs[nreq-1]
	}
	client.mu.Unlock()
	if nreq != 3 {
		t.Fatalf("expected 3 Chat calls (tool + empty stop + continue), got %d", nreq)
	}
	// Continue keeps tools available (auto), not force text-only.
	if last.ToolChoice != "auto" {
		t.Fatalf("continue ToolChoice=%q want auto", last.ToolChoice)
	}
	var sawContinue bool
	for _, m := range finalMsgs {
		if m.Role == provider.RoleUser && strings.Contains(strings.ToLower(m.Content), "continue") {
			sawContinue = true
		}
	}
	if !sawContinue {
		t.Fatalf("expected continue user prompt in persisted messages: %+v", finalMsgs)
	}
	lastMsg := finalMsgs[len(finalMsgs)-1]
	if lastMsg.Role != provider.RoleAssistant || !strings.Contains(lastMsg.Content, finalAnswer) {
		t.Fatalf("final durable assistant msg = %+v", lastMsg)
	}
}

func TestRunAgentLoopEmptyAfterToolsContinueCanCallMoreTools(t *testing.T) {
	cwd := t.TempDir()
	tc1 := provider.ToolCall{ID: "call_1", Type: "function"}
	tc1.Function.Name = "list_dir"
	tc1.Function.Arguments = `{"path":"."}`
	tc2 := provider.ToolCall{ID: "call_2", Type: "function"}
	tc2.Function.Name = "list_dir"
	tc2.Function.Arguments = `{"path":"."}`

	client := &scriptedChatClient{
		resps: []*provider.ChatResponse{
			{
				Content:      "",
				FinishReason: "tool_calls",
				ToolCalls:    []provider.ToolCall{tc1},
			},
			// Empty stop — continue nudge once.
			{Content: "", FinishReason: "stop"},
			// After continue, model decides more tools are needed.
			{
				Content:      "",
				FinishReason: "tool_calls",
				ToolCalls:    []provider.ToolCall{tc2},
			},
			{Content: "Still empty after re-check.", FinishReason: "stop"},
		},
	}

	ch := make(chan adapter.Event, 64)
	cancel := make(chan struct{})
	done := make(chan []provider.Message, 1)
	go func() {
		msgs := runAgentLoop(context.Background(), client, "m", "sys", "list", cwd, "t", nil, nil, ch, cancel)
		done <- msgs
		close(ch)
	}()
	events := collectLoopEvents(ch, 3*time.Second)
	finalMsgs := <-done

	texts := messageTexts(events)
	joined := strings.Join(texts, "\n")
	if strings.Contains(joined, "(agent finished with no message)") {
		t.Fatalf("unexpected placeholder: %v", texts)
	}
	if !strings.Contains(joined, "Still empty after re-check.") {
		t.Fatalf("expected post-continue tool path answer; texts=%v", texts)
	}
	client.mu.Lock()
	nreq := len(client.reqs)
	client.mu.Unlock()
	if nreq != 4 {
		t.Fatalf("expected 4 Chat calls, got %d", nreq)
	}
	// empty continue is only once: second empty stop after more tools should NOT re-nudge forever.
	// Here we never hit a second empty after the second tool path because final has content.
	_ = finalMsgs
}

func TestRunAgentLoopEmptyFinalWithoutToolsNoRetry(t *testing.T) {
	cwd := t.TempDir()
	client := &scriptedChatClient{
		resps: []*provider.ChatResponse{
			{
				Content:      "",
				FinishReason: "stop",
				Usage:        provider.Usage{PromptTokens: 3, CompletionTokens: 0},
			},
		},
	}
	ch := make(chan adapter.Event, 16)
	cancel := make(chan struct{})
	done := make(chan struct{})
	go func() {
		_ = runAgentLoop(context.Background(), client, "m", "sys", "hi", cwd, "task1", nil, nil, ch, cancel)
		close(ch)
		close(done)
	}()
	events := collectLoopEvents(ch, 2*time.Second)
	<-done

	texts := messageTexts(events)
	if len(texts) == 0 || texts[len(texts)-1] != "(agent finished with no message)" {
		t.Fatalf("expected placeholder when no tools used; texts=%v", texts)
	}
	client.mu.Lock()
	nreq := len(client.reqs)
	client.mu.Unlock()
	if nreq != 1 {
		t.Fatalf("should not continue when tools were never used; Chat calls=%d", nreq)
	}
}

func TestRunAgentLoopEmptyContinueExhausted(t *testing.T) {
	cwd := t.TempDir()
	tc := provider.ToolCall{ID: "call_1", Type: "function"}
	tc.Function.Name = "list_dir"
	tc.Function.Arguments = `{"path":"."}`

	client := &scriptedChatClient{
		resps: []*provider.ChatResponse{
			{
				Content:      "",
				FinishReason: "tool_calls",
				ToolCalls:    []provider.ToolCall{tc},
			},
			{Content: "", FinishReason: "stop"},
			{Content: "", FinishReason: "stop"}, // continue still empty
		},
	}
	ch := make(chan adapter.Event, 32)
	cancel := make(chan struct{})
	done := make(chan struct{})
	go func() {
		_ = runAgentLoop(context.Background(), client, "m", "sys", "list", cwd, "t", nil, nil, ch, cancel)
		close(ch)
		close(done)
	}()
	events := collectLoopEvents(ch, 3*time.Second)
	<-done

	texts := messageTexts(events)
	joined := strings.Join(texts, "\n")
	if !strings.Contains(joined, "(agent finished with no message)") {
		t.Fatalf("placeholder should remain as last-resort; texts=%v", texts)
	}
	client.mu.Lock()
	nreq := len(client.reqs)
	client.mu.Unlock()
	if nreq != 3 {
		t.Fatalf("expected exactly one empty-continue (3 Chat calls), got %d", nreq)
	}
}
