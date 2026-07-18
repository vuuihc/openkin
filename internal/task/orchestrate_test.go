package task

import (
	"encoding/json"
	"testing"
)

func TestStampAgentModel(t *testing.T) {
	tests := []struct {
		name       string
		raw        json.RawMessage
		selected   string
		wantModel  string
		wantAbsent bool
	}{
		{
			name:      "selected model is added",
			raw:       json.RawMessage(`{"role":"assistant"}`),
			selected:  "openai/gpt-5.5",
			wantModel: "openai/gpt-5.5",
		},
		{
			name:      "adapter reported model wins",
			raw:       json.RawMessage(`{"role":"assistant","model":"claude-opus-4-1"}`),
			selected:  "opus",
			wantModel: "claude-opus-4-1",
		},
		{
			name:       "empty model is omitted",
			raw:        json.RawMessage(`{"role":"assistant"}`),
			selected:   "",
			wantAbsent: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stampSpeaker(tt.raw, "kin", tt.selected)
			var payload map[string]any
			if err := json.Unmarshal(got, &payload); err != nil {
				t.Fatalf("unmarshal stamped payload: %v", err)
			}
			model, exists := payload["model"]
			if tt.wantAbsent {
				if exists {
					t.Fatalf("model unexpectedly present: %#v", model)
				}
				return
			}
			if model != tt.wantModel {
				t.Fatalf("model=%#v want %q", model, tt.wantModel)
			}
		})
	}
}

func TestStampWorkerModel(t *testing.T) {
	got := stampWorker(json.RawMessage(`{"role":"assistant"}`), "codex", "gpt-5.5-codex")
	var payload map[string]any
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatalf("unmarshal stamped payload: %v", err)
	}
	if payload["model"] != "gpt-5.5-codex" {
		t.Fatalf("model=%#v want gpt-5.5-codex", payload["model"])
	}
	visibility, _ := payload["visibility"].(map[string]any)
	if visibility["user"] != false || visibility["task"] != true {
		t.Fatalf("visibility=%#v want task-only", visibility)
	}
}
