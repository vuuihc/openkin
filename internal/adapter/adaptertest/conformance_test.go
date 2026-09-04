package adaptertest

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
)

func TestAssertEventsAcceptsCanonicalAndLegacyPayloads(t *testing.T) {
	AssertEvents(t, []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":"done"}`)},
		{Type: "usage", Payload: json.RawMessage(`{"prompt_tokens":1,"completion_tokens":2}`)},
		{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)},
		{Type: "error", Payload: json.RawMessage(`{"message":"boom"}`)},
	})
}

func TestAssertEventsReportsContractViolations(t *testing.T) {
	recorder := &errorRecorder{}
	AssertEvents(recorder, []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{}`)},
		{Type: "usage", Payload: json.RawMessage(`{"source":"codex"}`)},
		{Type: "result", Payload: json.RawMessage(`{}`)},
		{Type: "result", Payload: json.RawMessage(`null`)},
		{Type: "error", Payload: json.RawMessage(`{}`)},
	})
	if len(recorder.errors) != 5 {
		t.Fatalf("errors=%v", recorder.errors)
	}
}

type errorRecorder struct {
	errors []string
}

func (r *errorRecorder) Helper() {}

func (r *errorRecorder) Errorf(format string, args ...any) {
	r.errors = append(r.errors, fmt.Sprintf(format, args...))
}
