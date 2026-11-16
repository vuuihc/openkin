package adapter

import (
	"encoding/json"
	"testing"
)

func TestParseStartedCanonicalAndLegacy(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"canonical", `{"session_ref":"s-can","model":"m1"}`, "s-can"},
		{"legacy_session_id", `{"session_id":"s-leg","subtype":"init"}`, "s-leg"},
		{"legacy_sessionId", `{"sessionId":"s-camel"}`, "s-camel"},
		{"empty", `{}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ParseStarted(json.RawMessage(tc.raw))
			if !ok {
				t.Fatal("expected ok")
			}
			if got.SessionRef != tc.want {
				t.Fatalf("session_ref=%q want %q", got.SessionRef, tc.want)
			}
		})
	}
	if _, ok := ParseStarted(json.RawMessage(`not-json`)); ok {
		t.Fatal("malformed should fail")
	}
}

func TestParseResultLegacyAndCanonical(t *testing.T) {
	// Legacy Claude-style result.
	legacy := json.RawMessage(`{
		"result":"hello",
		"is_error":false,
		"session_id":"s1",
		"tokens_in":10,
		"tokens_out":5,
		"total_cost_usd":0.01,
		"cost_usd":0.01
	}`)
	got, ok := ParseResult(legacy)
	if !ok {
		t.Fatal("expected ok")
	}
	if got.Text != "hello" || got.SessionRef != "s1" || got.IsError {
		t.Fatalf("legacy parse: %+v", got)
	}
	if got.Usage.TokensIn != 10 || got.Usage.TokensOut != 5 || got.Usage.CostUSD == nil || *got.Usage.CostUSD != 0.01 {
		t.Fatalf("legacy usage: %+v", got.Usage)
	}

	// Canonical nested usage, no cost.
	canonical := json.RawMessage(`{
		"text":"done",
		"is_error":false,
		"session_ref":"s2",
		"usage":{"tokens_in":3,"tokens_out":4,"model":"gpt"}
	}`)
	got, ok = ParseResult(canonical)
	if !ok {
		t.Fatal("expected ok")
	}
	if got.Text != "done" || got.SessionRef != "s2" || got.Usage.Model != "gpt" {
		t.Fatalf("canonical: %+v", got)
	}
	if got.Usage.CostUSD != nil {
		t.Fatalf("cost should be nil, got %v", *got.Usage.CostUSD)
	}

	// Nested result object.
	nested := json.RawMessage(`{"result":{"text":"nested-ok"},"is_error":true}`)
	got, ok = ParseResult(nested)
	if !ok || got.Text != "nested-ok" || !got.IsError {
		t.Fatalf("nested: %+v ok=%v", got, ok)
	}

	if _, ok := ParseResult(json.RawMessage(`{`)); ok {
		t.Fatal("malformed should fail")
	}
}

func TestSessionRefFromEvent(t *testing.T) {
	if got := SessionRefFromEvent(json.RawMessage(`{"session_id":"a"}`)); got != "a" {
		t.Fatalf("got %q", got)
	}
	if got := SessionRefFromEvent(json.RawMessage(`{"session_ref":"b"}`)); got != "b" {
		t.Fatalf("got %q", got)
	}
}

func TestDecodeEventSemanticViews(t *testing.T) {
	event := Event{
		Type: "result",
		Payload: json.RawMessage(`{
			"sessionId":"legacy-session",
			"is_error":true,
			"message":"context canceled",
			"visibility":{"user":false,"task":true},
			"source":"codex",
			"provider_id":"openai-primary",
			"prompt_tokens":12,
			"completion_tokens":3,
			"cached_tokens":4,
			"cache_read_reported":true
		}`),
	}
	got, err := DecodeEvent(event)
	if err != nil {
		t.Fatal(err)
	}
	if got.SessionRef != "legacy-session" || got.Result == nil || !got.Result.IsError {
		t.Fatalf("result semantics=%+v", got)
	}
	if got.Error == nil || got.Error.Message != "context canceled" || !got.Error.Canceled {
		t.Fatalf("error semantics=%+v", got.Error)
	}
	if got.Visibility == nil || got.Visibility.User || !got.Visibility.Task {
		t.Fatalf("visibility=%+v", got.Visibility)
	}
	if got.Usage == nil || got.Usage.InputTokens == nil || *got.Usage.InputTokens != 12 ||
		got.Usage.OutputTokens == nil || *got.Usage.OutputTokens != 3 ||
		got.Usage.ProviderID != "openai-primary" {
		t.Fatalf("usage semantics=%+v", got.Usage)
	}
}

func TestDecodeMessageContent(t *testing.T) {
	got, err := DecodeEvent(Event{
		Type:    "message",
		Payload: json.RawMessage(`{"role":"assistant","partial":false,"content":[{"type":"text","text":"hello "},{"type":"text","text":"world"}]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Message == nil || got.Message.Role != "assistant" || got.Message.Text != "hello world" {
		t.Fatalf("message=%+v", got.Message)
	}
}

func TestDecodeResultRequiresTerminalMarker(t *testing.T) {
	for _, raw := range []json.RawMessage{json.RawMessage(`{}`), json.RawMessage(`null`)} {
		if _, err := DecodeEvent(Event{Type: "result", Payload: raw}); err == nil {
			t.Fatalf("payload %s should not satisfy result contract", raw)
		}
	}
}

func TestDecodeResultRejectsMalformedNestedUsageAndTrailingData(t *testing.T) {
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"is_error":false,"usage":{"input_tokens":"bad"}}`),
		json.RawMessage(`{"is_error":false} trailing`),
	} {
		if _, err := DecodeEvent(Event{Type: "result", Payload: raw}); err == nil {
			t.Fatalf("payload %s should fail decoding", raw)
		}
	}
}

func TestDecodeResultPrefersNestedCanonicalUsage(t *testing.T) {
	got, err := DecodeEvent(Event{
		Type: "result",
		Payload: json.RawMessage(`{
			"is_error": false,
			"tokens_out": 99,
			"total_cost_usd": 9,
			"usage": {"output_tokens": 7, "cost_usd": 1}
		}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Usage == nil || got.Usage.OutputTokens == nil || *got.Usage.OutputTokens != 7 {
		t.Fatalf("usage=%+v", got.Usage)
	}
	if got.Usage.CostUSD == nil || *got.Usage.CostUSD != 1 {
		t.Fatalf("cost=%v", got.Usage.CostUSD)
	}
}
