package droid

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
)

func TestParserNotifications(t *testing.T) {
	envelope := func(notification string) string {
		return `{"type":"notification","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","method":"droid.session_notification","params":{"sessionId":"session-1","notification":` + notification + `}}`
	}
	tests := []struct {
		name      string
		lines     []string
		wantTypes []string
	}{
		{
			name:      "invalid input is observable",
			lines:     []string{"not-json"},
			wantTypes: []string{"raw_output"},
		},
		{
			name:      "unknown notification is observable",
			lines:     []string{envelope(`{"type":"future_event","value":1}`)},
			wantTypes: []string{"raw_output"},
		},
		{
			name: "partial assistant and thinking retain authoritative messages",
			lines: []string{
				envelope(`{"type":"assistant_text_delta","messageId":"m1","blockIndex":0,"textDelta":"hello"}`),
				envelope(`{"type":"thinking_text_delta","messageId":"m1","blockIndex":1,"textDelta":"reason"}`),
				envelope(`{"type":"create_message","message":{"id":"m1","role":"assistant","createdAt":1,"updatedAt":1,"content":[{"type":"text","text":"hello"},{"type":"thinking","thinking":"reason","signature":"sig"}]}}`),
			},
			wantTypes: []string{"message", "message", "message", "message"},
		},
		{
			name: "late partial update does not duplicate durable message",
			lines: []string{
				envelope(`{"type":"create_message","message":{"id":"m1","role":"assistant","createdAt":1,"updatedAt":1,"content":[{"type":"text","text":"hello"}]}}`),
				envelope(`{"type":"assistant_text_delta","messageId":"m1","blockIndex":0,"textDelta":"hello"}`),
			},
			wantTypes: []string{"message"},
		},
		{
			name: "durable message and tool blocks are normalized once",
			lines: []string{
				envelope(`{"type":"tool_call","toolUse":{"type":"tool_use","id":"tool-1","name":"Execute","input":{"command":"pwd"}}}`),
				envelope(`{"type":"create_message","message":{"id":"m2","role":"assistant","createdAt":1,"updatedAt":1,"content":[{"type":"text","text":"done"},{"type":"tool_use","id":"tool-1","name":"Execute","input":{"command":"pwd"}}]}}`),
				envelope(`{"type":"tool_result","messageId":"m3","toolUseId":"tool-1","content":"ok","isError":false}`),
				envelope(`{"type":"create_message","message":{"id":"m3","role":"user","createdAt":1,"updatedAt":1,"content":[{"type":"tool_result","toolUseId":"tool-1","content":"ok","isError":false}]}}`),
			},
			wantTypes: []string{"tool_use", "message", "tool_result"},
		},
		{
			name: "error is normalized",
			lines: []string{
				envelope(`{"type":"error","message":"boom","errorType":"Error","timestamp":"2026-01-01T00:00:00Z","exitCode":9}`),
			},
			wantTypes: []string{"error"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parser := NewParser("session-1", "model-1")
			var got []string
			for _, line := range test.lines {
				for _, event := range parser.ParseLine(line) {
					got = append(got, event.Type)
				}
			}
			if strings.Join(got, ",") != strings.Join(test.wantTypes, ",") {
				t.Fatalf("event types=%v want=%v", got, test.wantTypes)
			}
		})
	}
}

func TestParserAuthoritativeMessagesDoNotDuplicateResultText(t *testing.T) {
	parser := NewParser("session-1", "model-1")
	envelope := func(notification string) string {
		return `{"type":"notification","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","method":"droid.session_notification","params":{"sessionId":"session-1","notification":` + notification + `}}`
	}
	_ = parser.ParseLine(envelope(`{"type":"assistant_text_delta","messageId":"m1","blockIndex":0,"textDelta":"hello"}`))
	_ = parser.ParseLine(envelope(`{"type":"thinking_text_delta","messageId":"m1","blockIndex":1,"textDelta":"reason"}`))

	events := parser.ParseLine(envelope(`{"type":"create_message","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hello"},{"type":"thinking","thinking":"reason"}]}}`))
	if len(events) != 2 {
		t.Fatalf("authoritative events=%v", events)
	}
	for index, event := range events {
		var payload struct {
			Role      string `json:"role"`
			Partial   bool   `json:"partial"`
			MessageID string `json:"message_id"`
			Index     int    `json:"index"`
			Content   []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		wantRole := []string{"assistant", "reasoning"}[index]
		wantText := []string{"hello", "reason"}[index]
		if payload.Role != wantRole || len(payload.Content) != 1 || payload.Content[0].Text != wantText || payload.Partial ||
			payload.MessageID != "m1" || payload.Index != index {
			t.Fatalf("event[%d]=%+v", index, payload)
		}
	}

	turnEvents := parser.ParseLine(envelope(`{"type":"agent_turn_completed","reason":"completed","tokenUsage":{"inputTokens":1,"outputTokens":1}}`))
	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(turnEvents[1].Payload, &result); err != nil {
		t.Fatal(err)
	}
	if result.Text != "hello" {
		t.Fatalf("result text=%q want=%q", result.Text, "hello")
	}
}

func TestParserToolSnapshotsAndResultContract(t *testing.T) {
	parser := NewParser("session-1", "model-1")
	envelope := func(notification string) string {
		return `{"type":"notification","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","method":"droid.session_notification","params":{"sessionId":"session-1","notification":` + notification + `}}`
	}

	var toolEvents []map[string]any
	for _, notification := range []string{
		`{"type":"tool_call","toolUse":{"id":"tool-1","name":"Execute","input":{}}}`,
		`{"type":"tool_call","toolUse":{"id":"tool-1","name":"Execute","input":{"command":"pw"}}}`,
		`{"type":"tool_call","toolUse":{"id":"tool-1","name":"Execute","input":{"command":"pwd"}}}`,
		`{"type":"create_message","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"Execute","input":{"command":"pwd"}}]}}`,
	} {
		for _, event := range parser.ParseLine(envelope(notification)) {
			if event.Type != "tool_use" {
				continue
			}
			var payload map[string]any
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			toolEvents = append(toolEvents, payload)
		}
	}
	if len(toolEvents) != 3 {
		t.Fatalf("tool snapshots=%d want=3: %v", len(toolEvents), toolEvents)
	}
	if toolEvents[2]["tool_use_id"] != "tool-1" || toolEvents[2]["item_id"] != "tool-1" {
		t.Fatalf("tool identity fields=%v", toolEvents[2])
	}
	input, _ := toolEvents[2]["input"].(map[string]any)
	if input["command"] != "pwd" {
		t.Fatalf("final tool input=%v", toolEvents[2]["input"])
	}

	events := parser.ParseLine(envelope(`{"type":"tool_result","toolUseId":"tool-1","content":"ok","isError":false}`))
	if len(events) != 1 || events[0].Type != "tool_result" {
		t.Fatalf("tool result events=%v", events)
	}
	var result map[string]any
	if err := json.Unmarshal(events[0].Payload, &result); err != nil {
		t.Fatal(err)
	}
	if result["tool_use_id"] != "tool-1" || result["item_id"] != "tool-1" ||
		result["output"] != "ok" || result["status"] != "completed" || result["ok"] != true {
		t.Fatalf("tool result payload=%v", result)
	}

	events = parser.ParseLine(envelope(`{"type":"tool_result","toolUseId":"tool-2","content":[{"type":"text","text":"first line"},{"type":"text","text":"second line"},{"type":"image","source":{"type":"url","url":"https://example.invalid/image.png"}}],"isError":false}`))
	if len(events) != 1 || events[0].Type != "tool_result" {
		t.Fatalf("array tool result events=%v", events)
	}
	var arrayResult struct {
		Content json.RawMessage `json:"content"`
		Output  string          `json:"output"`
	}
	if err := json.Unmarshal(events[0].Payload, &arrayResult); err != nil {
		t.Fatal(err)
	}
	const wantContent = `[{"type":"text","text":"first line"},{"type":"text","text":"second line"},{"type":"image","source":{"type":"url","url":"https://example.invalid/image.png"}}]`
	const wantOutput = "first line\nsecond line\n{\"type\":\"image\",\"source\":{\"type\":\"url\",\"url\":\"https://example.invalid/image.png\"}}"
	if string(arrayResult.Content) != wantContent || arrayResult.Output != wantOutput {
		t.Fatalf("array tool result content=%s output=%q", arrayResult.Content, arrayResult.Output)
	}
}

func TestParserTurnCompletedUsage(t *testing.T) {
	parser := NewParser("session-42", "claude-opus-5")
	envelope := func(notification string) string {
		return `{"type":"notification","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","method":"droid.session_notification","params":{"sessionId":"session-42","notification":` + notification + `}}`
	}
	_ = parser.ParseLine(envelope(`{"type":"assistant_text_delta","messageId":"m1","blockIndex":0,"textDelta":"answer"}`))
	events := parser.ParseLine(envelope(`{"type":"agent_turn_completed","reason":"completed","turnId":"turn-1","durationMs":12,"tokenUsage":{"inputTokens":10,"outputTokens":4,"cacheCreationTokens":3,"cacheReadTokens":2,"thinkingTokens":1,"factoryCredits":0.25}}`))
	if len(events) != 2 || events[0].Type != "usage" || events[1].Type != "result" {
		t.Fatalf("events=%v", events)
	}

	var usage map[string]any
	if err := json.Unmarshal(events[0].Payload, &usage); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]float64{
		"input_tokens":            10,
		"output_tokens":           4,
		"cache_write_tokens":      3,
		"cache_read_tokens":       2,
		"reasoning_output_tokens": 1,
		"factory_credits":         0.25,
	} {
		if got, _ := usage[key].(float64); got != want {
			t.Errorf("%s=%v want=%v", key, usage[key], want)
		}
	}

	var result struct {
		Text       string `json:"text"`
		IsError    bool   `json:"is_error"`
		SessionRef string `json:"session_ref"`
	}
	if err := json.Unmarshal(events[1].Payload, &result); err != nil {
		t.Fatal(err)
	}
	if result.Text != "answer" || result.IsError || result.SessionRef != "session-42" {
		t.Fatalf("result=%+v", result)
	}
}

func TestParserUsesLatestSessionUsageAsFallback(t *testing.T) {
	parser := NewParser("session-1", "")
	envelope := func(notification string) string {
		return `{"type":"notification","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","method":"droid.session_notification","params":{"sessionId":"session-1","notification":` + notification + `}}`
	}
	if events := parser.ParseLine(envelope(`{"type":"session_token_usage_changed","sessionId":"session-1","tokenUsage":{"inputTokens":7,"outputTokens":8,"cacheCreationTokens":9,"cacheReadTokens":10,"thinkingTokens":11}}`)); len(events) != 0 {
		t.Fatalf("cumulative update must not be emitted as incremental usage: %v", events)
	}
	events := parser.ParseLine(envelope(`{"type":"agent_turn_completed","reason":"error"}`))
	var usage map[string]any
	if err := json.Unmarshal(events[0].Payload, &usage); err != nil {
		t.Fatal(err)
	}
	if usage["input_tokens"] != float64(7) || usage["reasoning_output_tokens"] != float64(11) {
		t.Fatalf("usage=%v", usage)
	}
}

func TestParserModelUsageExhaustedSatisfiesRateLimitContract(t *testing.T) {
	parser := NewParser("session-1", "claude-opus-5")
	line := `{"type":"notification","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","method":"droid.session_notification","params":{"sessionId":"session-1","notification":{"type":"agent_turn_completed","reason":"model_usage_exhausted","tokenUsage":{"inputTokens":7,"outputTokens":0}}}}`

	events := parser.ParseLine(line)
	if len(events) != 2 || events[1].Type != "result" {
		t.Fatalf("events=%v", events)
	}
	var result map[string]any
	if err := json.Unmarshal(events[1].Payload, &result); err != nil {
		t.Fatal(err)
	}
	if result["kind"] != adapter.RateLimitKind || result["provider"] != "factory" ||
		result["source"] != "droid" || result["is_error"] != true {
		t.Fatalf("result=%v", result)
	}
	message, _ := result["message"].(string)
	if !strings.Contains(strings.ToLower(message), "usage") || !strings.Contains(strings.ToLower(message), "limit") {
		t.Fatalf("message=%q", message)
	}

	info, ok := adapter.DetectRateLimitPayload(events[1].Payload)
	if !ok {
		t.Fatalf("shared rate-limit detector rejected payload=%s", events[1].Payload)
	}
	if info.Provider != "factory" || info.Source != "droid" || info.Message != message {
		t.Fatalf("rate-limit info=%+v", info)
	}
}

func TestParserConcreteModelOverridesAuto(t *testing.T) {
	envelope := func(notification string) string {
		return `{"type":"notification","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","method":"droid.session_notification","params":{"sessionId":"session-1","notification":` + notification + `}}`
	}
	parser := NewParser("session-1", "auto")
	_ = parser.ParseLine(envelope(`{"type":"settings_updated","settings":{"modelId":"auto"}}`))
	_ = parser.ParseLine(envelope(`{"type":"create_message","modelId":"claude-opus-5","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"done"}]}}`))
	events := parser.ParseLine(envelope(`{"type":"agent_turn_completed","reason":"completed","tokenUsage":{"inputTokens":1,"outputTokens":2}}`))

	var usage map[string]any
	if err := json.Unmarshal(events[0].Payload, &usage); err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(events[1].Payload, &result); err != nil {
		t.Fatal(err)
	}
	if usage["model"] != "claude-opus-5" || result["model"] != "claude-opus-5" {
		t.Fatalf("usage=%v result=%v", usage, result)
	}
}
