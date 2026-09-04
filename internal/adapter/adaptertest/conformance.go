// Package adaptertest provides reusable conformance checks for adapter events.
package adaptertest

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/vuuihc/openkin/internal/adapter"
)

// TestingT is the subset of testing.T used by AssertEvents.
type TestingT interface {
	Helper()
	Errorf(format string, args ...any)
}

// AssertEvents checks the canonical semantic contract without constraining
// vendor-specific fields retained in raw payloads.
func AssertEvents(t TestingT, events []adapter.Event) {
	t.Helper()
	for i, event := range events {
		prefix := fmt.Sprintf("event[%d] type=%q", i, event.Type)
		if strings.TrimSpace(event.Type) == "" {
			t.Errorf("%s: type is required", prefix)
			continue
		}
		if !json.Valid(event.Payload) {
			t.Errorf("%s: payload is not valid JSON: %q", prefix, event.Payload)
			continue
		}
		semantic, err := adapter.DecodeEvent(event)
		if err != nil {
			t.Errorf("%s: semantic decode failed: %v", prefix, err)
			continue
		}
		switch event.Type {
		case "task_started":
			if semantic.SessionRef == "" {
				t.Errorf("%s: session reference is required", prefix)
			}
		case "message":
			if semantic.Message == nil || strings.TrimSpace(semantic.Message.Role) == "" {
				t.Errorf("%s: message role is required", prefix)
			}
		case "usage":
			if semantic.Usage == nil || !hasAccountingValue(*semantic.Usage) {
				t.Errorf("%s: usage requires at least one accounting value", prefix)
			}
		case "result":
			if semantic.Result == nil {
				t.Errorf("%s: result semantics are required", prefix)
			}
		case "error":
			if semantic.Error == nil || strings.TrimSpace(semantic.Error.Message) == "" {
				t.Errorf("%s: error message is required", prefix)
			}
		}
	}
}

func hasAccountingValue(usage adapter.UsageSemantics) bool {
	return usage.InputTokens != nil ||
		usage.OutputTokens != nil ||
		usage.ReasoningOutputTokens != nil ||
		usage.CacheReadTokens != nil ||
		usage.CacheWriteTokens != nil ||
		usage.CostUSD != nil
}
