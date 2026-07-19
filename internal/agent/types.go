// Package agent defines the pluggable agent plugin contracts and registry.
// task.Engine is the trusted execution kernel; this package owns plugin
// metadata, readiness, run adapters, optional control-plane completion,
// and session lifecycle hooks.
package agent

import (
	"context"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
)

// Capability describes what a plugin may do.
type Capability string

const (
	CapabilityRun         Capability = "run"
	CapabilityResume      Capability = "resume"
	CapabilityTools       Capability = "tools"
	CapabilityApprovals   Capability = "approvals"
	CapabilityOrchestrate Capability = "orchestrate"
)

// Kind classifies how the agent is implemented.
type Kind string

const (
	KindBuiltin Kind = "builtin"
	KindCLI     Kind = "cli"
)

// Descriptor is static plugin metadata.
type Descriptor struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Kind         Kind         `json:"kind"`
	Priority     int          `json:"-"`
	Capabilities []Capability `json:"capabilities"`
}

// Has reports whether the descriptor declares cap.
func (d Descriptor) Has(cap Capability) bool {
	for _, got := range d.Capabilities {
		if got == cap {
			return true
		}
	}
	return false
}

// Status is live readiness for a plugin.
type Status struct {
	Installed bool   `json:"installed"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	Binary    string `json:"binary,omitempty"`
}

// ControlPurpose selects a control-plane completion mode.
type ControlPurpose string

const (
	ControlPlan      ControlPurpose = "orchestration_plan"
	ControlSynthesis ControlPurpose = "orchestration_synthesis"
)

// ControlRequest is a read-only control-plane call.
type ControlRequest struct {
	TaskID  string
	Cwd     string
	Model   string
	Purpose ControlPurpose
	Prompt  string
	Timeout time.Duration
}

// ControlUsage is token/cost accounting for a control-plane call.
type ControlUsage struct {
	Model        string
	TokensIn     int
	TokensOut    int
	CachedTokens int
	CostUSD      *float64
}

// ControlResult is the text and usage from a control-plane call.
type ControlResult struct {
	Text  string
	Usage ControlUsage
}

// Controller is a read-only control-plane completion API.
// It may propose a plan or write a summary, but cannot execute tools
// or change task permissions.
type Controller interface {
	Complete(ctx context.Context, req ControlRequest) (ControlResult, error)
}

// SessionHooks manages plugin-private session state (e.g. Kin transcript).
type SessionHooks interface {
	Reset(ctx context.Context, taskID string) error
}

// Registration is one opened plugin instance.
type Registration struct {
	Descriptor Descriptor
	Runner     adapter.Adapter
	Controller Controller
	Sessions   SessionHooks
	Status     func(context.Context) Status
}

// Factory constructs a Registration for a built-in agent plugin.
type Factory interface {
	Descriptor() Descriptor
	Open(ctx context.Context) (Registration, error)
}

// Info is the API-safe combination of descriptor, status, and default flag.
type Info struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Kind         Kind         `json:"kind"`
	Capabilities []Capability `json:"capabilities"`
	Installed    bool         `json:"installed"`
	Available    bool         `json:"available"`
	Reason       string       `json:"reason,omitempty"`
	Binary       string       `json:"binary,omitempty"`
	Default      bool         `json:"default"`
}
