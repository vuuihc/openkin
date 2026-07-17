// Package adapter defines the agent-process interface (spec §4).
// Concrete adapters land in later milestones; M0 only ships the types.
package adapter

import (
	"context"
	"encoding/json"
)

// Adapter launches an agent process for a task.
type Adapter interface {
	// Start launches the agent process for a task and returns a handle.
	Start(ctx context.Context, spec TaskSpec) (RunHandle, error)
}

// RunHandle is a running agent process.
type RunHandle interface {
	Events() <-chan Event // closed when the process exits
	Cancel() error        // SIGTERM, then SIGKILL after 5s
}

// Event is a structured update from an agent run.
type Event struct {
	Type    string          // task_started | message | tool_use | approval_requested | usage | result | raw_output | error
	Payload json.RawMessage
}

// TaskSpec describes a task to start. Fields mirror the tasks table / API.
// Populated fully in M1+; defined here so the interface type-checks.
type TaskSpec struct {
	ID             string
	Agent          string
	Cwd            string
	Prompt         string
	Model          string
	SessionRef     string // non-empty → resume
	PermissionMode string // default | accept_edits | yolo (see Permission* constants)
}
