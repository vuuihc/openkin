package agent

import (
	"context"
	"errors"
	"time"
)

var ErrSessionCatalogUnavailable = errors.New("session catalog unavailable")

const (
	CapabilitySessionList          Capability = "session_list"
	CapabilitySessionInspect       Capability = "session_inspect"
	CapabilitySessionHistoryRead   Capability = "session_history_read"
	CapabilitySessionAttach        Capability = "session_attach"
	CapabilitySessionContextExport Capability = "session_context_export"
)

// SessionQuery bounds a provider-owned session discovery request.
type SessionQuery struct {
	Cursor string
	Limit  int
	Query  string
	Cwd    string
}

// SessionInfo is the API-safe metadata for one provider-owned session.
// ExternalRef is opaque and must be namespaced by AgentID.
type SessionInfo struct {
	AgentID       string
	ExternalRef   string
	SourceURI     string
	Title         string
	Cwd           string
	Status        string
	Capabilities  []Capability
	SourceCursor  string
	ContentDigest string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// HistoryQuery requests a bounded page from a provider-owned history source.
type HistoryQuery struct {
	Cursor string
	Limit  int
}

// HistoryPage is a normalized view over provider-owned history. The page is
// intentionally not a Store model: callers may render it without persisting
// transcript data in Kin.
type HistoryPage struct {
	Items      []HistoryItem
	NextCursor string
	SourceRev  string
}

// HistoryItem is one bounded provider message suitable for UI rendering.
type HistoryItem struct {
	AgentID     string
	ExternalRef string
	MessageID   string
	Kind        string
	Role        string
	ToolName    string
	Text        string
	OccurredAt  time.Time
	SourceRev   string
}

// SessionCatalog is an optional provider integration for discovery and
// read-only history access. Execution and native resume remain on Adapter.
type SessionCatalog interface {
	List(context.Context, SessionQuery) ([]SessionInfo, error)
	Inspect(context.Context, string) (SessionInfo, error)
	ReadHistory(context.Context, string, HistoryQuery) (HistoryPage, error)
}
