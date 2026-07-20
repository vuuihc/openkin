package kinagent

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
)

func TestStreamContentDeltaEmitterThrottlesAndFlushes(t *testing.T) {
	ch := make(chan adapter.Event, 32)
	onDelta, flush := streamContentDeltaEmitter(ch, "kin")

	onDelta("Hel")
	// First delta should flush immediately (lastEmit zero).
	select {
	case ev := <-ch:
		var p map[string]any
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			t.Fatal(err)
		}
		if p["partial"] != true {
			t.Fatalf("want partial true, got %#v", p["partial"])
		}
		text := extractEventText(p)
		if text != "Hel" {
			t.Fatalf("text %q", text)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting first partial")
	}

	onDelta("lo")
	// Within throttle window — may not emit yet.
	select {
	case ev := <-ch:
		t.Fatalf("unexpected early emit: %s", string(ev.Payload))
	case <-time.After(10 * time.Millisecond):
	}

	flush()
	select {
	case ev := <-ch:
		var p map[string]any
		_ = json.Unmarshal(ev.Payload, &p)
		if extractEventText(p) != "lo" {
			t.Fatalf("flush text %q", extractEventText(p))
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting flush")
	}
}

func extractEventText(p map[string]any) string {
	if s, ok := p["text"].(string); ok {
		return s
	}
	raw, ok := p["content"].([]any)
	if !ok || len(raw) == 0 {
		return ""
	}
	m, _ := raw[0].(map[string]any)
	if m == nil {
		return ""
	}
	s, _ := m["text"].(string)
	return s
}

func TestEmitPartialThenFinalIsCoalescableShape(t *testing.T) {
	// Ensure payload shape matches UI expectations (role/content/partial).
	ch := make(chan adapter.Event, 2)
	emitPartialMsg(ch, "kin", "Hi")
	emitMsg(ch, "kin", "Hi there")
	close(ch)
	var parts []string
	for ev := range ch {
		var p map[string]any
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			t.Fatal(err)
		}
		parts = append(parts, extractEventText(p))
		if len(parts) == 1 && p["partial"] != true {
			t.Fatal("first should be partial")
		}
		if len(parts) == 2 && p["partial"] != false {
			t.Fatalf("final partial=%#v", p["partial"])
		}
	}
	if strings.Join(parts, "|") != "Hi|Hi there" {
		t.Fatalf("parts %v", parts)
	}
}
