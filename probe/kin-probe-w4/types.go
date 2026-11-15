package main

import "encoding/json"

// Wire types used by the probe. They mirror only the fields this client reads;
// the contract marks several objects as open, so unknown fields are ignored.

type PairingSessionResponse struct {
	Secret    string `json:"secret"`
	ExpiresAt int64  `json:"expires_at"`
}

type PairingExchangeRequest struct {
	Secret string `json:"secret"`
	Label  string `json:"label,omitempty"`
}

type PairingExchangeResponse struct {
	DeviceID    string `json:"device_id"`
	Token       string `json:"token"`
	Label       string `json:"label"`
	DesktopID   string `json:"desktop_id"`
	DesktopName string `json:"desktop_name"`
}

type CursorResponse struct {
	Cursor int64 `json:"cursor"`
}

type SessionChangePage struct {
	Sessions   []Task   `json:"sessions"`
	Deleted    []string `json:"deleted"`
	NextCursor int64    `json:"next_cursor"`
	HasMore    bool     `json:"has_more"`
}

type Task struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Agent          string `json:"agent"`
	Cwd            string `json:"cwd"`
	Prompt         string `json:"prompt"`
	Status         string `json:"status"`
	EventEpoch     int64  `json:"event_epoch"`
	HubSeq         *int64 `json:"hub_seq"`
	ArchivedAt     int64  `json:"archived_at"`
	CreatedAt      int64  `json:"created_at"`
	StartedAt      int64  `json:"started_at"`
	FinishedAt     int64  `json:"finished_at"`
	ProjectID      string `json:"project_id"`
	SessionRef     string `json:"session_ref"`
	PermissionMode string `json:"permission_mode"`
	TokensIn       int64  `json:"tokens_in"`
	TokensOut      int64  `json:"tokens_out"`
	WorkspaceID    string `json:"current_workspace_id"`
}

type TaskEvent struct {
	TaskID     string          `json:"task_id"`
	EventEpoch int64           `json:"event_epoch"`
	Seq        int64           `json:"seq"`
	Ts         int64           `json:"ts"`
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
}

type WSMessage struct {
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
}

type Approval struct {
	ID        string          `json:"id"`
	TaskID    string          `json:"task_id"`
	Kind      string          `json:"kind"`
	Decision  string          `json:"decision"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt int64           `json:"created_at"`
	DecidedAt int64           `json:"decided_at"`
}

type AgentInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Installed bool   `json:"installed"`
	Available bool   `json:"available"`
	Default   bool   `json:"default"`
	Reason    string `json:"reason"`
}

type CreateTaskRequest struct {
	Agent   string `json:"agent,omitempty"`
	Cwd     string `json:"cwd"`
	Prompt  string `json:"prompt"`
	Title   string `json:"title,omitempty"`
	Model   string `json:"model,omitempty"`
	Project string `json:"project_id,omitempty"`
}

type FollowUpRequest struct {
	Prompt    string `json:"prompt"`
	Interrupt bool   `json:"interrupt,omitempty"`
}

type ApprovalDecisionRequest struct {
	Decision string `json:"decision"`
}

type AuthStatus struct {
	NeedsBootstrap bool  `json:"needs_bootstrap"`
	Claimable      bool  `json:"claimable"`
	Authenticated  bool  `json:"authenticated"`
	Providers      []any `json:"providers"`
}
