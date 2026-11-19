// Package claudecode implements the Claude Code CLI adapter (spec §4.1).
package claudecode

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/adapter"
)

// maxToolOutputBytes bounds the text a tool result carries into the console.
// The transcript keeps the raw stream; the card only needs the head of a long
// output, and an unbounded line would be stored and shipped on every read.
const maxToolOutputBytes = 64 * 1024

// ParseLine converts one stdout line of Claude Code stream-json into zero or
// more adapter events. Unparseable lines become raw_output; unknown JSON is
// ignored (never panics).
func ParseLine(line string) []adapter.Event {
	if line == "" {
		return nil
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return []adapter.Event{rawOutput(line)}
	}

	var typ string
	if err := json.Unmarshal(raw["type"], &typ); err != nil || typ == "" {
		// Valid JSON but no type — treat as raw for observability.
		return []adapter.Event{rawOutput(line)}
	}

	switch typ {
	case "system":
		return parseSystem(raw, line)
	case "assistant", "user":
		return parseMessage(typ, raw, line)
	case "stream_event":
		return parseStreamEvent(raw)
	case "result":
		return parseResult(raw, line)
	case "rate_limit_event":
		return parseRateLimitEvent(raw, line)
	default:
		// Unknown types: drop silently. Spec: never crash on unknown JSON.
		return nil
	}
}

func parseSystem(raw map[string]json.RawMessage, line string) []adapter.Event {
	var subtype string
	_ = json.Unmarshal(raw["subtype"], &subtype)
	if subtype != "init" {
		return nil
	}
	var sessionID string
	_ = json.Unmarshal(raw["session_id"], &sessionID)
	var model string
	_ = json.Unmarshal(raw["model"], &model)
	payload, _ := json.Marshal(map[string]any{
		"session_id": sessionID,
		"subtype":    "init",
		"model":      model,
	})
	return []adapter.Event{{Type: "task_started", Payload: payload}}
}

func parseMessage(role string, raw map[string]json.RawMessage, line string) []adapter.Event {
	// Prefer the nested message object when present.
	msgRaw := raw["message"]
	if len(msgRaw) == 0 {
		// Fall back to whole line as payload.
		return []adapter.Event{{
			Type:    "message",
			Payload: mustMarshal(map[string]any{"role": role, "raw": json.RawMessage(line), "partial": false}),
		}}
	}

	var msg struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(msgRaw, &msg); err != nil {
		return []adapter.Event{{
			Type:    "message",
			Payload: mustMarshal(map[string]any{"role": role, "partial": false, "message": msgRaw}),
		}}
	}
	if msg.Role == "" {
		msg.Role = role
	}

	// Split tool_use blocks into dedicated events for the UI.
	var blocks []map[string]json.RawMessage
	var events []adapter.Event
	if err := json.Unmarshal(msg.Content, &blocks); err == nil {
		var textBlocks []json.RawMessage
		for _, b := range blocks {
			var bt string
			_ = json.Unmarshal(b["type"], &bt)
			switch bt {
			case "tool_use":
				// Reconstruct block as object for payload.
				blockBytes, _ := json.Marshal(rawMapToAny(b))
				payload := map[string]any{
					"role":    msg.Role,
					"content": json.RawMessage(blockBytes),
				}
				// The console pairs a tool_use with its tool_result by a
				// top-level tool_use_id; without it the call is keyed by seq
				// and its result opens a second, duplicate step.
				if id := jsonString(b["id"]); id != "" {
					payload["tool_use_id"] = id
				}
				events = append(events, adapter.Event{
					Type:    "tool_use",
					Payload: mustMarshal(payload),
				})
			case "tool_result":
				// The result closes the step the matching tool_use opened, so
				// it must not also be drawn as user text. A block with no id
				// cannot be paired and keeps the generic message path.
				if ev, ok := toolResultEvent(b); ok {
					events = append(events, ev)
					continue
				}
				blockBytes, _ := json.Marshal(rawMapToAny(b))
				textBlocks = append(textBlocks, blockBytes)
			default:
				blockBytes, _ := json.Marshal(rawMapToAny(b))
				textBlocks = append(textBlocks, blockBytes)
			}
		}
		if len(textBlocks) > 0 {
			// Re-wrap as JSON array.
			arr, _ := json.Marshal(textBlocks)
			// textBlocks is []json.RawMessage which marshals as array of raw.
			// Actually marshaling []json.RawMessage double-encodes. Build manually.
			arr = joinRawArray(textBlocks)
			events = append(events, adapter.Event{
				Type: "message",
				Payload: mustMarshal(map[string]any{
					"role":    msg.Role,
					"content": json.RawMessage(arr),
					"partial": false,
				}),
			})
		}
		if len(events) > 0 {
			return events
		}
	}

	// Non-array content or empty: emit whole message.
	return []adapter.Event{{
		Type: "message",
		Payload: mustMarshal(map[string]any{
			"role":    msg.Role,
			"content": msg.Content,
			"partial": false,
		}),
	}}
}

// toolResultEvent maps a tool_result block to the event that closes its step.
// The shape matches the ACP adapter's tool_result: the id pairs it with its
// tool_use, ok says whether the tool failed (a missing is_error means
// success), and output is the text the tool produced. No role and no input:
// this is a state change, not a message.
func toolResultEvent(block map[string]json.RawMessage) (adapter.Event, bool) {
	var toolUseID string
	_ = json.Unmarshal(block["tool_use_id"], &toolUseID)
	if toolUseID == "" {
		return adapter.Event{}, false
	}
	var isError bool
	_ = json.Unmarshal(block["is_error"], &isError)
	return adapter.Event{
		Type: "tool_result",
		Payload: mustMarshal(map[string]any{
			"tool_use_id": toolUseID,
			"ok":          !isError,
			"output":      toolResultOutput(block["content"]),
		}),
	}, true
}

// toolResultOutput renders a result's content as text. Claude Code sends
// either a string or an array of content blocks; text blocks are joined with
// newlines, and blocks this console cannot draw are left out rather than
// JSON-dumped into the transcript.
func toolResultOutput(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return truncateToolOutput(text)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return truncateToolOutput(strings.Join(parts, "\n"))
}

// truncateToolOutput keeps a result within maxToolOutputBytes without cutting
// a UTF-8 sequence in half; the ellipsis marks that text was dropped.
func truncateToolOutput(value string) string {
	if len(value) <= maxToolOutputBytes {
		return value
	}
	cut := value[:maxToolOutputBytes]
	for len(cut) > 0 {
		r, size := utf8.DecodeLastRuneInString(cut)
		if r != utf8.RuneError || size > 1 {
			break
		}
		cut = cut[:len(cut)-1]
	}
	return cut + "…"
}

func parseStreamEvent(raw map[string]json.RawMessage) []adapter.Event {
	var ev struct {
		Type  string `json:"type"`
		Index int    `json:"index"`
		Delta *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
		ContentBlock *struct {
			Type string `json:"type"`
			Text string `json:"text"`
			Name string `json:"name"`
			ID   string `json:"id"`
		} `json:"content_block"`
	}
	if err := json.Unmarshal(raw["event"], &ev); err != nil {
		return nil
	}

	switch ev.Type {
	case "content_block_delta":
		if ev.Delta == nil || ev.Delta.Type != "text_delta" || ev.Delta.Text == "" {
			return nil
		}
		return []adapter.Event{{
			Type: "message",
			Payload: mustMarshal(map[string]any{
				"role":    "assistant",
				"content": []map[string]string{{"type": "text", "text": ev.Delta.Text}},
				"partial": true,
				"index":   ev.Index,
			}),
		}}
	default:
		return nil
	}
}

func parseResult(raw map[string]json.RawMessage, line string) []adapter.Event {
	// Normalize cost/tokens into a stable payload for the engine.
	var full map[string]any
	if err := json.Unmarshal([]byte(line), &full); err != nil {
		return []adapter.Event{rawOutput(line)}
	}

	out := map[string]any{
		"subtype":    full["subtype"],
		"result":     full["result"],
		"is_error":   full["is_error"],
		"session_id": full["session_id"],
	}
	if v, ok := full["total_cost_usd"]; ok {
		out["total_cost_usd"] = v
		out["cost_usd"] = v
	}
	var usageEvent *adapter.Event
	if u, ok := full["usage"].(map[string]any); ok {
		out["usage"] = u
		if v, ok := u["input_tokens"]; ok {
			out["tokens_in"] = v
		}
		if v, ok := u["output_tokens"]; ok {
			out["tokens_out"] = v
		}
		cacheRead, cacheReadReported := u["cache_read_input_tokens"]
		cacheWrite, cacheWriteReported := u["cache_creation_input_tokens"]
		usagePayload := map[string]any{
			"source":              "claude-code",
			"input_tokens":        u["input_tokens"],
			"output_tokens":       u["output_tokens"],
			"input_semantics":     "uncached_only",
			"cache_read_reported": cacheReadReported || cacheWriteReported,
			"usage":               u,
		}
		if cacheReadReported {
			usagePayload["cache_read_tokens"] = cacheRead
		}
		if cacheWriteReported {
			usagePayload["cache_write_tokens"] = cacheWrite
		}
		if v, ok := out["cost_usd"]; ok {
			usagePayload["cost_usd"] = v
			usagePayload["cost_source"] = "provider"
		}
		ev := adapter.Event{Type: "usage", Payload: mustMarshal(usagePayload)}
		usageEvent = &ev
	}
	// Pass through raw for debugging.
	out["raw"] = json.RawMessage(line)

	// If the result is an error that looks like a rate limit, stamp kind/reset_at.
	isErr := false
	switch v := out["is_error"].(type) {
	case bool:
		isErr = v
	}
	if isErr {
		msg, _ := out["result"].(string)
		if msg == "" {
			msg, _ = full["result"].(string)
		}
		if info, ok := adapter.DetectRateLimitMessage(msg); ok {
			out["kind"] = adapter.RateLimitKind
			out["message"] = info.Message
			if info.ResetAt > 0 {
				out["reset_at"] = info.ResetAt
			}
			out["provider"] = "claude"
		}
	}

	events := make([]adapter.Event, 0, 2)
	if usageEvent != nil {
		events = append(events, *usageEvent)
	}
	return append(events, adapter.Event{Type: "result", Payload: mustMarshal(out)})
}

func parseRateLimitEvent(raw map[string]json.RawMessage, line string) []adapter.Event {
	// Prefer structured rate_limit_info when present; fall back to free text.
	payloadIn := map[string]any{
		"type":     "rate_limit_event",
		"message":  jsonString(raw["message"]),
		"provider": "claude",
	}
	if len(raw["rate_limit_info"]) > 0 {
		var infoMap map[string]any
		if err := json.Unmarshal(raw["rate_limit_info"], &infoMap); err == nil {
			payloadIn["rate_limit_info"] = infoMap
			// Informational usage telemetry (status=allowed / allowed_warning):
			// drop it instead of raising a red error bubble mid-run.
			if s, _ := infoMap["status"].(string); !adapter.RateLimitStatusIsLimited(s) {
				return nil
			}
		}
	}
	info, ok := adapter.DetectRateLimitPayload(mustMarshal(payloadIn))
	if !ok {
		// Still surface something usable if the event is clearly a limit signal.
		info = adapter.RateLimitInfo{
			Kind:     adapter.RateLimitKind,
			Provider: "claude",
			Message:  "rate limited",
			Source:   "rate_limit_event",
		}
	}
	if info.Provider == "" {
		info.Provider = "claude"
	}
	if info.Source == "" {
		info.Source = "rate_limit_event"
	}
	payload := map[string]any{
		"kind":     adapter.RateLimitKind,
		"message":  info.Message,
		"provider": info.Provider,
		"source":   info.Source,
	}
	if info.ResetAt > 0 {
		payload["reset_at"] = info.ResetAt
	}
	if info.Window != "" {
		payload["window"] = info.Window
	}
	// Keep raw for diagnostics.
	payload["raw"] = json.RawMessage(line)
	return []adapter.Event{{
		Type:    "error",
		Payload: mustMarshal(payload),
	}}
}

func jsonString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return strings.Trim(string(raw), "\"")
}

func rawOutput(line string) adapter.Event {
	return adapter.Event{
		Type:    "raw_output",
		Payload: mustMarshal(map[string]string{"line": line}),
	}
}

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}

func rawMapToAny(m map[string]json.RawMessage) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		var val any
		if err := json.Unmarshal(v, &val); err != nil {
			out[k] = string(v)
		} else {
			out[k] = val
		}
	}
	return out
}

func joinRawArray(parts []json.RawMessage) []byte {
	if len(parts) == 0 {
		return []byte("[]")
	}
	buf := make([]byte, 0, 64)
	buf = append(buf, '[')
	for i, p := range parts {
		if i > 0 {
			buf = append(buf, ',')
		}
		buf = append(buf, p...)
	}
	buf = append(buf, ']')
	return buf
}

// ExtractUsage pulls cost/tokens from a result event payload for the engine.
func ExtractUsage(payload json.RawMessage) (cost *float64, tokensIn, tokensOut int, isError bool, ok bool) {
	var m struct {
		CostUSD   *float64 `json:"cost_usd"`
		TotalCost *float64 `json:"total_cost_usd"`
		TokensIn  *float64 `json:"tokens_in"`
		TokensOut *float64 `json:"tokens_out"`
		IsError   bool     `json:"is_error"`
		Usage     *struct {
			InputTokens  *float64 `json:"input_tokens"`
			OutputTokens *float64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(payload, &m); err != nil {
		return nil, 0, 0, false, false
	}
	if m.CostUSD != nil {
		cost = m.CostUSD
	} else if m.TotalCost != nil {
		cost = m.TotalCost
	}
	if m.TokensIn != nil {
		tokensIn = int(*m.TokensIn)
	} else if m.Usage != nil && m.Usage.InputTokens != nil {
		tokensIn = int(*m.Usage.InputTokens)
	}
	if m.TokensOut != nil {
		tokensOut = int(*m.TokensOut)
	} else if m.Usage != nil && m.Usage.OutputTokens != nil {
		tokensOut = int(*m.Usage.OutputTokens)
	}
	return cost, tokensIn, tokensOut, m.IsError, true
}

// ExtractSessionID pulls session_id from task_started or result payloads.
func ExtractSessionID(payload json.RawMessage) string {
	var m struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(payload, &m)
	return m.SessionID
}
