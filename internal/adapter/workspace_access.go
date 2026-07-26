package adapter

import (
	"context"
	"fmt"
	"os"
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
	WorkspaceID    string          `json:"workspace_id,omitempty"`
	WorkspaceAccess WorkspaceAccess `json:"workspace_access"`
	Generation     int             `json:"generation,omitempty"`
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
