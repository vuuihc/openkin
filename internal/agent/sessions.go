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
//
// Cursor pages toward newer messages; Before pages toward older ones. Tail asks
// for the newest page without naming a position at all, which is how a reader
// opens a long transcript at what happened last instead of what happened first.
// A provider that predates these fields may ignore them, which is why callers
// must treat an empty PrevCursor as "this provider cannot page backwards".
type HistoryQuery struct {
	Cursor string
	Before string
	Tail   bool
	Limit  int
}

// HistoryPage is a normalized view over provider-owned history. The page is
// intentionally not a Store model: callers may render it without persisting
// transcript data in Kin.
type HistoryPage struct {
	Items      []HistoryItem
	NextCursor string
	// PrevCursor names the position of the first item in this page: passing it
	// back as Before yields the messages immediately older than this page. It
	// is empty when this page already starts at the beginning of the
	// transcript, so an empty value means "nothing older to load", not "this
	// provider cannot page".
	PrevCursor string
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
	// Cursor is this item's own position in the provider source, in the same
	// vocabulary as HistoryQuery. It travels beside the item rather than in the
	// page so a machine that must trim a page it read can still name where the
	// part it kept begins.
	Cursor string
	// Truncated reports that Text is the beginning of a longer message: the
	// provider's own cap was reached, so the rest of what the agent wrote is not
	// in this item. It is a property of the message rather than of the page — a
	// page with no cursor is a page to stop reading, while a message cut short is
	// a fact about that message that a reader is entitled to.
	Truncated bool
}

// SessionCatalog is an optional provider integration for discovery and
// read-only history access. Execution and native resume remain on Adapter.
type SessionCatalog interface {
	List(context.Context, SessionQuery) ([]SessionInfo, error)
	Inspect(context.Context, string) (SessionInfo, error)
	ReadHistory(context.Context, string, HistoryQuery) (HistoryPage, error)
}
