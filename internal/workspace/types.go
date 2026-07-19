package workspace

import "errors"

// RequestedMode is the workspace isolation mode supplied by the client.
type RequestedMode string

const (
	ModeAuto     RequestedMode = "auto"
	ModeShared   RequestedMode = "shared"
	ModeWorktree RequestedMode = "worktree"
)

// ResolvedMode is the mode actually applied after probe + policy.
type ResolvedMode string

const (
	ResolvedShared   ResolvedMode = "shared"
	ResolvedWorktree ResolvedMode = "worktree"
)

// ProbeResult describes whether a cwd can host an isolated Git worktree.
type ProbeResult struct {
	Cwd             string `json:"cwd"`
	GitAvailable    bool   `json:"git_available"`
	IsGit           bool   `json:"is_git"`
	IsBare          bool   `json:"is_bare"`
	HasHead         bool   `json:"has_head"`
	Dirty           bool   `json:"dirty"`
	SourceRoot      string `json:"source_root,omitempty"`
	Scope           string `json:"scope,omitempty"`
	HeadOID         string `json:"head_oid,omitempty"`
	CanWorktree     bool   `json:"can_worktree"`
	RecommendedMode string `json:"recommended_mode"`
	Reason          string `json:"reason,omitempty"`
}

// Metadata is the resolved workspace for one task.
type Metadata struct {
	Mode       ResolvedMode
	SourceRoot string
	Root       string
	Cwd        string
	Scope      string
	BaseOID    string
	Branch     string
	Reason     string
}

// Checkpoint is a private turn snapshot (persisted later by the store layer).
type Checkpoint struct {
	TaskID    string
	EventSeq  int
	HeadOID   string
	TreeOID   string
	SizeBytes int64
	CreatedAt int64
}

// EffectiveCwd returns the path agents and file APIs should use.
func (m Metadata) EffectiveCwd(fallback string) string {
	if m.Cwd != "" {
		return m.Cwd
	}
	return fallback
}

// Sentinel errors for workspace isolation and checkpoints.
var (
	ErrGitUnavailable        = errors.New("git unavailable")
	ErrNotGit                = errors.New("not a git repository")
	ErrNoHead                = errors.New("repository has no HEAD")
	ErrBareRepository        = errors.New("bare repository")
	ErrDirtySource           = errors.New("source worktree is dirty")
	ErrInvalidMode           = errors.New("invalid workspace mode")
	ErrNotIsolated           = errors.New("task workspace is not isolated")
	ErrCheckpointUnavailable = errors.New("checkpoint unavailable")
	ErrSnapshotTooLarge      = errors.New("snapshot too large")
	ErrOutputTooLarge        = errors.New("git output too large")
	ErrInvalidTaskID         = errors.New("invalid task id")
	ErrWorktreeExists        = errors.New("worktree path already exists")
)
