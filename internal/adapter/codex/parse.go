// Package codex implements the Codex CLI adapter (spec §4.3).
package codex

import (
	"encoding/json"

	"github.com/vuuihc/kin/internal/adapter"
)

// DefaultModel is used for price-table lookup when a task has no model set.
const DefaultModel = "gpt-5-codex"

// ParseLine converts one stdout line of `codex exec --json` into zero or more
// adapter events. Unparseable lines become raw_output; unknown types are ignored.
//
// Shapes coded against (codex exec --json JSONL, 2025–2026 docs):
//
//	{"type":"thread.started","thread_id":"..."}
//	{"type":"turn.started"}
//	{"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
//	{"type":"turn.failed","error":{"message":"..."}}
//	{"type":"error","message":"..."}
//	{"type":"item.started|item.updated|item.completed","item":{"id":"...","type":"..."}}
//
// Item types: agent_message, reasoning, command_execution, file_change,
// mcp_tool_call, web_search, todo_list, error.
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
		return []adapter.Event{rawOutput(line)}
	}

	switch typ {
	case "thread.started":
		return parseThreadStarted(raw)
	case "turn.started":
		return nil // lifecycle only
	case "turn.completed":
		return parseTurnCompleted(raw, line)
	case "turn.failed":
		return parseTurnFailed(raw)
	case "error":
		return parseError(raw)
	case "item.started", "item.updated", "item.completed":
		return parseItem(typ, raw, line)
	default:
		// Unknown but valid JSON: ignore (never crash).
		return nil
	}
}

func parseThreadStarted(raw map[string]json.RawMessage) []adapter.Event {
	var threadID string
	_ = json.Unmarshal(raw["thread_id"], &threadID)
	payload, _ := json.Marshal(map[string]any{
		"session_id": threadID,
		"thread_id":  threadID,
		"subtype":    "thread.started",
	})
	return []adapter.Event{{Type: "task_started", Payload: payload}}
}

func parseTurnCompleted(raw map[string]json.RawMessage, line string) []adapter.Event {
	var usage struct {
		InputTokens        float64 `json:"input_tokens"`
		CachedInputTokens  float64 `json:"cached_input_tokens"`
		OutputTokens       float64 `json:"output_tokens"`
		ReasoningOutTokens float64 `json:"reasoning_output_tokens"`
	}
	_ = json.Unmarshal(raw["usage"], &usage)

	tokensIn := int(usage.InputTokens)
	tokensOut := int(usage.OutputTokens)
	// Include reasoning tokens in output when present.
	if usage.ReasoningOutTokens > 0 {
		tokensOut += int(usage.ReasoningOutTokens)
	}

	result := map[string]any{
		"subtype":    "turn.completed",
		"is_error":   false,
		"tokens_in":  tokensIn,
		"tokens_out": tokensOut,
		"usage": map[string]any{
			"input_tokens":            usage.InputTokens,
			"cached_input_tokens":     usage.CachedInputTokens,
			"output_tokens":           usage.OutputTokens,
			"reasoning_output_tokens": usage.ReasoningOutTokens,
		},
	}

	events := []adapter.Event{
		{
			Type: "usage",
			Payload: mustMarshal(map[string]any{
				"tokens_in":  tokensIn,
				"tokens_out": tokensOut,
				"usage":      result["usage"],
			}),
		},
		{
			Type:    "result",
			Payload: mustMarshal(result),
		},
	}
	return events
}

func parseTurnFailed(raw map[string]json.RawMessage) []adapter.Event {
	msg := "turn failed"
	var errObj struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw["error"], &errObj); err == nil && errObj.Message != "" {
		msg = errObj.Message
	}
	return []adapter.Event{{
		Type: "result",
		Payload: mustMarshal(map[string]any{
			"subtype":  "turn.failed",
			"is_error": true,
			"result":   msg,
			"message":  msg,
		}),
	}}
}

func parseError(raw map[string]json.RawMessage) []adapter.Event {
	var msg string
	_ = json.Unmarshal(raw["message"], &msg)
	if msg == "" {
		msg = "codex error"
	}
	// Transient reconnect notices are non-fatal progress; surface as raw_output.
	if isReconnectNotice(msg) {
		return []adapter.Event{rawOutput(msg)}
	}
	return []adapter.Event{{
		Type:    "error",
		Payload: mustMarshal(map[string]string{"message": msg}),
	}}
}

func isReconnectNotice(msg string) bool {
	// e.g. "Reconnecting... 1/5"
	return len(msg) >= 12 && (msg[:12] == "Reconnecting" || msg[:12] == "reconnecting")
}

func parseItem(eventType string, raw map[string]json.RawMessage, line string) []adapter.Event {
	var item map[string]json.RawMessage
	if err := json.Unmarshal(raw["item"], &item); err != nil || item == nil {
		return []adapter.Event{rawOutput(line)}
	}

	var itemType string
	_ = json.Unmarshal(item["type"], &itemType)
	var itemID string
	_ = json.Unmarshal(item["id"], &itemID)

	switch itemType {
	case "agent_message", "reasoning":
		// Prefer completed messages; started/updated rarely appear for these.
		if eventType != "item.completed" {
			return nil
		}
		var text string
		_ = json.Unmarshal(item["text"], &text)
		role := "assistant"
		if itemType == "reasoning" {
			role = "reasoning"
		}
		return []adapter.Event{{
			Type: "message",
			Payload: mustMarshal(map[string]any{
				"role":    role,
				"content": []map[string]string{{"type": "text", "text": text}},
				"partial": false,
				"item_id": itemID,
			}),
		}}

	case "command_execution", "mcp_tool_call", "file_change", "web_search", "todo_list":
		return []adapter.Event{{
			Type: "tool_use",
			Payload: mustMarshal(map[string]any{
				"phase":   itemPhase(eventType),
				"item_id": itemID,
				"name":    itemType,
				"item":    json.RawMessage(mustMarshalRaw(item)),
			}),
		}}

	case "error":
		if eventType != "item.completed" {
			return nil
		}
		var msg string
		_ = json.Unmarshal(item["message"], &msg)
		if msg == "" {
			msg = "item error"
		}
		return []adapter.Event{{
			Type:    "error",
			Payload: mustMarshal(map[string]string{"message": msg, "item_id": itemID}),
		}}

	default:
		// Unknown item type: raw for observability on completed only.
		if eventType == "item.completed" {
			return []adapter.Event{rawOutput(line)}
		}
		return nil
	}
}

func itemPhase(eventType string) string {
	switch eventType {
	case "item.started":
		return "started"
	case "item.updated":
		return "updated"
	default:
		return "completed"
	}
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

func mustMarshalRaw(m map[string]json.RawMessage) []byte {
	// Rebuild object preserving raw fields.
	out := make(map[string]any, len(m))
	for k, v := range m {
		var val any
		if err := json.Unmarshal(v, &val); err != nil {
			out[k] = string(v)
		} else {
			out[k] = val
		}
	}
	b, _ := json.Marshal(out)
	return b
}

// ExtractSessionID pulls session/thread id from task_started payloads.
func ExtractSessionID(payload json.RawMessage) string {
	var m struct {
		SessionID string `json:"session_id"`
		ThreadID  string `json:"thread_id"`
	}
	_ = json.Unmarshal(payload, &m)
	if m.SessionID != "" {
		return m.SessionID
	}
	return m.ThreadID
}
