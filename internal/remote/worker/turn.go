package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Turn frames (ADR 0022 §6.1). A turn is one adapter run: the Hub decides that
// a task runs on a device, the device runs its local agent, and everything the
// agent says comes back up the same authenticated channel that carried the
// dispatch.
//
// The payloads here carry no credentials. A Node runs with the machine's own
// agent logins and provider keys, which never leave it (ADR 0022 D7), so a
// dispatch describes *what to run*, never *what to run it with*.

// Bounds on one dispatch. Prompts are the only large field, and a prompt that
// does not fit in a frame is a prompt the Hub cannot deliver at all.
const (
	MaxTurnID     = 128
	MaxTaskID     = 128
	MaxAgentID    = 128
	MaxSessionRef = 512
	MaxCwd        = 4096
	MaxPrompt     = 256 << 10
	MaxTurnSeq    = 1 << 20
)

// Turn statuses reported by turn.finish.
const (
	TurnOK       = "ok"
	TurnError    = "error"
	TurnCanceled = "canceled"
)

// Dispatch asks a Node to run one turn with one of its agents.
//
// SessionRef is the *Node's* own reference for this conversation, opaque to the
// Hub: the Hub stores whatever the device reports and hands it back on the next
// turn, which is what makes a follow-up resume the same agent session.
// Cwd is a path on the Node's filesystem, checked there against the roots that
// machine agreed to work in; the Hub cannot know another machine's layout.
type Dispatch struct {
	TurnID         string `json:"turn_id"`
	TaskID         string `json:"task_id"`
	Agent          string `json:"agent"`
	Model          string `json:"model,omitempty"`
	Cwd            string `json:"cwd,omitempty"`
	Prompt         string `json:"prompt"`
	SessionRef     string `json:"session_ref,omitempty"`
	PermissionMode string `json:"permission_mode,omitempty"`
}

// TurnEvent is one adapter event on its way up. Seq is local to the turn and
// starts at 1: the Hub is the only thing that allocates a global order, and a
// Node that had to agree on one would have to be reachable to do it.
type TurnEvent struct {
	TurnID string          `json:"turn_id"`
	Seq    int             `json:"seq"`
	Event  json.RawMessage `json:"event"`
}

// TurnFinish ends a turn. It is the only frame that says how it ended, so a
// Node that dies without sending one leaves the Hub to conclude the turn
// itself (M2.4).
type TurnFinish struct {
	TurnID string `json:"turn_id"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// TurnCancel asks a Node to stop a turn it is running.
type TurnCancel struct {
	TurnID string `json:"turn_id"`
	Reason string `json:"reason,omitempty"`
}

func (d Dispatch) Validate() error {
	if err := bounded("turn_id", d.TurnID, MaxTurnID); err != nil {
		return err
	}
	if err := bounded("task_id", d.TaskID, MaxTaskID); err != nil {
		return err
	}
	if err := bounded("agent", d.Agent, MaxAgentID); err != nil {
		return err
	}
	if strings.TrimSpace(d.Prompt) == "" {
		return errors.New("dispatch has no prompt")
	}
	if len(d.Prompt) > MaxPrompt {
		return fmt.Errorf("dispatch prompt exceeds %d bytes", MaxPrompt)
	}
	if err := optional("model", d.Model, MaxAgentID); err != nil {
		return err
	}
	if err := optional("session_ref", d.SessionRef, MaxSessionRef); err != nil {
		return err
	}
	if err := optional("permission_mode", d.PermissionMode, 64); err != nil {
		return err
	}
	if len(d.Cwd) > MaxCwd {
		return fmt.Errorf("dispatch cwd exceeds %d bytes", MaxCwd)
	}
	return nil
}

func (e TurnEvent) Validate() error {
	if err := bounded("turn_id", e.TurnID, MaxTurnID); err != nil {
		return err
	}
	if e.Seq < 1 || e.Seq > MaxTurnSeq {
		return fmt.Errorf("turn event seq %d is out of range", e.Seq)
	}
	if len(e.Event) == 0 {
		return errors.New("turn event has no payload")
	}
	return nil
}

func (f TurnFinish) Validate() error {
	if err := bounded("turn_id", f.TurnID, MaxTurnID); err != nil {
		return err
	}
	switch f.Status {
	case TurnOK, TurnError, TurnCanceled:
	default:
		return fmt.Errorf("unknown turn status %q", f.Status)
	}
	if len(f.Error) > 4096 {
		return errors.New("turn finish error exceeds 4096 bytes")
	}
	return nil
}

func (c TurnCancel) Validate() error {
	if err := bounded("turn_id", c.TurnID, MaxTurnID); err != nil {
		return err
	}
	if len(c.Reason) > 512 {
		return errors.New("turn cancel reason exceeds 512 bytes")
	}
	return nil
}

// bounded checks a required identifier.
func bounded(field, value string, limit int) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Errorf("%s is required", field)
	}
	if len(trimmed) > limit {
		return fmt.Errorf("%s exceeds %d characters", field, limit)
	}
	return nil
}

// optional checks a field that may be absent but not oversized.
func optional(field, value string, limit int) error {
	if len(value) > limit {
		return fmt.Errorf("%s exceeds %d characters", field, limit)
	}
	return nil
}
