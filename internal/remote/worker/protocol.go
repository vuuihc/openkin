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
	MaxRootPath     = 4096
	MaxRemoteURL    = 2048
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
	Version        int             `json:"version"`
	WorkerID       string          `json:"worker_id"`
	Label          string          `json:"label,omitempty"`
	Platform       string          `json:"platform,omitempty"`
	Arch           string          `json:"arch,omitempty"`
	KinVersion     string          `json:"kin_version,omitempty"`
	Agents         []Agent         `json:"agents"`
	WorkspaceRoots []WorkspaceRoot `json:"workspace_roots,omitempty"`
	MaxConcurrent  int             `json:"max_concurrent"`
}

// WorkspaceRoot is one directory a Node agreed to work in, and the repository
// identity of the checkout it sits in when it has one.
//
// Path is the checkout root when the directory is inside a repository, and
// RelativePath then says where inside that checkout the declared root is. When
// RemoteURL is empty the directory is only itself: it resolves on this machine
// and nowhere else.
//
// The identity travels; the path does not. That is the whole point of sending
// these upward: the Hub stores which repository each machine has and where,
// so it can hand a turn the address of the workspace *on the machine that will
// run it* rather than the address someone typed while looking at another one
// (ADR 0022 D3, D6). RemoteURL is canonical and credential-free — see
// workspace.CanonicalRemote.
type WorkspaceRoot struct {
	Path         string `json:"path"`
	RemoteURL    string `json:"remote_url,omitempty"`
	RelativePath string `json:"relative_path,omitempty"`
}

// RootPath is the directory this root names on the machine that reported it:
// the checkout, plus the path inside it when the machine works in a
// subdirectory of the repository.
//
// It is what a console shows and what a user recognizes. The Hub stores the
// checkout and the relative path separately, because that is what lets it put
// the workspace back together on a machine with a different layout.
func (r WorkspaceRoot) RootPath() string {
	absPath := strings.TrimRight(strings.TrimSpace(r.Path), "/\\")
	relative := strings.Trim(strings.TrimSpace(r.RelativePath), "/\\")
	if relative == "" || relative == "." {
		return absPath
	}
	sep := "/"
	if strings.Contains(absPath, `\`) && !strings.Contains(absPath, "/") {
		sep = `\`
		relative = strings.ReplaceAll(relative, "/", `\`)
	}
	return absPath + sep + relative
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
// turn traffic (see turn.go); the third is a turn's permission question (see
// approval.go). `assignment`, `event`, the old `cancel`, and the lease/ack
// bookkeeping nothing ever sent are gone: a kind that is registered but never
// constructed is how `turn.started` came to be constructed but not registered,
// and the two mistakes hid each other.
//
// TestEveryFrameKindRoundTrips holds this map and the sample payloads together,
// so a kind cannot be added here without also being proved to survive the
// envelope.
var allowedFrameKinds = map[string]bool{
	"hello": true, "hello_ack": true, "heartbeat": true, "error": true,
	"turn.dispatch": true, "turn.event": true, "turn.started": true,
	"turn.finish": true, "turn.cancel": true,
	"approval.request": true, "approval.status": true, "approval.decision": true,
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
	for i, root := range h.WorkspaceRoots {
		if err := root.Validate(); err != nil {
			return fmt.Errorf("workspace_roots[%d]: %w", i, err)
		}
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

func (r WorkspaceRoot) Validate() error {
	path := strings.TrimSpace(r.Path)
	if path == "" {
		return errors.New("path is required")
	}
	if len(path) > MaxRootPath {
		return fmt.Errorf("path exceeds %d bytes", MaxRootPath)
	}
	if !isAbsNodePath(path) {
		return fmt.Errorf("path %q is not absolute", path)
	}
	if len(r.RelativePath) > MaxRootPath {
		return fmt.Errorf("relative_path exceeds %d bytes", MaxRootPath)
	}
	if rel := strings.TrimSpace(r.RelativePath); rel != "" {
		if isAbsNodePath(rel) {
			return fmt.Errorf("relative_path %q is absolute", rel)
		}
		// A path inside a checkout that names its way out of the checkout is not
		// a path inside it. The Hub stores this and resolves it on other machines
		// without ever seeing the directory, so the check has to be on the text:
		// normalize the separators, then refuse any ".." segment.
		for _, segment := range strings.Split(strings.ReplaceAll(rel, `\`, "/"), "/") {
			if segment == ".." {
				return fmt.Errorf("relative_path %q escapes the checkout", rel)
			}
		}
	}
	if len(r.RemoteURL) > MaxRemoteURL {
		return fmt.Errorf("remote_url exceeds %d bytes", MaxRemoteURL)
	}
	if remote := strings.TrimSpace(r.RemoteURL); remote != "" {
		// The Hub stores this and every other device reads it, so it has to be
		// canonical already: a URL that still carries a credential must never
		// reach the database (ADR 0022 D7).
		// A query or fragment is where a credential would hide, and a canonical
		// remote is the one string every device reads (ADR 0022 D7). The leading
		// and trailing slash are here too: the Hub's own check refuses them, and a
		// hello that only fails once it reaches the store gets the whole machine
		// refused for one bad root.
		if strings.ContainsAny(remote, "@\\ \t\n?#") || strings.Contains(remote, "://") ||
			strings.HasPrefix(remote, "/") || strings.HasSuffix(remote, "/") {
			return fmt.Errorf("remote_url %q is not canonical", remote)
		}
	}
	return nil
}

// isAbsNodePath reports whether a path is absolute on the machine that sent it.
//
// The Hub is not necessarily the same operating system as the Node — a Linux
// Hub dispatches to a macOS laptop — so this cannot be filepath.IsAbs, which
// answers for the machine doing the asking.
func isAbsNodePath(path string) bool {
	switch {
	case strings.HasPrefix(path, "/"):
		return true
	case strings.HasPrefix(path, `\\`):
		return true
	case len(path) >= 3 && path[1] == ':' && (path[2] == '/' || path[2] == '\\'):
		return true
	default:
		return false
	}
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
