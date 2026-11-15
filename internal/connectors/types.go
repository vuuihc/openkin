// Package connectors provides a bounded MCP connector host for local and
// user-owned remote tools.
package connectors

import (
	"context"
	"encoding/json"

	"github.com/vuuihc/openkin/internal/store"
)

const (
	KindStdio = "stdio"
	KindHTTP  = "streamable-http"
)

type Config struct {
	ID            string   `json:"id"`
	Kind          string   `json:"kind"`
	Command       string   `json:"command,omitempty"`
	Args          []string `json:"args,omitempty"`
	URL           string   `json:"url,omitempty"`
	CredentialRef string   `json:"credential_ref,omitempty"`
	AllowTools    []string `json:"allow_tools,omitempty"`
	AllowDomains  []string `json:"allow_domains,omitempty"`
	TimeoutMS     int      `json:"timeout_ms,omitempty"`
	MaxOutput     int      `json:"max_output_bytes,omitempty"`
	Disabled      bool     `json:"disabled,omitempty"`
}

type Tool struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	InputSchema any    `json:"inputSchema,omitempty"`
}

type Call struct {
	ConnectorID string
	TaskID      string
	Principal   string
	Tool        string
	Arguments   map[string]any
}

type Result struct {
	Content   any
	IsError   bool
	LatencyMS int64
}

type Audit struct {
	ConnectorID      string
	TaskID           string
	Principal        string
	Tool             string
	ArgumentsHash    string
	ApprovalDecision string
	Success          bool
	LatencyMS        int64
	Error            string
}

type AuditSink interface {
	RecordConnectorAudit(context.Context, Audit) error
}

// Host is the normalized connector surface exposed to native agent loops.
type Host interface {
	List() []Config
	Tools(context.Context, string) ([]Tool, error)
	Call(context.Context, Call) (Result, error)
}

// AuditFunc adapts a function to AuditSink.
type AuditFunc func(context.Context, Audit) error

func (f AuditFunc) RecordConnectorAudit(ctx context.Context, audit Audit) error {
	return f(ctx, audit)
}

// StoreAuditSink persists connector calls as task events. It deliberately
// reuses the event stream instead of introducing a connector-specific table.
type StoreAuditSink struct {
	Store     *store.Store
	Publisher interface{ PublishEvent(store.Event) }
}

func (s StoreAuditSink) RecordConnectorAudit(ctx context.Context, audit Audit) error {
	if s.Store == nil || audit.TaskID == "" {
		return nil
	}
	payload, err := json.Marshal(map[string]any{
		"result_status":     resultStatus(audit.Success),
		"connector_id":      audit.ConnectorID,
		"tool":              audit.Tool,
		"principal":         audit.Principal,
		"arguments_hash":    audit.ArgumentsHash,
		"approval_decision": audit.ApprovalDecision,
		"latency_ms":        audit.LatencyMS,
		"error":             audit.Error,
		"source":            "connector_host",
	})
	if err != nil {
		return err
	}
	event, err := s.Store.AppendEvent(ctx, audit.TaskID, "connector_call", payload)
	if err != nil {
		return err
	}
	if s.Publisher != nil {
		s.Publisher.PublishEvent(event)
	}
	return nil
}

func resultStatus(success bool) string {
	if success {
		return "success"
	}
	return "error"
}
