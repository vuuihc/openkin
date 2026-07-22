package task

import (
	"encoding/json"
	"strings"

	"github.com/vuuihc/kin/internal/adapter"
)

// Canonical event metadata: transport type (message, result, …) is separate
// from semantic origin, audience, phase, and execution attribution.

// Origin values identify who produced the semantic event (JSON field: source).
const (
	OriginUser         = "user"
	OriginHost         = "host"
	OriginWorker       = "worker"
	OriginOrchestrator = "orchestrator"
	OriginDelegate     = "delegate"
	OriginCreate       = "create"
	OriginFollowUp     = "follow_up"
)

// Phase values describe multi-agent orchestration stages (JSON field: phase).
const (
	PhasePlan     = "plan"
	PhaseProgress = "progress"
	PhaseSummary  = "summary"
)

// Visibility is the audience for a canonical event.
type Visibility struct {
	User bool `json:"user"`
	Task bool `json:"task"`
}

// VisibilityUserFacing is shown in the main chat column and task log.
func VisibilityUserFacing() Visibility {
	return Visibility{User: true, Task: true}
}

// VisibilityTaskOnly is progress/log only (hidden from the main chat column).
func VisibilityTaskOnly() Visibility {
	return Visibility{User: false, Task: true}
}

// EventAttribution is the canonical envelope stamped onto new Kin events.
// Provider-specific payload details stay outside this struct.
type EventAttribution struct {
	Speaker    string
	Agent      string
	Source     string // origin; JSON "source"
	Phase      string
	Model      string
	Role       string
	Visibility *Visibility
	Execution  adapter.ExecutionRef
}

// ApplyAttribution merges attribution into a payload map.
// Explicit visibility already present on the map is preserved (emitters win).
func ApplyAttribution(m map[string]any, attr EventAttribution) {
	if m == nil {
		return
	}
	if agent := strings.TrimSpace(attr.Agent); agent != "" {
		m["agent"] = agent
	}
	if speaker := strings.TrimSpace(attr.Speaker); speaker != "" {
		m["speaker"] = speaker
	} else if agent := strings.TrimSpace(attr.Agent); agent != "" {
		m["speaker"] = agent
	}
	if source := strings.TrimSpace(attr.Source); source != "" {
		if _, ok := m["source"]; !ok {
			m["source"] = source
		}
	}
	if phase := strings.TrimSpace(attr.Phase); phase != "" {
		m["phase"] = phase
	}
	if role := strings.TrimSpace(attr.Role); role != "" {
		if _, ok := m["role"]; !ok {
			m["role"] = role
		}
	}
	if model := strings.TrimSpace(attr.Model); model != "" {
		if reported, ok := m["model"].(string); !ok || strings.TrimSpace(reported) == "" {
			m["model"] = model
		}
	}
	if attr.Visibility != nil {
		if _, ok := m["visibility"]; !ok {
			m["visibility"] = map[string]bool{
				"user": attr.Visibility.User,
				"task": attr.Visibility.Task,
			}
		}
	}
	applyExecutionMeta(m, attr.Execution)
}

// MarshalMessage builds a non-partial canonical message payload.
func MarshalMessage(text string, attr EventAttribution) (json.RawMessage, error) {
	role := strings.TrimSpace(attr.Role)
	if role == "" {
		role = "assistant"
	}
	m := map[string]any{
		"role":    role,
		"content": []map[string]string{{"type": "text", "text": text}},
		"partial": false,
	}
	ApplyAttribution(m, attr)
	return json.Marshal(m)
}

func visibilityFromMap(m map[string]any) *Visibility {
	raw, ok := m["visibility"]
	if !ok || raw == nil {
		return nil
	}
	switch v := raw.(type) {
	case map[string]bool:
		out := Visibility{User: v["user"], Task: v["task"]}
		return &out
	case map[string]any:
		out := Visibility{}
		if u, ok := v["user"].(bool); ok {
			out.User = u
		}
		if t, ok := v["task"].(bool); ok {
			out.Task = t
		}
		// Only treat as explicit when at least one flag is a boolean.
		if _, hasU := v["user"].(bool); hasU {
			return &out
		}
		if _, hasT := v["task"].(bool); hasT {
			return &out
		}
	}
	return nil
}
