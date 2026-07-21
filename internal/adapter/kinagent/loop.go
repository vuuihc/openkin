package kinagent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

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
// prior is an optional durable transcript (system stripped); when non-empty the
// live userPrompt is appended as a new user turn (ADR 0002 P1.5 / Policy K).
// Returns the final messages array (including system) for persistence.
func runAgentLoop(
	ctx context.Context,
	client provider.Client,
	model string,
	system string,
	userPrompt string,
	cwd string,
	taskID string,
	searcher SessionSearcher,
	prior []provider.Message,
	ch chan<- adapter.Event,
	cancel <-chan struct{},
) []provider.Message {
	env, err := newToolEnv(cwd)
	if err != nil {
		emitErr(ch, fmt.Sprintf("workspace: %v", err))
		emitResult(ch, true, model, 0, 0, 0)
		return nil
	}
	env.TaskID = taskID
	env.Search = searcher

	messages := buildInitialMessages(system, userPrompt, prior)
	tools := agentTools(searcher != nil)

	var totalIn, totalOut, totalCached int
	lastModel := model
	turn := 0

	// softMsgChars is only used as a diagnostic / overflow-path target.
	// Routine mid-loop rewrite of older tools is forbidden (ADR 0002 Policy K).
	const softMsgChars = 100_000
	contextRetryUsed := false

	for {
		if aborted(ctx, cancel) {
			emitErr(ch, "canceled")
			emitResult(ch, true, lastModel, totalIn, totalOut, totalCached)
			return messages
		}

		// No proactive prune: digests are final at append (Policy C + K).

		promptChars := estimateMessagesChars(messages)
		chatCtx := withProviderRetryHints(ctx, ch)
		onDelta, flushDelta := streamContentDeltaEmitter(ch, "kin")
		resp, err := client.Chat(chatCtx, provider.ChatRequest{
			Model:          model,
			Messages:       messages,
			Tools:          tools,
			ToolChoice:     "auto",
			OnContentDelta: onDelta,
		})
		flushDelta()
		if err != nil {
			// Some proxies reject tools; fall back to one-shot chat once.
			if turn == 0 && looksLikeToolsUnsupported(err) {
				emitMsg(ch, "kin", fmt.Sprintf(
					"_Provider rejected tool calling (%v). Falling back to chat-only for this turn._",
					err,
				))
				runChatOnly(ctx, client, model, system, userPrompt, ch, cancel)
				return messages
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
			emitResult(ch, true, lastModel, totalIn, totalOut, totalCached)
			return messages
		}

		turn++
		lastModel = firstNonEmpty(resp.Model, model)
		totalIn += resp.Usage.PromptTokens
		totalOut += resp.Usage.CompletionTokens
		totalCached += resp.Usage.CachedTokens

		// P1b metrics (debug): prompt size + optional provider cache hits.
		log.Printf("kinagent: turn=%d prompt_chars=%d prompt_tokens=%d cached_tokens=%d completion_tokens=%d",
			turn, promptChars, resp.Usage.PromptTokens, resp.Usage.CachedTokens, resp.Usage.CompletionTokens)
		emitUsage(ch, lastModel, promptChars, resp.Usage)

		// Assistant text (may accompany tool calls).
		if strings.TrimSpace(resp.Content) != "" {
			emitMsg(ch, "kin", resp.Content)
		}

		if len(resp.ToolCalls) == 0 {
			// Done.
			if strings.TrimSpace(resp.Content) == "" {
				emitMsg(ch, "kin", "(agent finished with no message)")
			}
			// Append final assistant text so follow-ups see it in the durable prefix.
			if strings.TrimSpace(resp.Content) != "" || len(resp.ToolCalls) == 0 {
				messages = append(messages, provider.Message{
					Role:    provider.RoleAssistant,
					Content: resp.Content,
				})
			}
			emitResult(ch, false, lastModel, totalIn, totalOut, totalCached)
			return messages
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
				emitResult(ch, true, lastModel, totalIn, totalOut, totalCached)
				return messages
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

// buildInitialMessages freezes the system prompt and either resumes a durable
// transcript (append live user turn) or cold-starts from a single user blob.
func buildInitialMessages(system, userPrompt string, prior []provider.Message) []provider.Message {
	// Always re-bind system so tool policy stays current; body of prior system is dropped.
	out := make([]provider.Message, 0, len(prior)+2)
	out = append(out, provider.Message{Role: provider.RoleSystem, Content: system})
	if len(prior) == 0 {
		out = append(out, provider.Message{Role: provider.RoleUser, Content: userPrompt})
		return out
	}
	for _, m := range prior {
		if m.Role == provider.RoleSystem {
			continue
		}
		out = append(out, m)
	}
	// Append the live user turn only — do not rebuild the whole history blob.
	if strings.TrimSpace(userPrompt) != "" {
		out = append(out, provider.Message{Role: provider.RoleUser, Content: userPrompt})
	}
	return out
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
		emitResult(ch, true, model, 0, 0, 0)
		return
	}
	msgs := []provider.Message{
		{Role: provider.RoleSystem, Content: system},
		{Role: provider.RoleUser, Content: userPrompt},
	}
	promptChars := estimateMessagesChars(msgs)
	chatCtx := withProviderRetryHints(ctx, ch)
	onDelta, flushDelta := streamContentDeltaEmitter(ch, "kin")
	resp, err := client.Chat(chatCtx, provider.ChatRequest{
		Model:          model,
		Messages:       msgs,
		OnContentDelta: onDelta,
	})
	flushDelta()
	if err != nil {
		emitErr(ch, err.Error())
		emitResult(ch, true, model, 0, 0, 0)
		return
	}
	log.Printf("kinagent: chat-only prompt_chars=%d prompt_tokens=%d cached_tokens=%d",
		promptChars, resp.Usage.PromptTokens, resp.Usage.CachedTokens)
	emitUsage(ch, firstNonEmpty(resp.Model, model), promptChars, resp.Usage)
	if strings.TrimSpace(resp.Content) != "" {
		emitMsg(ch, "kin", resp.Content)
	}
	emitResult(ch, false, firstNonEmpty(resp.Model, model), resp.Usage.PromptTokens, resp.Usage.CompletionTokens, resp.Usage.CachedTokens)
}

// withProviderRetryHints surfaces transient provider reconnect attempts in the chat UI.
func withProviderRetryHints(ctx context.Context, ch chan<- adapter.Event) context.Context {
	return provider.WithRetryNotify(ctx, func(attempt, max int, wait time.Duration, err error) {
		reason := "temporary error"
		if err != nil {
			reason = summarizeProviderRetryReason(err)
		}
		emitMsg(ch, "kin", fmt.Sprintf(
			"_Provider %s — reconnecting %d/%d in %s…_",
			reason, attempt, max, wait.Round(time.Millisecond),
		))
	})
}

func summarizeProviderRetryReason(err error) string {
	s := strings.ToLower(err.Error())
	switch {
	case strings.Contains(s, "http 524"):
		return "gateway timeout (HTTP 524)"
	case strings.Contains(s, "http 504"):
		return "gateway timeout (HTTP 504)"
	case strings.Contains(s, "http 503"):
		return "service unavailable (HTTP 503)"
	case strings.Contains(s, "http 502"):
		return "bad gateway (HTTP 502)"
	case strings.Contains(s, "http 429"):
		return "rate limited (HTTP 429)"
	case strings.Contains(s, "http 500"):
		return "upstream error (HTTP 500)"
	case strings.Contains(s, "timeout"):
		return "timeout"
	case strings.Contains(s, "connection reset"):
		return "connection reset"
	case strings.Contains(s, "connection refused"):
		return "connection refused"
	default:
		// Keep short for chat noise control.
		msg := err.Error()
		if len(msg) > 120 {
			msg = truncateUTF8(msg, 120, "…")
		}
		return msg
	}
}

func looksLikeToolsUnsupported(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	// Transport / gateway / parse failures are not "tools unsupported".
	// Also: provider URLs like aipool.aitoolbox.fyi contain the substring "tool",
	// so never match on bare "tool" + "invalid" (JSON decode errors).
	for _, k := range []string{
		"http 5", // 5xx incl. Cloudflare 52x
		"timeout", "timed out", "deadline exceeded",
		"connection reset", "connection refused", "no such host",
		"decode ", "looking for beginning of value",
		"tls:", "x509:", "i/o timeout",
		"failed after", "reconnecting", "gateway timeout",
		"bad gateway", "service unavailable", "rate limited",
		"tool argument", // "invalid tool arguments" is a format error, not "tools unsupported"
	} {
		if strings.Contains(s, k) {
			return false
		}
	}
	// Prefer explicit phrases over loose substring pairs.
	phrases := []string{
		"tools are not supported",
		"tool use is not supported",
		"tool calling is not supported",
		"tool_calls is not supported",
		"does not support tools",
		"does not support tool",
		"does not support function",
		"unsupported tool",
		"unknown tool",
		"invalid tools",
		"invalid tool",
		"tools parameter is not supported",
		"tool_choice is not supported",
		"function calling is not supported",
		"functions are not supported",
		"unknown field \"tools\"",
		"unknown field 'tools'",
		"unexpected field \"tools\"",
		"unexpected argument \"tools\"",
	}
	for _, p := range phrases {
		if strings.Contains(s, p) {
			return true
		}
	}
	// 400 + tools/function wording + clear rejection.
	// Exclude "tool arguments" format errors (e.g. "Invalid tool arguments received:
	// trailing characters") — those mean the provider accepts tools but the
	// arguments JSON was malformed, not that tools are unsupported.
	if strings.Contains(s, "400") &&
		(strings.Contains(s, "tools") || strings.Contains(s, "tool_choice") || strings.Contains(s, "function")) &&
		(strings.Contains(s, "not support") || strings.Contains(s, "unsupported") ||
			strings.Contains(s, "unknown") || strings.Contains(s, "unexpected") ||
			strings.Contains(s, "invalid")) &&
		!strings.Contains(s, "tool argument") {
		return true
	}
	return false
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

// emitPartialMsg pushes a text *delta* (append) for live UI streaming.
// Matches Claude Code partial message convention used by transcriptProjection.
func emitPartialMsg(ch chan<- adapter.Event, agent, delta string) {
	if delta == "" {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"role":    "assistant",
		"content": []map[string]string{{"type": "text", "text": delta}},
		"partial": true,
		"agent":   agent,
		"speaker": agent,
		"source":  "kin",
	})
	ch <- adapter.Event{Type: "message", Payload: payload}
}

// streamContentDeltaEmitter throttles partial message events so high-frequency
// token streams do not flood the event log / websocket. Returns (onDelta, flush).
// flush must be called after Chat returns (success or error) to emit any remainder.
func streamContentDeltaEmitter(ch chan<- adapter.Event, agent string) (onDelta func(string), flush func()) {
	const minInterval = 80 * time.Millisecond
	var (
		buf      strings.Builder
		lastEmit time.Time
	)
	flush = func() {
		if buf.Len() == 0 {
			return
		}
		emitPartialMsg(ch, agent, buf.String())
		buf.Reset()
		lastEmit = time.Now()
	}
	onDelta = func(delta string) {
		if delta == "" {
			return
		}
		buf.WriteString(delta)
		if lastEmit.IsZero() || time.Since(lastEmit) >= minInterval {
			flush()
		}
	}
	return onDelta, flush
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
	// Byte-budget cut must stay on a UTF-8 boundary (see truncateUTF8).
	stored := output
	if len(stored) > 8000 {
		stored = truncateUTF8(stored, 8000, "\n… truncated for UI")
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

func emitUsage(ch chan<- adapter.Event, model string, promptChars int, u provider.Usage) {
	payload := map[string]any{
		"prompt_chars":        promptChars,
		"prompt_tokens":       u.PromptTokens,
		"completion_tokens":   u.CompletionTokens,
		"cached_tokens":       u.CachedTokens,
		"cache_read_reported": u.CacheReadReported,
		"total_tokens":        u.TotalTokens,
		"source":              "kin",
	}
	if m := strings.TrimSpace(model); m != "" {
		payload["model"] = m
	}
	raw, _ := json.Marshal(payload)
	ch <- adapter.Event{Type: "usage", Payload: raw}
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

func emitResult(ch chan<- adapter.Event, isErr bool, model string, tin, tout, cached int) {
	payload, _ := json.Marshal(map[string]any{
		"source":        "kin",
		"is_error":      isErr,
		"model":         model,
		"tokens_in":     tin,
		"tokens_out":    tout,
		"cached_tokens": cached,
		"session_id":    "kin-loop",
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
