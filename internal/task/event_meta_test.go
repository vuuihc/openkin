package task

import (
	"encoding/json"
	"testing"

	"github.com/vuuihc/kin/internal/adapter"
)

func TestMarshalMessageUsesTypedAttribution(t *testing.T) {
	vis := VisibilityUserFacing()
	raw, err := MarshalMessage("hello", EventAttribution{
		Speaker:    "kin",
		Agent:      "kin",
		Source:     OriginOrchestrator,
		Phase:      PhaseSummary,
		Role:       "assistant",
		Visibility: &vis,
		Execution: adapter.ExecutionRef{
			ID:    "exec-1",
			Agent: "kin",
			Step:  0,
			Model: "m1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["speaker"] != "kin" || m["source"] != OriginOrchestrator || m["phase"] != PhaseSummary {
		t.Fatalf("envelope=%v", m)
	}
	visMap, _ := m["visibility"].(map[string]any)
	if visMap["user"] != true || visMap["task"] != true {
		t.Fatalf("visibility=%v", visMap)
	}
	if m["execution_id"] != "exec-1" || m["execution_model"] != "m1" {
		t.Fatalf("execution=%v", m)
	}
	// Step 0 must not be stamped (unset host run).
	if _, ok := m["execution_step"]; ok {
		t.Fatalf("execution_step should be omitted for step 0: %v", m)
	}
}

func TestApplyAttributionPreservesExplicitVisibility(t *testing.T) {
	m := map[string]any{
		"visibility": map[string]bool{"user": false, "task": true},
	}
	vis := VisibilityUserFacing()
	ApplyAttribution(m, EventAttribution{
		Speaker:    "codex",
		Agent:      "codex",
		Source:     OriginWorker,
		Visibility: &vis,
	})
	got := m["visibility"].(map[string]bool)
	if got["user"] != false {
		t.Fatalf("explicit visibility overwritten: %v", got)
	}
	if m["speaker"] != "codex" {
		t.Fatalf("speaker=%v", m["speaker"])
	}
}
