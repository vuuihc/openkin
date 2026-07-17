package kinagent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/sessionctx"
)

// runAgentLoop is Kin's native agent loop:
//
//	model (tools) → tool_calls → execute → append tool results → repeat
//	until finish_reason=stop (no tools), cancel, or error.
//
// Events are pushed to ch (message, tool_use, error, result).
func runAgentLoop(
	ctx context.Context,
	client provider.Client,
	model string,
	system string,
	userPrompt string,
	cwd string,
	ch chan<- adapter.Event,
	cancel <-chan struct{},
) {
	env, err := newToolEnv(cwd)
	if err != nil {
		emitErr(ch, fmt.Sprintf("workspace: %v", err))
		emitResult(ch, true, model, 0, 0)
		return
	}

	messages := []provider.Message{
		{Role: provider.RoleSystem, Content: system},
		{Role: provider.RoleUser, Content: userPrompt},
	}
	tools := agentTools()

	var totalIn, totalOut int
	lastModel := model
	turn := 0

	// softMsgChars is only used as a diagnostic / overflow-path target.
	// Routine mid-loop rewrite of older tools is forbidden (ADR 0002 Policy K).
	const softMsgChars = 100_000
	contextRetryUsed := false

	for {
		if aborted(ctx, cancel) {
			emitErr(ch, "canceled")
			emitResult(ch, true, lastModel, totalIn, totalOut)
			return
		}

		// No proactive prune: digests are final at append (Policy C + K).

		resp, err := client.Chat(ctx, provider.ChatRequest{
			Model:      model,
			Messages:   messages,
			Tools:      tools,
			ToolChoice: "auto",
		})
		if err != nil {
			// Some proxies reject tools; fall back to one-shot chat once.
			if turn == 0 && looksLikeToolsUnsupported(err) {
				emitMsg(ch, "kin", fmt.Sprintf(
					"_Provider rejected tool calling (%v). Falling back to chat-only for this turn._",
					err,
				))
				runChatOnly(ctx, client, model, system, userPrompt, ch, cancel)
				return
			}
			// Overflow safety net only (not the design center): prefer collapsing the
			// newest giant tool body first to preserve a longer cached prefix, then
			// fall back to older tools. Still mutates history — last resort only.
			if !contextRetryUsed && looksLikeContextOverflow(err) {
				contextRetryUsed = true
				messages = overflowCompactMessages(messages, softMsgChars/2)
				emitMsg(ch, "kin", "_Context limit approached; compacted tool results and retrying…_")
				continue
			}
			emitErr(ch, err.Error())
			emitResult(ch, true, lastModel, totalIn, totalOut)
			return
		}

		turn++
		lastModel = firstNonEmpty(resp.Model, model)
		totalIn += resp.Usage.PromptTokens
		totalOut += resp.Usage.CompletionTokens

		// Assistant text (may accompany tool calls).
		if strings.TrimSpace(resp.Content) != "" {
			emitMsg(ch, "kin", resp.Content)
		}

		if len(resp.ToolCalls) == 0 {
			// Done.
			if strings.TrimSpace(resp.Content) == "" {
				emitMsg(ch, "kin", "(agent finished with no message)")
			}
			emitResult(ch, false, lastModel, totalIn, totalOut)
			return
		}

		// Record assistant tool_calls turn.
		messages = append(messages, provider.Message{
			Role:      provider.RoleAssistant,
			Content:   resp.Content,
			ToolCalls: resp.ToolCalls,
		})

		// Execute each tool call.
		for _, tc := range resp.ToolCalls {
			if aborted(ctx, cancel) {
				emitErr(ch, "canceled")
				emitResult(ch, true, lastModel, totalIn, totalOut)
				return
			}
			name := tc.Function.Name
			args := tc.Function.Arguments
			// Optional "running" marker for UIs that care; chat collapses results.
			emitToolUse(ch, name, args, tc.ID)

			out, toolErr := env.runTool(ctx, name, args)
			resultText := out
			if toolErr != nil {
				if resultText != "" {
					resultText += "\n"
				}
				resultText += "ERROR: " + toolErr.Error()
			}
			if resultText == "" {
				resultText = "(empty)"
			}

			// Structured tool_result for collapsible chat UI (full-ish output for humans).
			// Model path gets a compact-on-entry digest (ADR 0002 Policy C) — UI ≠ model.
			emitToolResult(ch, name, args, resultText, toolErr == nil, tc.ID)

			digest := sessionctx.ToolDigest(name, args, resultText, toolErr == nil)
			messages = append(messages, provider.Message{
				Role:       provider.RoleTool,
				Content:    digest,
				ToolCallID: tc.ID,
				Name:       name,
			})
		}
	}
}

func runChatOnly(
	ctx context.Context,
	client provider.Client,
	model, system, userPrompt string,
	ch chan<- adapter.Event,
	cancel <-chan struct{},
) {
	if aborted(ctx, cancel) {
		emitErr(ch, "canceled")
		emitResult(ch, true, model, 0, 0)
		return
	}
	resp, err := client.Chat(ctx, provider.ChatRequest{
		Model: model,
		Messages: []provider.Message{
			{Role: provider.RoleSystem, Content: system},
			{Role: provider.RoleUser, Content: userPrompt},
		},
	})
	if err != nil {
		emitErr(ch, err.Error())
		emitResult(ch, true, model, 0, 0)
		return
	}
	if strings.TrimSpace(resp.Content) != "" {
		emitMsg(ch, "kin", resp.Content)
	}
	emitResult(ch, false, firstNonEmpty(resp.Model, model), resp.Usage.PromptTokens, resp.Usage.CompletionTokens)
}

func looksLikeToolsUnsupported(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "tool") &&
		(strings.Contains(s, "not support") ||
			strings.Contains(s, "unsupported") ||
			strings.Contains(s, "unknown") ||
			strings.Contains(s, "invalid") ||
			strings.Contains(s, "400"))
}

func aborted(ctx context.Context, cancel <-chan struct{}) bool {
	select {
	case <-ctx.Done():
		return true
	case <-cancel:
		return true
	default:
		return false
	}
}

func emitMsg(ch chan<- adapter.Event, agent, text string) {
	payload, _ := json.Marshal(map[string]any{
		"role":    "assistant",
		"content": []map[string]string{{"type": "text", "text": text}},
		"partial": false,
		"agent":   agent,
		"speaker": agent,
		"source":  "kin",
	})
	ch <- adapter.Event{Type: "message", Payload: payload}
}

func emitToolUse(ch chan<- adapter.Event, name, argsJSON, callID string) {
	var input any
	if err := json.Unmarshal([]byte(argsJSON), &input); err != nil {
		input = map[string]string{"raw": argsJSON}
	}
	payload, _ := json.Marshal(map[string]any{
		"name":        name,
		"tool_name":   name,
		"input":       input,
		"tool_use_id": callID,
		"status":      "running",
		"summary":     toolRunningSummary(name, argsJSON),
		"agent":       "kin",
		"speaker":     "kin",
		"source":      "kin",
		"visibility":  map[string]bool{"user": true, "task": true},
	})
	ch <- adapter.Event{Type: "tool_use", Payload: payload}
}

func emitToolResult(ch chan<- adapter.Event, name, argsJSON, output string, ok bool, callID string) {
	var input any
	if err := json.Unmarshal([]byte(argsJSON), &input); err != nil {
		input = map[string]string{"raw": argsJSON}
	}
	// Cap stored output so the event log stays small. Model path uses ToolDigest separately.
	stored := output
	if len(stored) > 8000 {
		stored = stored[:8000] + "\n… truncated for UI"
	}
	summary := toolResultSummary(name, argsJSON, output, ok)
	payload, _ := json.Marshal(map[string]any{
		"name":        name,
		"tool_name":   name,
		"input":       input,
		"output":      stored,
		"ok":          ok,
		"status":      map[bool]string{true: "done", false: "error"}[ok],
		"summary":     summary,
		"tool_use_id": callID,
		"agent":       "kin",
		"speaker":     "kin",
		"source":      "kin",
		"visibility":  map[string]bool{"user": true, "task": true},
	})
	ch <- adapter.Event{Type: "tool_result", Payload: payload}
}

func toolRunningSummary(name, argsJSON string) string {
	switch name {
	case "bash":
		cmd := jsonStringField(argsJSON, "command")
		if cmd != "" {
			return "Running · " + truncateRunes(oneLine(cmd), 72)
		}
		return "Running command…"
	case "read_file":
		return "Reading · " + truncateRunes(jsonStringField(argsJSON, "path"), 64)
	case "write_file":
		return "Writing · " + truncateRunes(jsonStringField(argsJSON, "path"), 64)
	case "list_dir":
		p := jsonStringField(argsJSON, "path")
		if p == "" {
			p = "."
		}
		return "Listing · " + truncateRunes(p, 64)
	case "glob":
		return "Searching · " + truncateRunes(jsonStringField(argsJSON, "pattern"), 64)
	default:
		return "Running · " + name
	}
}

func toolResultSummary(name, argsJSON, output string, ok bool) string {
	status := "Done"
	if !ok {
		status = "Failed"
	}
	lines := countLines(output)
	switch name {
	case "bash":
		cmd := jsonStringField(argsJSON, "command")
		head := truncateRunes(oneLine(cmd), 56)
		if head == "" {
			head = "command"
		}
		return fmt.Sprintf("%s · %s · %d lines", status, head, lines)
	case "read_file":
		p := jsonStringField(argsJSON, "path")
		return fmt.Sprintf("%s · read %s · %d lines", status, truncateRunes(p, 48), lines)
	case "write_file":
		p := jsonStringField(argsJSON, "path")
		return fmt.Sprintf("%s · wrote %s", status, truncateRunes(p, 56))
	case "list_dir":
		p := jsonStringField(argsJSON, "path")
		if p == "" {
			p = "."
		}
		return fmt.Sprintf("%s · listed %s · %d entries", status, truncateRunes(p, 40), lines)
	case "glob":
		pat := jsonStringField(argsJSON, "pattern")
		return fmt.Sprintf("%s · %s · %d matches", status, truncateRunes(pat, 40), lines)
	default:
		return fmt.Sprintf("%s · %s · %d lines", status, name, lines)
	}
}

func jsonStringField(argsJSON, key string) string {
	var m map[string]any
	if err := json.Unmarshal([]byte(argsJSON), &m); err != nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func oneLine(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.Join(strings.Fields(s), " ")
	return s
}

func countLines(s string) int {
	s = strings.TrimRight(s, "\n")
	if s == "" || s == "(empty)" || s == "(no output)" || s == "(no matches)" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func emitErr(ch chan<- adapter.Event, msg string) {
	payload, _ := json.Marshal(map[string]string{"message": msg})
	ch <- adapter.Event{Type: "error", Payload: payload}
}

func emitResult(ch chan<- adapter.Event, isErr bool, model string, tin, tout int) {
	payload, _ := json.Marshal(map[string]any{
		"source":     "kin",
		"is_error":   isErr,
		"model":      model,
		"tokens_in":  tin,
		"tokens_out": tout,
		"session_id": "kin-loop",
	})
	ch <- adapter.Event{Type: "result", Payload: payload}
}


func looksLikeContextOverflow(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	keys := []string{
		"context length",
		"context_length",
		"maximum context",
		"max context",
		"token limit",
		"too many tokens",
		"context window",
		"prompt is too long",
		"maximum number of tokens",
		"exceeds the model",
		"context_length_exceeded",
	}
	for _, k := range keys {
		if strings.Contains(s, k) {
			return true
		}
	}
	// OpenAI-style 400 with "length" + "token"
	return strings.Contains(s, "400") && strings.Contains(s, "token") &&
		(strings.Contains(s, "length") || strings.Contains(s, "limit"))
}

func estimateMessagesChars(msgs []provider.Message) int {
	n := 0
	for _, m := range msgs {
		n += sessionctx.EstimateChars(m.Content)
		for _, tc := range m.ToolCalls {
			n += sessionctx.EstimateChars(tc.Function.Name, tc.Function.Arguments)
		}
	}
	return n
}

// overflowCompactMessages is the last-resort path when the provider rejects the
// prompt for context length. Prefer collapsing the *newest* oversized tool body
// first (Policy K tradeoff: preserves a longer cached prefix of older messages),
// then fall back to collapsing older tools. Routine mid-loop rewrite is gone.
func overflowCompactMessages(msgs []provider.Message, targetChars int) []provider.Message {
	if len(msgs) <= 2 {
		return msgs
	}
	out := make([]provider.Message, len(msgs))
	copy(out, msgs)

	toolIdx := make([]int, 0, len(out))
	for i, m := range out {
		if m.Role == provider.RoleTool {
			toolIdx = append(toolIdx, i)
		}
	}
	if len(toolIdx) == 0 {
		return out
	}

	// 1) Collapse the largest recent tool result(s) first.
	// Walk newest → oldest so we touch the suffix before rewriting the prefix.
	for i := len(toolIdx) - 1; i >= 0; i-- {
		idx := toolIdx[i]
		if len(out[idx].Content) <= 240 {
			continue
		}
		out[idx].Content = sessionctx.CollapseToolPayload(out[idx].Name, out[idx].Content, 200)
		if estimateMessagesChars(out) <= targetChars {
			return out
		}
	}
	// 2) Aggressive collapse of every tool payload.
	for _, idx := range toolIdx {
		if len(out[idx].Content) > 120 {
			out[idx].Content = sessionctx.CollapseToolPayload(out[idx].Name, out[idx].Content, 120)
		}
	}
	return out
}

// pruneLoopMessages is retained as a thin alias for tests / callers that still
// name the old safety-net helper. Prefer overflowCompactMessages in new code.
func pruneLoopMessages(msgs []provider.Message, targetChars int) []provider.Message {
	return overflowCompactMessages(msgs, targetChars)
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}
