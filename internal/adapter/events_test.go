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
