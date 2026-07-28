package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// WorkspaceProvisionCause identifies the caller of the provision path.
type WorkspaceProvisionCause string

const (
	ProvisionFromHostRequest       WorkspaceProvisionCause = "host_request"
	ProvisionFromEagerPreRun       WorkspaceProvisionCause = "eager_pre_run"
	ProvisionFromOrchestrationPlan WorkspaceProvisionCause = "orchestration_plan"
)

// WorkspaceIntentRequest is the public request body for workspace lifecycle APIs.
type WorkspaceIntentRequest struct {
	TaskID      string `json:"task_id"`
	ExecutionID string `json:"execution_id"`
	Agent       string `json:"agent"`
	Reason      string `json:"reason,omitempty"`
}

// RequestWorkspace creates a new writable workspace generation for a task that
// is currently running in source-read-only mode. It provisions the Git worktree,
// captures a checkpoint, and transitions the generation to ready.
// startOne handles the ready → active promotion before the adapter starts.
//
// Returns the created workspace generation on success.
func (e *Engine) RequestWorkspace(ctx context.Context, req WorkspaceIntentRequest) (store.WorkspaceGeneration, error) {
	if req.TaskID == "" {
		return store.WorkspaceGeneration{}, fmt.Errorf("task_id is required")
	}
	if req.ExecutionID == "" {
		return store.WorkspaceGeneration{}, fmt.Errorf("execution_id is required")
	}

	// Load task and validate state
	t, err := e.store.GetTask(ctx, req.TaskID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.WorkspaceGeneration{}, fmt.Errorf("task not found: %w", err)
		}
		return store.WorkspaceGeneration{}, fmt.Errorf("get task: %w", err)
	}

	// Try to find an existing open workspace; if none, create via ensureWorkspace.
	ws, err := e.store.GetCurrentWorkspace(ctx, req.TaskID)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return store.WorkspaceGeneration{}, fmt.Errorf("get current workspace: %w", err)
		}
		// No workspace yet — create one in provisioning, then do full provisioning.
		ws, err = e.ensureWorkspace(ctx, req, ProvisionFromHostRequest)
		if err != nil {
			return store.WorkspaceGeneration{}, fmt.Errorf("ensure workspace: %w", err)
		}
	}

	// Only allow promotion from provisioning or ready states
	if ws.State != store.WorkspaceProvisioning && ws.State != store.WorkspaceReady {
		return store.WorkspaceGeneration{}, fmt.Errorf("workspace %s is in state %s, cannot promote", ws.ID, ws.State)
	}

	// If still provisioning, do full Git provisioning → ready.
	if ws.State == store.WorkspaceProvisioning {
		ws, err = e.provisionWorkspace(ctx, t, ws)
		if err != nil {
			return store.WorkspaceGeneration{}, fmt.Errorf("provision workspace: %w", err)
		}
	}

	return ws, nil
}

// CompleteWorkspace marks the active workspace generation as finalizing,
// indicating the agent has finished its work and Kin should finalize it.
// Supports active, merge_blocked, and finalize_blocked states.
// A retry with the same execution ID returns the existing result without
// appending a duplicate event; another execution receives 409.
func (e *Engine) CompleteWorkspace(ctx context.Context, req WorkspaceIntentRequest) (store.WorkspaceGeneration, error) {
	if req.TaskID == "" {
		return store.WorkspaceGeneration{}, fmt.Errorf("task_id is required")
	}
	if req.ExecutionID == "" {
		return store.WorkspaceGeneration{}, fmt.Errorf("execution_id is required")
	}

	_, err := e.store.GetTask(ctx, req.TaskID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.WorkspaceGeneration{}, fmt.Errorf("task not found: %w", err)
		}
		return store.WorkspaceGeneration{}, fmt.Errorf("get task: %w", err)
	}

	// Find the current open workspace
	ws, err := e.store.GetCurrentWorkspace(ctx, req.TaskID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.WorkspaceGeneration{}, fmt.Errorf("no open workspace generation: %w", err)
		}
		return store.WorkspaceGeneration{}, fmt.Errorf("get current workspace: %w", err)
	}

	// If already finalizing/integrated/released with same execution ID, return existing result.
	if ws.CompletedExecutionID == req.ExecutionID {
		switch ws.State {
		case store.WorkspaceFinalizing, store.WorkspaceIntegrated, store.WorkspaceReleased:
			return ws, nil
		}
	}

	// If already finalizing with a different execution, reject.
	if ws.State == store.WorkspaceFinalizing && ws.CompletedExecutionID != "" {
		return store.WorkspaceGeneration{}, fmt.Errorf("workspace %s is already finalizing with execution %s", ws.ID, ws.CompletedExecutionID)
	}

	// Only active, merge_blocked, and finalize_blocked workspaces can be finalized.
	switch ws.State {
	case store.WorkspaceActive, store.WorkspaceMergeBlocked, store.WorkspaceFinalizeBlocked:
		// OK
	default:
		return store.WorkspaceGeneration{}, fmt.Errorf("workspace %s is in state %s, expected active/merge_blocked/finalize_blocked", ws.ID, ws.State)
	}

	// Transition to finalizing with completed_execution_id.
	completedExecID := req.ExecutionID
	transition := store.WorkspaceTransition{
		WorkspaceID: ws.ID,
		TaskID:      req.TaskID,
		FromStates:  []store.WorkspaceState{ws.State},
		ToState:     store.WorkspaceFinalizing,
		Patch: store.WorkspacePatch{
			CompletedExecutionID: &completedExecID,
		},
	}
	updated, _, err := e.store.ApplyWorkspaceTransition(ctx, transition)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("finalize workspace: %w", err)
	}

	return updated, nil
}

// ensureWorkspace is the shared provision path for both MCP requests and
// eager pre-run. It creates a new workspace generation or returns the existing one.
func (e *Engine) ensureWorkspace(ctx context.Context, req WorkspaceIntentRequest, cause WorkspaceProvisionCause) (store.WorkspaceGeneration, error) {
	// Try to find an existing open workspace
	ws, err := e.store.GetCurrentWorkspace(ctx, req.TaskID)
	if err == nil {
		// Already has an open workspace
		return ws, nil
	}

	if !errors.Is(err, store.ErrNotFound) {
		return store.WorkspaceGeneration{}, fmt.Errorf("check workspace: %w", err)
	}

	// Need to create a new generation
	t, err := e.store.GetTask(ctx, req.TaskID)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("get task: %w", err)
	}

	// Determine generation number
	list, err := e.store.ListTaskWorkspaces(ctx, req.TaskID)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("list workspaces: %w", err)
	}
	nextGen := len(list) + 1

	now := time.Now().UnixMilli()
	ws = store.WorkspaceGeneration{
		ID:         req.TaskID + fmt.Sprintf(":g%d", nextGen),
		TaskID:     req.TaskID,
		Generation: nextGen,
		State:      store.WorkspaceProvisioning,
		SourceRoot: t.WorkspaceSourceRoot,
		Scope:      t.WorkspaceScope,
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	if t.WorkspaceSourceRoot == "" {
		ws.SourceRoot = t.Cwd
	}
	if ws.Scope == "" {
		ws.Scope = "."
	}

	// Resolve the real Git branch name so finalization can validate it.
	if e.workspace != nil {
		branch, err := e.workspace.CurrentBranch(ctx, ws.SourceRoot)
		if err != nil {
			return store.WorkspaceGeneration{}, fmt.Errorf("resolve target branch: %w", err)
		}
		branch = strings.TrimSpace(branch)
		if branch == "" {
			return store.WorkspaceGeneration{}, fmt.Errorf("source repository is in detached HEAD; writable workspace requires a target branch")
		}
		ws.TargetBranch = branch
	}

	if err := e.store.InsertWorkspace(ctx, ws); err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("insert workspace: %w", err)
	}

	if err := e.store.SetCurrentWorkspace(ctx, req.TaskID, ws.ID); err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("set current workspace: %w", err)
	}

	return ws, nil
}

// provisionWorkspace performs the full Git provisioning for a workspace generation:
// creates the worktree, captures a checkpoint, and transitions to ready.
func (e *Engine) provisionWorkspace(ctx context.Context, t store.Task, ws store.WorkspaceGeneration) (store.WorkspaceGeneration, error) {
	if e.workspace == nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("workspace runtime not available")
	}

	src := workspace.SourceMetadata{
		Cwd:          t.Cwd,
		SourceRoot:   ws.SourceRoot,
		Scope:        ws.Scope,
		TargetBranch: ws.TargetBranch,
		HeadOID:      ws.BaseOID,
	}

	if src.SourceRoot == "" {
		src.SourceRoot = t.Cwd
	}
	if src.Scope == "" {
		src.Scope = "."
	}

	// Create the Git worktree.
	meta, err := e.workspace.PrepareGeneration(ctx, t.ID, ws.Generation, src)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("prepare generation: %w", err)
	}

	// Capture initial checkpoint.
	cp, err := e.workspace.CapturePrepared(ctx, meta, t.ID)
	if err != nil {
		// Clean up on failure.
		_ = e.workspace.Release(ctx, meta)
		return store.WorkspaceGeneration{}, fmt.Errorf("capture checkpoint: %w", err)
	}
	_ = cp

	// Transition to ready with physical metadata.
	transition := store.WorkspaceTransition{
		WorkspaceID: ws.ID,
		TaskID:      t.ID,
		FromStates:  []store.WorkspaceState{store.WorkspaceProvisioning},
		ToState:     store.WorkspaceReady,
		Patch: store.WorkspacePatch{
			PhysicalRoot:    &meta.Root,
			ExecutionCwd:    &meta.Cwd,
			WorkspaceBranch: &meta.Branch,
			BaseOID:         &meta.BaseOID,
		},
	}
	updated, _, err := e.store.ApplyWorkspaceTransition(ctx, transition)
	if err != nil {
		_ = e.workspace.Release(ctx, meta)
		return store.WorkspaceGeneration{}, fmt.Errorf("transition to ready: %w", err)
	}

	return updated, nil
}

// JSON helpers for workspace event payloads
func workspaceEventPayload(wsID string) json.RawMessage {
	b, _ := json.Marshal(map[string]string{"workspace_id": wsID})
	return b
}

// CheckWorkspaceEventType checks if an event matches the expected workspace transition type.
// reconcileWorkspaces checks all tasks with open workspace generations
// after daemon restart and reconciles their physical state.
func (e *Engine) reconcileWorkspaces(ctx context.Context) error {
	if e.store == nil {
		return nil
	}
	if e.workspace == nil {
		return nil // No workspace runtime available
	}

	tasks, err := e.store.ListTasks(ctx, store.ListTasksOpts{Limit: 1000})
	if err != nil {
		return fmt.Errorf("list tasks for reconciliation: %w", err)
	}

	for _, t := range tasks {
		ws, err := e.store.GetCurrentWorkspace(ctx, t.ID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				continue
			}
			continue
		}

		meta := workspaceMetadata(t)

		switch ws.State {
		case store.WorkspaceLegacyPending:
			// Inspect path; set active or orphaned
			if meta.Root != "" {
				insp, err := e.workspace.InspectGeneration(ctx, meta)
				if err == nil && insp.Exists {
					transition := store.WorkspaceTransition{
						WorkspaceID: ws.ID,
						TaskID:      t.ID,
						FromStates:  []store.WorkspaceState{store.WorkspaceLegacyPending},
						ToState:     store.WorkspaceActive,
					}
					_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
				} else {
					transition := store.WorkspaceTransition{
						WorkspaceID: ws.ID,
						TaskID:      t.ID,
						FromStates:  []store.WorkspaceState{store.WorkspaceLegacyPending},
						ToState:     store.WorkspaceOrphaned,
					}
					_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
				}
			}

		case store.WorkspaceProvisioning:
			// Finish provisioning or mark orphaned
			_, err := e.provisionWorkspace(ctx, t, ws)
			if err != nil {
				reason := err.Error()
				transition := store.WorkspaceTransition{
					WorkspaceID: ws.ID,
					TaskID:      t.ID,
					FromStates:  []store.WorkspaceState{store.WorkspaceProvisioning},
					ToState:     store.WorkspaceOrphaned,
					Patch: store.WorkspacePatch{
						FailureReason: &reason,
					},
				}
				_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
			}

		case store.WorkspaceReady:
			// Queue the task for resume
			e.mu.Lock()
			e.queue = append(e.queue, t.ID)
			e.mu.Unlock()

		case store.WorkspaceActive:
			// Verify worktree exists
			if meta.Root != "" {
				insp, err := e.workspace.InspectGeneration(ctx, meta)
				if err == nil && !insp.Exists {
					transition := store.WorkspaceTransition{
						WorkspaceID: ws.ID,
						TaskID:      t.ID,
						FromStates:  []store.WorkspaceState{store.WorkspaceActive},
						ToState:     store.WorkspaceOrphaned,
					}
					_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
					_ = e.store.ClearCurrentWorkspace(ctx, t.ID, ws.ID)
				}
			}

		case store.WorkspaceFinalizing:
			// Resume finalization
			_, _ = e.finalizeWorkspace(ctx, t.ID)

		case store.WorkspaceIntegrated:
			// Retry release
			if err := e.workspace.Release(ctx, meta); err == nil {
				now := store.NowMilli()
				transition := store.WorkspaceTransition{
					WorkspaceID: ws.ID,
					TaskID:      t.ID,
					FromStates:  []store.WorkspaceState{store.WorkspaceIntegrated},
					ToState:     store.WorkspaceReleased,
					Patch: store.WorkspacePatch{
						ReleasedAt: &now,
					},
				}
				_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
				_ = e.store.ClearCurrentWorkspace(ctx, t.ID, ws.ID)
			}

		case store.WorkspaceMergeBlocked, store.WorkspaceFinalizeBlocked:
			// Verify worktree and keep the conversation usable
			if meta.Root != "" {
				insp, err := e.workspace.InspectGeneration(ctx, meta)
				if err == nil && !insp.Exists {
					transition := store.WorkspaceTransition{
						WorkspaceID: ws.ID,
						TaskID:      t.ID,
						FromStates:  []store.WorkspaceState{ws.State},
						ToState:     store.WorkspaceOrphaned,
					}
					_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
					_ = e.store.ClearCurrentWorkspace(ctx, t.ID, ws.ID)
				}
			}

		case store.WorkspaceReleased:
			// Best-effort cleanup of residue
			if meta.Root != "" {
				_ = e.workspace.ReleaseAndPrune(ctx, meta, t.ID)
			}
			_ = e.store.ClearCurrentWorkspace(ctx, t.ID, ws.ID)
		}
	}

	// Pump any queued tasks
	e.pump()
	return nil
}

// FinalizeWorkspace marks a workspace as integrated and releases it.
func (e *Engine) FinalizeWorkspace(ctx context.Context, taskID, wsID string) (store.WorkspaceGeneration, error) {
	// Transition to integrated
	transition := store.WorkspaceTransition{
		WorkspaceID: wsID,
		TaskID:      taskID,
		FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
		ToState:     store.WorkspaceIntegrated,
	}
	ws, _, err := e.store.ApplyWorkspaceTransition(ctx, transition)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("integrate workspace: %w", err)
	}

	// Release the physical worktree if runtime is available
	if e.workspace != nil {
		t, err := e.store.GetTask(ctx, taskID)
		if err == nil {
			meta := workspaceMetadata(t)
			_ = e.workspace.Release(ctx, meta)
		}
	}

	return ws, nil
}

// ReleaseWorkspace transitions a workspace to released state and cleans up.
func (e *Engine) ReleaseWorkspace(ctx context.Context, taskID, wsID string) (store.WorkspaceGeneration, error) {
	// Transition to released
	transition := store.WorkspaceTransition{
		WorkspaceID: wsID,
		TaskID:      taskID,
		FromStates:  []store.WorkspaceState{store.WorkspaceIntegrated, store.WorkspaceFinalizing},
		ToState:     store.WorkspaceReleased,
	}
	ws, _, err := e.store.ApplyWorkspaceTransition(ctx, transition)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("release workspace: %w", err)
	}

	// Clean up current workspace pointer
	_ = e.store.ClearCurrentWorkspace(ctx, taskID, wsID)

	// Release physical resources
	if e.workspace != nil {
		t, err := e.store.GetTask(ctx, taskID)
		if err == nil {
			meta := workspaceMetadata(t)
			_ = e.workspace.ReleaseAndPrune(ctx, meta, taskID)
		}
	}

	return ws, nil
}

func CheckWorkspaceEventType(ev store.Event, expectedType string) bool {
	return ev.Type == expectedType
}

// finalizeWorkspace runs the full finalization pipeline for a workspace in
// finalizing state. It inspects, snapshots, fast-forwards, integrates, and
// releases the workspace. Returns the final task status and any error.
func (e *Engine) finalizeWorkspace(ctx context.Context, taskID string) (string, error) {
	if e.workspace == nil {
		return StatusFailed, fmt.Errorf("workspace runtime not available")
	}

	ws, err := e.store.GetCurrentWorkspace(ctx, taskID)
	if err != nil {
		return StatusFailed, fmt.Errorf("get current workspace: %w", err)
	}

	if ws.State != store.WorkspaceFinalizing {
		return StatusFailed, fmt.Errorf("workspace %s is in state %s, expected finalizing", ws.ID, ws.State)
	}

	t, err := e.store.GetTask(ctx, taskID)
	if err != nil {
		return StatusFailed, fmt.Errorf("get task: %w", err)
	}

	// Build metadata from the generation, not the task, so finalization
	// uses the generation's physical root and execution cwd.
	meta := workspace.Metadata{
		Mode:       workspace.ResolvedWorktree,
		SourceRoot: ws.SourceRoot,
		Root:       ws.PhysicalRoot,
		Cwd:        ws.ExecutionCwd,
		Scope:      ws.Scope,
		BaseOID:    ws.BaseOID,
		Branch:     ws.WorkspaceBranch,
	}

	// Step 1: Inspect finalizable workspace
	insp, err := e.workspace.InspectFinalizable(ctx, meta)
	if err != nil {
		// Transition to finalize_blocked
		reason := err.Error()
		transition := store.WorkspaceTransition{
			WorkspaceID: ws.ID,
			TaskID:      taskID,
			FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
			ToState:     store.WorkspaceFinalizeBlocked,
			Patch: store.WorkspacePatch{
				FailureReason:        &reason,
				CompletedExecutionID: strPtr(""),
			},
		}
		_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
		return StatusFailed, fmt.Errorf("inspect finalizable: %w", err)
	}

	// Step 2: Inspect integration target
	reviewBase, err := e.workspace.InspectIntegrationTarget(ctx, meta, ws.TargetBranch)
	if err != nil {
		// If source is dirty or on wrong branch, block finalization
		reason := err.Error()
		transition := store.WorkspaceTransition{
			WorkspaceID: ws.ID,
			TaskID:      taskID,
			FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
			ToState:     store.WorkspaceFinalizeBlocked,
			Patch: store.WorkspacePatch{
				FailureReason:        &reason,
				CompletedExecutionID: strPtr(""),
			},
		}
		_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
		return StatusFailed, fmt.Errorf("inspect integration target: %w", err)
	}

	// Step 3: Persist final snapshot OIDs while still finalizing
	finalHead := insp.HeadOID
	finalTree := insp.TreeOID
	transition := store.WorkspaceTransition{
		WorkspaceID: ws.ID,
		TaskID:      taskID,
		FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
		ToState:     store.WorkspaceFinalizing,
		Patch: store.WorkspacePatch{
			FinalHeadOID:  &finalHead,
			FinalTreeOID:  &finalTree,
			ReviewBaseOID: &reviewBase,
		},
	}
	_, _, err = e.store.ApplyWorkspaceTransition(ctx, transition)
	if err != nil {
		return StatusFailed, fmt.Errorf("persist final snapshot: %w", err)
	}

	// Step 4: Fast-forward merge
	integratedOID, err := e.workspace.FastForward(ctx, meta, t.WorkspaceScope, reviewBase, finalHead)
	if err != nil {
		// Check if target advanced (non-ff) vs other failure
		if strings.Contains(err.Error(), "not fast-forward") || strings.Contains(err.Error(), "not ancestor") {
			// Target advanced: merge_blocked
			reason := err.Error()
			transition := store.WorkspaceTransition{
				WorkspaceID: ws.ID,
				TaskID:      taskID,
				FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
				ToState:     store.WorkspaceMergeBlocked,
				Patch: store.WorkspacePatch{
					FailureReason:        &reason,
					CompletedExecutionID: strPtr(""),
				},
			}
			_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
			return StatusFailed, fmt.Errorf("merge blocked: %w", err)
		}
		// Other failure: finalize_blocked
		reason := err.Error()
		transition := store.WorkspaceTransition{
			WorkspaceID: ws.ID,
			TaskID:      taskID,
			FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
			ToState:     store.WorkspaceFinalizeBlocked,
			Patch: store.WorkspacePatch{
				FailureReason:        &reason,
				CompletedExecutionID: strPtr(""),
			},
		}
		_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
		return StatusFailed, fmt.Errorf("fast-forward: %w", err)
	}

	// Step 5: Transition to integrated
	now := store.NowMilli()
	transition = store.WorkspaceTransition{
		WorkspaceID: ws.ID,
		TaskID:      taskID,
		FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
		ToState:     store.WorkspaceIntegrated,
		Patch: store.WorkspacePatch{
			IntegratedOID: &integratedOID,
			IntegratedAt:  &now,
		},
	}
	_, _, err = e.store.ApplyWorkspaceTransition(ctx, transition)
	if err != nil {
		return StatusFailed, fmt.Errorf("transition to integrated: %w", err)
	}

	// Step 6: Release physical worktree
	if err := e.workspace.Release(ctx, meta); err != nil {
		// Non-fatal: release failure doesn't block the task
	}

	// Step 7: Transition to released
	transition = store.WorkspaceTransition{
		WorkspaceID: ws.ID,
		TaskID:      taskID,
		FromStates:  []store.WorkspaceState{store.WorkspaceIntegrated},
		ToState:     store.WorkspaceReleased,
		Patch: store.WorkspacePatch{
			ReleasedAt: &now,
		},
	}
	_, _, err = e.store.ApplyWorkspaceTransition(ctx, transition)
	if err != nil {
		return StatusFailed, fmt.Errorf("transition to released: %w", err)
	}

	// Clear current workspace pointer
	_ = e.store.ClearCurrentWorkspace(ctx, taskID, ws.ID)

	return StatusSucceeded, nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
