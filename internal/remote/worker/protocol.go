// Package worker defines the narrow protocol a Kin Node speaks with its Hub.
//
// A Node is a user-owned machine that runs turns with the agents installed on
// it. It dials out to the Hub (the Hub never dials in), says who it is with
// `hello`, keeps its presence fresh with `heartbeat`, and is handed work over
// the same authenticated frames. Transport is deliberately separate: direct
// WSS and the outbound Relay carry the same frames.
package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	ProtocolVersion = 1
	MaxAgents       = 32
	MaxRoots        = 32
	MaxModels       = 64
	MaxFrameBytes   = 1 << 20
)

// Agent is one agent runtime as the machine that owns it sees it: what is
// installed there, whether it can run right now, and which models it offers.
// It mirrors a `device_agents` row. None of it is secret — provider keys and
// agent logins never leave the device (ADR 0022 D7).
type Agent struct {
	ID           string   `json:"id"`
	Installed    bool     `json:"installed"`
	Available    bool     `json:"available"`
	Version      string   `json:"version,omitempty"`
	Reason       string   `json:"reason,omitempty"`
	DefaultModel string   `json:"default_model,omitempty"`
	Models       []string `json:"models,omitempty"`
	IsDefault    bool     `json:"is_default,omitempty"`
}

// Hello is a Node's opening frame, and the device's own account of itself.
//
// WorkerID is the device id: one daemon runs one Node per machine, and the
// Hub binds the frame to the device credential that carried it.
type Hello struct {
	Version        int      `json:"version"`
	WorkerID       string   `json:"worker_id"`
	Label          string   `json:"label,omitempty"`
	Platform       string   `json:"platform,omitempty"`
	Arch           string   `json:"arch,omitempty"`
	KinVersion     string   `json:"kin_version,omitempty"`
	Agents         []Agent  `json:"agents"`
	WorkspaceRoots []string `json:"workspace_roots,omitempty"`
	MaxConcurrent  int      `json:"max_concurrent"`
}

// HelloAck is the Hub's answer: the protocol version it agreed to and how often
// the Node should check in. A version the Hub does not speak is refused by
// closing with `error` rather than by negotiating down.
type HelloAck struct {
	Version          int   `json:"version"`
	HeartbeatSeconds int   `json:"heartbeat_seconds"`
	HubTime          int64 `json:"hub_time"`
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

type Frame struct {
	Version int             `json:"version"`
	Kind    string          `json:"kind"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// Frame kinds. The first line is the handshake and presence; the second is
// turn traffic (see turn.go). `assignment`, `event` and the old `cancel` are
// gone: nothing ever sent them.
var allowedFrameKinds = map[string]bool{
	"hello": true, "hello_ack": true, "heartbeat": true, "lease": true,
	"ack": true, "error": true,
	"turn.dispatch": true, "turn.event": true, "turn.finish": true, "turn.cancel": true,
}

func (h Hello) Validate() error {
	if h.Version != ProtocolVersion {
		return fmt.Errorf("unsupported worker protocol version %d", h.Version)
	}
	if len(strings.TrimSpace(h.WorkerID)) > 128 {
		return errors.New("worker_id exceeds 128 characters")
	}
	if len(h.Agents) == 0 || len(h.Agents) > MaxAgents {
		return fmt.Errorf("agents must contain 1 to %d entries", MaxAgents)
	}
	if len(h.WorkspaceRoots) > MaxRoots {
		return fmt.Errorf("workspace_roots exceeds %d entries", MaxRoots)
	}
	if h.MaxConcurrent < 1 || h.MaxConcurrent > 256 {
		return errors.New("max_concurrent must be between 1 and 256")
	}
	seen := make(map[string]struct{}, len(h.Agents))
	for i, agent := range h.Agents {
		id := strings.TrimSpace(agent.ID)
		if id == "" || len(id) > 128 {
			return fmt.Errorf("agents[%d].id is invalid", i)
		}
		if _, ok := seen[id]; ok {
			return fmt.Errorf("duplicate agent %q", id)
		}
		seen[id] = struct{}{}
		if len(agent.Reason) > 512 {
			return fmt.Errorf("agents[%d].reason is too long", i)
		}
		if len(agent.Models) > MaxModels {
			return fmt.Errorf("agents[%d] has too many models", i)
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

func (a HelloAck) Validate() error {
	if a.Version != ProtocolVersion {
		return fmt.Errorf("unsupported worker protocol version %d", a.Version)
	}
	if a.HeartbeatSeconds < 1 || a.HeartbeatSeconds > 600 {
		return errors.New("heartbeat_seconds must be between 1 and 600")
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
