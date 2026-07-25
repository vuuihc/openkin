package adapter

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestDetectRateLimitMessage(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"rate limited (HTTP 429)", true},
		{"You've hit your usage limit. Try again in 30 minutes.", true},
		{"HTTP 429 Too Many Requests", true},
		{"quota exceeded for this organization", true},
		{"connection reset by peer", false},
		{"model does not exist", false},
		{"", false},
	}
	for _, tc := range cases {
		_, ok := DetectRateLimitMessage(tc.in)
		if ok != tc.want {
			t.Errorf("DetectRateLimitMessage(%q) ok=%v want %v", tc.in, ok, tc.want)
		}
	}
}

func TestParseRateLimitReset(t *testing.T) {
	if got := ParseRateLimitReset(`reset_at=1710000000`); got != 1710000000 {
		t.Fatalf("unix sec: got %d", got)
	}
	if got := ParseRateLimitReset(`resetsAt: 1710000000000`); got != 1710000000 {
		t.Fatalf("unix ms: got %d", got)
	}
	rfc := "2026-07-25T12:00:00Z"
	want, _ := time.Parse(time.RFC3339, rfc)
	if got := ParseRateLimitReset("resets at " + rfc); got != want.Unix() {
		t.Fatalf("rfc3339: got %d want %d", got, want.Unix())
	}
	before := time.Now().Unix()
	got := ParseRateLimitReset("try again in 5 minutes")
	after := time.Now().Unix()
	if got < before+4*60 || got > after+6*60 {
		t.Fatalf("relative minutes out of range: %d", got)
	}
}

func TestDetectRateLimitPayloadStructured(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{
		"kind":     "rate_limited",
		"message":  "Claude 5h limit",
		"reset_at": 1710000000,
		"provider": "claude",
	})
	info, ok := DetectRateLimitPayload(raw)
	if !ok {
		t.Fatal("expected hit")
	}
	if info.Kind != RateLimitKind || info.ResetAt != 1710000000 || info.Provider != "claude" {
		t.Fatalf("info=%+v", info)
	}
}

func TestDetectRateLimitPayloadClaudeEvent(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{
		"type": "rate_limit_event",
		"rate_limit_info": map[string]any{
			"status":   "rejected",
			"resetsAt": float64(1710000000),
			"window":   "5h",
		},
	})
	info, ok := DetectRateLimitPayload(raw)
	if !ok {
		t.Fatal("expected hit")
	}
	if info.ResetAt != 1710000000 || info.Window != "5h" {
		t.Fatalf("info=%+v", info)
	}
	if info.Provider != "claude" {
		t.Fatalf("provider=%q", info.Provider)
	}
}

func TestDetectRateLimitPayloadClaudeEventAllowed(t *testing.T) {
	for _, status := range []string{"allowed", "allowed_warning"} {
		raw, _ := json.Marshal(map[string]any{
			"type": "rate_limit_event",
			"rate_limit_info": map[string]any{
				"status":   status,
				"resetsAt": float64(1710000000),
				"window":   "5h",
			},
		})
		if info, ok := DetectRateLimitPayload(raw); ok {
			t.Fatalf("status=%q should not be a limit, got %+v", status, info)
		}
	}
}

func TestEnrichErrorPayload(t *testing.T) {
	p := map[string]any{"message": "HTTP 429 rate limited"}
	out := EnrichErrorPayload(p)
	if out["kind"] != RateLimitKind {
		t.Fatalf("kind=%v", out["kind"])
	}
	p2 := map[string]any{"message": "plain failure"}
	out2 := EnrichErrorPayload(p2)
	if _, ok := out2["kind"]; ok {
		t.Fatalf("should not enrich: %v", out2)
	}
}

func TestDetectRateLimitMessageShortens(t *testing.T) {
	long := "rate limited " + strings.Repeat("x", 400)
	info, ok := DetectRateLimitMessage(long)
	if !ok {
		t.Fatal("expected hit")
	}
	if len([]rune(info.Message)) > 250 {
		t.Fatalf("message too long: %d", len([]rune(info.Message)))
	}
}
