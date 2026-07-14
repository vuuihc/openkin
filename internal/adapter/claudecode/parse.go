// Package claudecode implements the Claude Code CLI adapter (spec §4.1).
package claudecode

import (
	"encoding/json"

	"github.com/vuuihc/kin/internal/adapter"
)

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
	default:
		// Known-unknown types (rate_limit_event, etc.): drop silently.
		// Spec: never crash on unknown JSON.
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
	payload, _ := json.Marshal(map[string]any{
		"session_id": sessionID,
		"subtype":    "init",
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
			if bt == "tool_use" {
				// Reconstruct block as object for payload.
				blockBytes, _ := json.Marshal(rawMapToAny(b))
				events = append(events, adapter.Event{
					Type: "tool_use",
					Payload: mustMarshal(map[string]any{
						"role":    msg.Role,
						"content": json.RawMessage(blockBytes),
					}),
				})
			} else {
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
		"subtype": full["subtype"],
		"result":  full["result"],
		"is_error": full["is_error"],
		"session_id": full["session_id"],
	}
	if v, ok := full["total_cost_usd"]; ok {
		out["total_cost_usd"] = v
		out["cost_usd"] = v
	}
	if u, ok := full["usage"].(map[string]any); ok {
		out["usage"] = u
		if v, ok := u["input_tokens"]; ok {
			out["tokens_in"] = v
		}
		if v, ok := u["output_tokens"]; ok {
			out["tokens_out"] = v
		}
	}
	// Pass through raw for debugging.
	out["raw"] = json.RawMessage(line)

	return []adapter.Event{{Type: "result", Payload: mustMarshal(out)}}
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
