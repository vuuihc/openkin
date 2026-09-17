// Package worker defines the narrow protocol used by user-owned headless
// workers. Transport is deliberately separate: Relay and direct HTTPS carry
// the same authenticated frames.
package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	ProtocolVersion = 1
	MaxCapabilities = 32
	MaxFeatures     = 32
	MaxFrameBytes   = 1 << 20
)

type Capability struct {
	Name     string   `json:"name"`
	Version  string   `json:"version,omitempty"`
	Features []string `json:"features,omitempty"`
}

type Hello struct {
	Version       int          `json:"version"`
	WorkerID      string       `json:"worker_id"`
	Label         string       `json:"label,omitempty"`
	Capabilities  []Capability `json:"capabilities"`
	MaxConcurrent int          `json:"max_concurrent"`
}

type Lease struct {
	ID        string `json:"lease_id"`
	WorkerID  string `json:"worker_id"`
	IssuedAt  int64  `json:"issued_at"`
	ExpiresAt int64  `json:"expires_at"`
}

type Heartbeat struct {
	LeaseID  string `json:"lease_id"`
	WorkerID string `json:"worker_id"`
	At       int64  `json:"at"`
}

type Assignment struct {
	ID             string `json:"assignment_id"`
	LeaseID        string `json:"lease_id"`
	TaskID         string `json:"task_id"`
	Agent          string `json:"agent"`
	Model          string `json:"model,omitempty"`
	Cwd            string `json:"cwd"`
	Prompt         string `json:"prompt"`
	PermissionMode string `json:"permission_mode,omitempty"`
}

type TaskEvent struct {
	AssignmentID string          `json:"assignment_id"`
	TaskID       string          `json:"task_id"`
	Type         string          `json:"type"`
	Payload      json.RawMessage `json:"payload,omitempty"`
	Seq          int             `json:"seq"`
}

type Artifact struct {
	AssignmentID string `json:"assignment_id"`
	TaskID       string `json:"task_id"`
	ID           string `json:"artifact_id"`
	Name         string `json:"name"`
	Mime         string `json:"mime,omitempty"`
	Size         int64  `json:"size"`
	SHA256       string `json:"sha256"`
	Body         []byte `json:"body,omitempty"`
}

type Frame struct {
	Version int             `json:"version"`
	Kind    string          `json:"kind"`
	Data    json.RawMessage `json:"data,omitempty"`
}

var allowedFrameKinds = map[string]bool{
	"hello": true, "lease": true, "heartbeat": true, "assignment": true,
	"event": true, "artifact": true, "cancel": true, "ack": true,
	"error": true,
}

func (h Hello) Validate() error {
	if h.Version != ProtocolVersion {
		return fmt.Errorf("unsupported worker protocol version %d", h.Version)
	}
	if len(strings.TrimSpace(h.WorkerID)) > 128 {
		return errors.New("worker_id exceeds 128 characters")
	}
	if len(h.Capabilities) == 0 || len(h.Capabilities) > MaxCapabilities {
		return errors.New("capabilities must contain 1 to 32 entries")
	}
	if h.MaxConcurrent < 1 || h.MaxConcurrent > 256 {
		return errors.New("max_concurrent must be between 1 and 256")
	}
	seen := make(map[string]struct{}, len(h.Capabilities))
	for i, c := range h.Capabilities {
		name := strings.TrimSpace(c.Name)
		if name == "" || len(name) > 128 {
			return fmt.Errorf("capabilities[%d].name is invalid", i)
		}
		if _, ok := seen[name]; ok {
			return fmt.Errorf("duplicate capability %q", name)
		}
		seen[name] = struct{}{}
		if len(c.Features) > MaxFeatures {
			return fmt.Errorf("capabilities[%d] has too many features", i)
		}
		for j, feature := range c.Features {
			if strings.TrimSpace(feature) == "" || len(feature) > 128 {
				return fmt.Errorf("capabilities[%d].features[%d] is invalid", i, j)
			}
		}
	}
	return nil
}

func (h Heartbeat) Validate() error {
	if strings.TrimSpace(h.WorkerID) == "" || len(h.WorkerID) > 128 {
		return errors.New("worker_id is required")
	}
	if strings.TrimSpace(h.LeaseID) == "" || len(h.LeaseID) > 128 {
		return errors.New("lease_id is required")
	}
	if h.At <= 0 {
		return errors.New("heartbeat timestamp is required")
	}
	return nil
}

func (a Assignment) Validate() error {
	for name, value := range map[string]string{
		"assignment_id": a.ID, "lease_id": a.LeaseID, "task_id": a.TaskID,
		"agent": a.Agent, "cwd": a.Cwd, "prompt": a.Prompt,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if len(a.Prompt) > 1<<20 {
		return errors.New("prompt exceeds 1 MiB")
	}
	return nil
}

func (f Frame) Validate() error {
	if f.Version != ProtocolVersion {
		return fmt.Errorf("unsupported worker protocol version %d", f.Version)
	}
	if !allowedFrameKinds[f.Kind] {
		return fmt.Errorf("unsupported worker frame kind %q", f.Kind)
	}
	if len(f.Data) > MaxFrameBytes {
		return errors.New("worker frame exceeds limit")
	}
	return nil
}

func NewFrame(kind string, data any) (Frame, error) {
	if !allowedFrameKinds[kind] {
		return Frame{}, fmt.Errorf("unsupported worker frame kind %q", kind)
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return Frame{}, fmt.Errorf("encode worker frame: %w", err)
	}
	f := Frame{Version: ProtocolVersion, Kind: kind, Data: raw}
	if err := f.Validate(); err != nil {
		return Frame{}, err
	}
	return f, nil
}
