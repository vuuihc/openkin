package adapter

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// WorkspaceAccess describes how a turn accesses the workspace.
type WorkspaceAccess string

const (
	AccessPendingIsolation WorkspaceAccess = "pending_isolation"
	AccessSourceReadOnly   WorkspaceAccess = "source_read_only"
	AccessWritable         WorkspaceAccess = "writable"
	AccessShared           WorkspaceAccess = "shared"
)

// RunMetadata carries generation-aware run context.
type RunMetadata struct {
	WorkspaceID     string          `json:"workspace_id,omitempty"`
	WorkspaceAccess WorkspaceAccess `json:"workspace_access"`
	Generation      int             `json:"generation,omitempty"`
}

// CanonicalRepoPath normalizes a reported file path into a clean,
// slash-separated repository-relative path. Absolute inputs must be contained
// by root; relative inputs are interpreted relative to executionCwd and then
// prefixed by the normalized scope. Returns an error for traversal, symlink
// escapes, or empty paths.
func CanonicalRepoPath(root, executionCwd, scope, reportedPath string) (string, error) {
	reportedPath = strings.TrimSpace(reportedPath)
	if reportedPath == "" {
		return "", fmt.Errorf("empty path")
	}

	cleanRoot := filepath.Clean(root)
	cleanScope := filepath.Clean(strings.TrimSpace(scope))
	if cleanScope == "." {
		cleanScope = ""
	}

	var abs string
	if filepath.IsAbs(reportedPath) {
		abs = filepath.Clean(reportedPath)
	} else {
		cwd := filepath.Clean(executionCwd)
		if cwd == "." {
			cwd = cleanRoot
		}
		abs = filepath.Clean(filepath.Join(cwd, reportedPath))
	}

	// Containment check: abs must be inside root.
	rel, err := filepath.Rel(cleanRoot, abs)
	if err != nil || strings.HasPrefix(rel, "..") || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes repository root: %s", reportedPath)
	}

	// Prepend scope for relative inputs.
	if !filepath.IsAbs(reportedPath) && cleanScope != "" {
		rel = filepath.Join(cleanScope, rel)
	}

	// Normalize to slash-separated.
	rel = filepath.ToSlash(rel)
	if rel == "." || rel == "" {
		return "", fmt.Errorf("path resolves to root")
	}

	return rel, nil
}

// WithCwdValidation returns an Adapter that validates spec.Cwd is a directory
// before delegating to next. If cwd is missing or not a directory, Start
// returns an error without calling next.Start.
func WithCwdValidation(next Adapter) Adapter {
	if next == nil {
		return nil
	}
	return &cwdValidator{next: next}
}

type cwdValidator struct {
	next Adapter
}

func (v *cwdValidator) Start(ctx context.Context, spec TaskSpec) (RunHandle, error) {
	if fi, err := os.Stat(spec.Cwd); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("task execution directory is unavailable: %s", spec.Cwd)
	}
	return v.next.Start(ctx, spec)
}
