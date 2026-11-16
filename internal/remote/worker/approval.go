package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// The vocabulary of a decision, on the wire.
//
// It mirrors the store's, and a test holds the two together: the Hub sends what
// the store recorded, and the device only understands these three. A drift
// between them would fail closed (the device refuses the frame and the agent's
// request errors), but it would fail closed for every approval at once.
const (
	ApprovalApproved = "approved"
	ApprovalDenied   = "denied"
	ApprovalExpired  = "expired"
)

const (
	MaxApprovalID      = 128
	MaxApprovalKind    = 64
	MaxApprovalPayload = 256 << 10
	MaxApprovalAgent   = 128
	MaxApprovalModel   = 256
	MaxApprovalError   = 512
)

// ApprovalRequest is a Node asking its Hub to put a permission question in front
// of a person.
//
// It names the turn the question came from, never the task: which task that turn
// belongs to is something the Hub knows and the device does not get to assert.
// Everything else is what the agent asked for — the tool call, in the same shape
// a local one would have taken — plus the attribution that makes the row in the
// console point at the run that is blocked on it.
//
// Nothing here is a secret. The request is a question, not an answer: no
// credential crosses the wire in either direction (ADR 0022 D7).
type ApprovalRequest struct {
	RequestID string          `json:"request_id"`
	TurnID    string          `json:"turn_id"`
	Kind      string          `json:"kind,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Agent     string          `json:"agent,omitempty"`
	Step      int             `json:"step,omitempty"`
	Model     string          `json:"model,omitempty"`
}

// ApprovalStatus is the Hub's answer to one request: taken, or refused with a
// reason. Exactly one of ApprovalID and Error is set.
//
// It exists because the two halves of the answer arrive at different times. The
// agent's MCP client posts the request with a short timeout and only then starts
// its long poll, so "the Hub has it, and this is its id" cannot wait for a person
// to make up their mind.
type ApprovalStatus struct {
	RequestID  string `json:"request_id"`
	ApprovalID string `json:"approval_id,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ApprovalDecision is how a request that the Hub took ended. It is sent once per
// accepted request, and never for a refused one.
type ApprovalDecision struct {
	RequestID string `json:"request_id"`
	Decision  string `json:"decision"`
}

func (r ApprovalRequest) Validate() error {
	if err := validateApprovalID("request_id", r.RequestID); err != nil {
		return err
	}
	if err := validateApprovalID("turn_id", r.TurnID); err != nil {
		return err
	}
	if len(r.Kind) > MaxApprovalKind {
		return fmt.Errorf("kind exceeds %d characters", MaxApprovalKind)
	}
	if len(r.Payload) > MaxApprovalPayload {
		return fmt.Errorf("payload exceeds %d bytes", MaxApprovalPayload)
	}
	if len(r.Agent) > MaxApprovalAgent {
		return fmt.Errorf("agent exceeds %d characters", MaxApprovalAgent)
	}
	if r.Step < 0 {
		return errors.New("step must be >= 0")
	}
	if len(r.Model) > MaxApprovalModel {
		return fmt.Errorf("model exceeds %d characters", MaxApprovalModel)
	}
	return nil
}

func (s ApprovalStatus) Validate() error {
	if err := validateApprovalID("request_id", s.RequestID); err != nil {
		return err
	}
	if strings.TrimSpace(s.ApprovalID) == "" && strings.TrimSpace(s.Error) == "" {
		return errors.New("status must carry an approval id or a reason")
	}
	if strings.TrimSpace(s.ApprovalID) != "" && strings.TrimSpace(s.Error) != "" {
		return errors.New("status cannot be both accepted and refused")
	}
	if len(s.ApprovalID) > MaxApprovalID {
		return fmt.Errorf("approval_id exceeds %d characters", MaxApprovalID)
	}
	if len(s.Error) > MaxApprovalError {
		return fmt.Errorf("error exceeds %d characters", MaxApprovalError)
	}
	return nil
}

func (d ApprovalDecision) Validate() error {
	if err := validateApprovalID("request_id", d.RequestID); err != nil {
		return err
	}
	switch d.Decision {
	case ApprovalApproved, ApprovalDenied, ApprovalExpired:
		return nil
	default:
		return fmt.Errorf("unsupported decision %q", d.Decision)
	}
}

func validateApprovalID(field, value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s is required", field)
	}
	if len(value) > MaxApprovalID {
		return fmt.Errorf("%s exceeds %d characters", field, MaxApprovalID)
	}
	return nil
}
