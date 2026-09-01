// Package droid implements the Factory Droid CLI JSON-RPC adapter.
package droid

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/vuuihc/openkin/internal/adapter"
)

// Parser converts Droid session notifications into canonical Kin events.
// It tracks streamed blocks and tool ids so durable create_message events do
// not duplicate partial output already shown to the user.
type Parser struct {
	sessionRef    string
	model         string
	assistantText strings.Builder
	streamed      map[string]bool
	completed     map[string]bool
	tools         map[string]string
	toolResults   map[string]bool
	lastUsage     tokenUsage
}

type tokenUsage struct {
	InputTokens         int      `json:"inputTokens"`
	OutputTokens        int      `json:"outputTokens"`
	CacheCreationTokens int      `json:"cacheCreationTokens"`
	CacheReadTokens     int      `json:"cacheReadTokens"`
	ThinkingTokens      int      `json:"thinkingTokens"`
	FactoryCredits      *float64 `json:"factoryCredits,omitempty"`
}

// NewParser creates a parser for one Droid process run.
func NewParser(sessionRef, model string) *Parser {
	return &Parser{
		sessionRef:  sessionRef,
		model:       model,
		streamed:    make(map[string]bool),
		completed:   make(map[string]bool),
		tools:       make(map[string]string),
		toolResults: make(map[string]bool),
	}
}

// SetSessionRef updates the session id after initialize_session succeeds.
func (p *Parser) SetSessionRef(sessionRef string) {
	p.sessionRef = sessionRef
}

// ParseLine parses one complete stream-jsonrpc stdout line.
func (p *Parser) ParseLine(line string) []adapter.Event {
	if strings.TrimSpace(line) == "" {
		return nil
	}
	var env rpcEnvelope
	if err := json.Unmarshal([]byte(line), &env); err != nil {
		return []adapter.Event{rawOutput(line)}
	}
	if env.Type != "notification" || env.Method != methodSessionNotification {
		return []adapter.Event{rawOutput(line)}
	}
	return p.parseNotification(env.Params, line)
}

func (p *Parser) parseNotification(params json.RawMessage, line string) []adapter.Event {
	var wrapper struct {
		SessionID    string          `json:"sessionId"`
		Notification json.RawMessage `json:"notification"`
	}
	if err := json.Unmarshal(params, &wrapper); err != nil || len(wrapper.Notification) == 0 {
		return []adapter.Event{rawOutput(line)}
	}
	if wrapper.SessionID != "" && p.sessionRef == "" {
		p.sessionRef = wrapper.SessionID
	}

	var note struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(wrapper.Notification, &note); err != nil || note.Type == "" {
		return []adapter.Event{rawOutput(line)}
	}
	p.captureModel(wrapper.Notification)

	switch note.Type {
	case "assistant_text_delta":
		return p.parseTextDelta(wrapper.Notification, "assistant")
	case "thinking_text_delta":
		return p.parseTextDelta(wrapper.Notification, "reasoning")
	case "assistant_text_complete", "thinking_text_complete":
		return nil
	case "create_message":
		return p.parseCreateMessage(wrapper.Notification)
	case "tool_call":
		return p.parseToolCall(wrapper.Notification)
	case "tool_result":
		return p.parseToolResult(wrapper.Notification)
	case "session_token_usage_changed":
		var usageNote struct {
			TokenUsage tokenUsage `json:"tokenUsage"`
		}
		if json.Unmarshal(wrapper.Notification, &usageNote) == nil {
			p.lastUsage = usageNote.TokenUsage
		}
		return nil
	case "settings_updated":
		return nil
	case "agent_turn_completed":
		return p.parseTurnCompleted(wrapper.Notification)
	case "error":
		var errNote struct {
			Message   string `json:"message"`
			ErrorType string `json:"errorType"`
			ExitCode  *int   `json:"exitCode"`
		}
		if err := json.Unmarshal(wrapper.Notification, &errNote); err != nil {
			return []adapter.Event{rawOutput(line)}
		}
		if errNote.Message == "" {
			errNote.Message = "Droid reported an error"
		}
		payload := map[string]any{"message": errNote.Message, "error_type": errNote.ErrorType}
		if errNote.ExitCode != nil {
			payload["exit_code"] = *errNote.ExitCode
		}
		return []adapter.Event{{Type: "error", Payload: mustMarshal(payload)}}
	default:
		return []adapter.Event{rawOutput(line)}
	}
}

func (p *Parser) parseTextDelta(raw json.RawMessage, role string) []adapter.Event {
	var note struct {
		MessageID  string `json:"messageId"`
		BlockIndex int    `json:"blockIndex"`
		TextDelta  string `json:"textDelta"`
	}
	if err := json.Unmarshal(raw, &note); err != nil || note.TextDelta == "" {
		return nil
	}
	key := blockKey(role, note.MessageID, note.BlockIndex)
	if p.completed[key] {
		return nil
	}
	p.streamed[key] = true
	if role == "assistant" {
		p.assistantText.WriteString(note.TextDelta)
	}
	return []adapter.Event{{
		Type: "message",
		Payload: mustMarshal(map[string]any{
			"role":       role,
			"content":    []map[string]string{{"type": "text", "text": note.TextDelta}},
			"partial":    true,
			"message_id": note.MessageID,
			"index":      note.BlockIndex,
		}),
	}}
}

func (p *Parser) parseCreateMessage(raw json.RawMessage) []adapter.Event {
	var note struct {
		Message struct {
			ID      string `json:"id"`
			Role    string `json:"role"`
			Content []struct {
				Type      string          `json:"type"`
				Text      string          `json:"text"`
				Thinking  string          `json:"thinking"`
				ID        string          `json:"id"`
				Name      string          `json:"name"`
				Input     json.RawMessage `json:"input"`
				ToolUseID string          `json:"toolUseId"`
				Content   json.RawMessage `json:"content"`
				IsError   bool            `json:"isError"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &note); err != nil || note.Message.ID == "" {
		return nil
	}

	var events []adapter.Event
	for index, block := range note.Message.Content {
		switch block.Type {
		case "text":
			if note.Message.Role != "assistant" || block.Text == "" {
				continue
			}
			key := blockKey("assistant", note.Message.ID, index)
			p.completed[key] = true
			if !p.streamed[key] {
				p.assistantText.WriteString(block.Text)
			}
			events = append(events, messageEvent("assistant", block.Text, false, note.Message.ID, index))
		case "thinking":
			if note.Message.Role != "assistant" || block.Thinking == "" {
				continue
			}
			key := blockKey("reasoning", note.Message.ID, index)
			p.completed[key] = true
			events = append(events, messageEvent("reasoning", block.Thinking, false, note.Message.ID, index))
		case "tool_use":
			events = append(events, p.toolUseEvents(block.ID, block.Name, block.Input)...)
		case "tool_result":
			if block.ToolUseID == "" || p.toolResults[block.ToolUseID] {
				continue
			}
			p.toolResults[block.ToolUseID] = true
			events = append(events, toolResultEvent(block.ToolUseID, block.Content, block.IsError))
		}
	}
	return events
}

func (p *Parser) parseToolCall(raw json.RawMessage) []adapter.Event {
	var note struct {
		ToolUse struct {
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"toolUse"`
	}
	if err := json.Unmarshal(raw, &note); err != nil {
		return nil
	}
	return p.toolUseEvents(note.ToolUse.ID, note.ToolUse.Name, note.ToolUse.Input)
}

func (p *Parser) parseToolResult(raw json.RawMessage) []adapter.Event {
	var note struct {
		ToolUseID string          `json:"toolUseId"`
		Content   json.RawMessage `json:"content"`
		IsError   bool            `json:"isError"`
	}
	if err := json.Unmarshal(raw, &note); err != nil || note.ToolUseID == "" || p.toolResults[note.ToolUseID] {
		return nil
	}
	p.toolResults[note.ToolUseID] = true
	return []adapter.Event{toolResultEvent(note.ToolUseID, note.Content, note.IsError)}
}

func (p *Parser) parseTurnCompleted(raw json.RawMessage) []adapter.Event {
	var note struct {
		Reason        string          `json:"reason"`
		TokenUsageRaw json.RawMessage `json:"tokenUsage"`
		DurationMS    *float64        `json:"durationMs"`
		TurnID        string          `json:"turnId"`
	}
	if err := json.Unmarshal(raw, &note); err != nil {
		return []adapter.Event{{Type: "error", Payload: mustMarshal(map[string]string{"message": "decode Droid turn completion: " + err.Error()})}}
	}
	usage := p.lastUsage
	if len(note.TokenUsageRaw) > 0 && string(note.TokenUsageRaw) != "null" {
		if err := json.Unmarshal(note.TokenUsageRaw, &usage); err != nil {
			return []adapter.Event{{Type: "error", Payload: mustMarshal(map[string]string{"message": "decode Droid token usage: " + err.Error()})}}
		}
	}
	canonicalUsage := usagePayload(usage, p.model)
	isError := note.Reason != "completed" && note.Reason != "spec_handoff"
	text := p.assistantText.String()
	const usageExhaustedMessage = "Droid model usage limit exhausted."
	if isError && strings.TrimSpace(text) == "" {
		if note.Reason == "model_usage_exhausted" {
			text = usageExhaustedMessage
		} else {
			text = fmt.Sprintf("Droid turn ended: %s", note.Reason)
		}
	}
	result := map[string]any{
		"text":        text,
		"is_error":    isError,
		"model":       p.model,
		"session_ref": p.sessionRef,
		"subtype":     note.Reason,
		"usage":       canonicalUsage,
	}
	if note.Reason == "model_usage_exhausted" {
		result["kind"] = adapter.RateLimitKind
		result["message"] = usageExhaustedMessage
		result["provider"] = "factory"
		result["source"] = "droid"
	}
	if note.DurationMS != nil {
		result["duration_ms"] = *note.DurationMS
	}
	if note.TurnID != "" {
		result["turn_id"] = note.TurnID
	}
	return []adapter.Event{
		{Type: "usage", Payload: mustMarshal(canonicalUsage)},
		{Type: "result", Payload: mustMarshal(result)},
	}
}

func (p *Parser) captureModel(raw json.RawMessage) {
	if p.model != "" && p.model != "auto" {
		return
	}
	var note struct {
		ModelID  string `json:"modelId"`
		Settings struct {
			ModelID string `json:"modelId"`
		} `json:"settings"`
		Message struct {
			ModelID string `json:"modelId"`
		} `json:"message"`
	}
	if json.Unmarshal(raw, &note) != nil {
		return
	}
	for _, model := range []string{note.ModelID, note.Settings.ModelID, note.Message.ModelID} {
		if model = strings.TrimSpace(model); model != "" && (p.model == "" || model != "auto") {
			p.model = model
			if model != "auto" {
				return
			}
		}
	}
}

func (p *Parser) toolUseEvents(id, name string, input json.RawMessage) []adapter.Event {
	if id == "" {
		return nil
	}
	normalized := normalizeJSON(input, `{}`)
	snapshot := name + "\x00" + string(normalized)
	if p.tools[id] == snapshot {
		return nil
	}
	p.tools[id] = snapshot
	return []adapter.Event{toolUseEvent(id, name, normalized)}
}

func usagePayload(usage tokenUsage, model string) map[string]any {
	payload := map[string]any{
		"source":                  "droid",
		"model":                   model,
		"input_tokens":            usage.InputTokens,
		"output_tokens":           usage.OutputTokens,
		"cache_read_tokens":       usage.CacheReadTokens,
		"cache_write_tokens":      usage.CacheCreationTokens,
		"cache_read_reported":     true,
		"reasoning_output_tokens": usage.ThinkingTokens,
		"input_semantics":         "uncached_only",
		"usage":                   usage,
	}
	if usage.FactoryCredits != nil {
		payload["factory_credits"] = *usage.FactoryCredits
	}
	return payload
}

func messageEvent(role, text string, partial bool, messageID string, index int) adapter.Event {
	return adapter.Event{
		Type: "message",
		Payload: mustMarshal(map[string]any{
			"role":       role,
			"content":    []map[string]string{{"type": "text", "text": text}},
			"partial":    partial,
			"message_id": messageID,
			"index":      index,
		}),
	}
}

func toolUseEvent(id, name string, input json.RawMessage) adapter.Event {
	input = normalizeJSON(input, `{}`)
	return adapter.Event{
		Type: "tool_use",
		Payload: mustMarshal(map[string]any{
			"phase":       "started",
			"tool_use_id": id,
			"item_id":     id,
			"name":        name,
			"input":       input,
		}),
	}
}

func toolResultEvent(id string, content json.RawMessage, isError bool) adapter.Event {
	content = normalizeJSON(content, `null`)
	status := "completed"
	if isError {
		status = "error"
	}
	return adapter.Event{
		Type: "tool_result",
		Payload: mustMarshal(map[string]any{
			"tool_use_id": id,
			"item_id":     id,
			"content":     content,
			"output":      toolResultDisplay(content),
			"status":      status,
			"ok":          !isError,
			"is_error":    isError,
		}),
	}
}

func toolResultDisplay(content json.RawMessage) string {
	var text string
	if len(content) > 0 && content[0] == '"' && json.Unmarshal(content, &text) == nil {
		return text
	}

	var blocks []json.RawMessage
	if len(content) > 0 && content[0] == '[' && json.Unmarshal(content, &blocks) == nil {
		if len(blocks) == 0 {
			return string(content)
		}
		parts := make([]string, 0, len(blocks))
		for _, block := range blocks {
			var textBlock struct {
				Type string  `json:"type"`
				Text *string `json:"text"`
			}
			if json.Unmarshal(block, &textBlock) == nil && textBlock.Type == "text" && textBlock.Text != nil {
				parts = append(parts, *textBlock.Text)
				continue
			}
			parts = append(parts, string(normalizeJSON(block, `null`)))
		}
		return strings.Join(parts, "\n")
	}

	return string(content)
}

func normalizeJSON(value json.RawMessage, fallback string) json.RawMessage {
	if len(value) == 0 {
		return json.RawMessage(fallback)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, value); err != nil {
		return value
	}
	return json.RawMessage(compact.String())
}

func blockKey(role, messageID string, index int) string {
	return fmt.Sprintf("%s:%s:%d", role, messageID, index)
}

func rawOutput(line string) adapter.Event {
	return adapter.Event{
		Type:    "raw_output",
		Payload: mustMarshal(map[string]string{"line": line}),
	}
}

func mustMarshal(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return data
}
