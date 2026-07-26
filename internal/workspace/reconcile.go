package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// ReconcileOutcome describes the result of reconciling a workspace generation.
type ReconcileOutcome string

const (
	ReconcileCompleted      ReconcileOutcome = "completed"
	ReconcileOrphaned       ReconcileOutcome = "orphaned"
	ReconcileResumeRequest  ReconcileOutcome = "resume_request"
	ReconcileAlreadyRemoved ReconcileOutcome = "already_removed"
)

// ReconcileReport summarizes reconciliation results.
type ReconcileReport struct {
	Outcome  ReconcileOutcome
	State    string
	TaskID   string
	WSID     string
	Message  string
}

// ReconcileWorkspace checks a workspace generation's physical state and
// determines what action is needed:
//
//   - If the workspace is in 'active' state but the worktree is missing, mark
//     it as orphaned.
//   - If the workspace is in 'finalizing' state, attempt to complete
//     finalization.
//   - If the workspace is in 'ready' state, request resume.
//   - If the workspace is already 'released' or 'integrated', nothing to do.
func (m *Manager) ReconcileWorkspace(ctx context.Context, meta Metadata, state string, wsID string, taskID string) (ReconcileReport, error) {
	if m == nil {
		return ReconcileReport{}, fmt.Errorf("workspace manager is nil")
	}

	switch state {
	case "active":
		// Check if worktree still exists
		if meta.Root != "" {
			if _, err := os.Stat(meta.Root); os.IsNotExist(err) {
				return ReconcileReport{
					Outcome: ReconcileOrphaned,
					State:   "orphaned",
					TaskID:  taskID,
					WSID:    wsID,
					Message: "worktree missing, marked as orphaned",
				}, nil
			}
		}

		return ReconcileReport{
			Outcome: ReconcileResumeRequest,
			State:   "active",
			TaskID:  taskID,
			WSID:    wsID,
			Message: "active workspace present, resume available",
		}, nil

	case "finalizing":
		// Check if worktree still exists
		if meta.Root != "" {
			if _, err := os.Stat(meta.Root); os.IsNotExist(err) {
				return ReconcileReport{
					Outcome: ReconcileOrphaned,
					State:   "orphaned",
					TaskID:  taskID,
					WSID:    wsID,
					Message: "finalizing workspace missing worktree, marked as orphaned",
				}, nil
			}

			// Check if workspace has uncommitted changes
			if m.git != nil {
				out, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit,
					"-c", "core.hooksPath="+m.emptyHooksDir(), "status", "--porcelain")
				if err == nil && len(out) == 0 {
					// Clean and finalizing → can complete
					return ReconcileReport{
						Outcome: ReconcileCompleted,
						State:   "ready_for_finalize",
						TaskID:  taskID,
						WSID:    wsID,
						Message: "finalizing workspace is clean, ready for finalization",
					}, nil
				}
			}
		}

		return ReconcileReport{
			Outcome: ReconcileResumeRequest,
			State:   "finalizing",
			TaskID:  taskID,
			WSID:    wsID,
			Message: "finalizing workspace with changes, resume to complete",
		}, nil

	case "integrated", "released":
		// Clean up stale worktree if it exists
		if meta.Root != "" {
			_ = os.RemoveAll(meta.Root)
		}
		// Clean up checkpoint objects
		cpDir := filepath.Join(m.stateDir, "checkpoints", taskID)
		_ = os.RemoveAll(cpDir)

		return ReconcileReport{
			Outcome: ReconcileAlreadyRemoved,
			State:   state,
			TaskID:  taskID,
			WSID:    wsID,
			Message: "already finalized, cleaned up any remaining files",
		}, nil

	default:
		return ReconcileReport{
			Outcome: ReconcileResumeRequest,
			State:   state,
			TaskID:  taskID,
			WSID:    wsID,
			Message: fmt.Sprintf("workspace in state %s, needs review", state),
		}, nil
	}
}
