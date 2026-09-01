package task

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/droid"
)

func TestDroidModelUsageExhaustedEmitsLimitHit(t *testing.T) {
	parser := droid.NewParser("session-1", "claude-opus-5")
	events := parser.ParseLine(`{"type":"notification","jsonrpc":"2.0","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.193.0","method":"droid.session_notification","params":{"sessionId":"session-1","notification":{"type":"agent_turn_completed","reason":"model_usage_exhausted","tokenUsage":{"inputTokens":7,"outputTokens":0}}}}`)
	ad := &fakeAdapter{events: events}
	engine := limitTestEngine(t, map[string]adapter.Adapter{"droid": ad})
	setLimitPolicy(t, engine, LimitPolicyAsk)

	task, err := engine.Create(context.Background(), CreateRequest{
		Agent:  "droid",
		Cwd:    t.TempDir(),
		Prompt: "do work",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, engine, task.ID, StatusFailed, 3*time.Second)

	stored, err := engine.Events(context.Background(), task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range stored {
		if event.Type != "limit_hit" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload["kind"] != adapter.RateLimitKind || payload["provider"] != "factory" ||
			payload["source"] != "droid" || payload["agent"] != "droid" {
			t.Fatalf("limit_hit payload=%v", payload)
		}
		return
	}
	t.Fatalf("expected limit_hit event, events=%s", limitEventTypes(stored))
}
