package task

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
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
		ws, err = e.ensureWorkspace(ctx, req)
		if err != nil {
			return store.WorkspaceGeneration{}, fmt.Errorf("ensure workspace: %w", err)
		}
	}
	unlock := lockWorkspaceGeneration(e.workspace, workspaceGenerationMetadata(ws))
	defer unlock()
	ws, err = e.store.GetWorkspace(ctx, ws.ID)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("refresh workspace: %w", err)
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
	unlock := lockWorkspaceGeneration(e.workspace, workspaceGenerationMetadata(ws))
	defer unlock()
	ws, err = e.store.GetWorkspace(ctx, ws.ID)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("refresh current workspace: %w", err)
	}
	// If already finalizing/integrated/released with same execution ID, return existing result.
	if ws.CompletedExecutionID == req.ExecutionID {
		switch ws.State {
		case store.WorkspaceFinalizing, store.WorkspaceIntegrated, store.WorkspaceReleased:
			return ws, nil
		}
	}
	task, err := e.store.GetTask(ctx, req.TaskID)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("refresh task: %w", err)
	}
	if task.Status != StatusRunning {
		return store.WorkspaceGeneration{}, fmt.Errorf(
			"%w: task status %s cannot complete workspace",
			ErrConflict,
			task.Status,
		)
	}
	if ws.RequestedExecutionID != "" && ws.RequestedExecutionID != req.ExecutionID {
		return store.WorkspaceGeneration{}, fmt.Errorf(
			"%w: execution %s does not own workspace %s",
			ErrConflict,
			req.ExecutionID,
			ws.ID,
		)
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
	empty := ""
	transition := store.WorkspaceTransition{
		WorkspaceID: ws.ID,
		TaskID:      req.TaskID,
		FromStates:  []store.WorkspaceState{ws.State},
		ToState:     store.WorkspaceFinalizing,
		Patch: store.WorkspacePatch{
			CompletedExecutionID: &completedExecID,
			ReviewBaseOID:        &empty,
			FinalHeadOID:         &empty,
			FinalTreeOID:         &empty,
			IntegratedOID:        &empty,
			FailureReason:        &empty,
		},
	}
	updated, err := e.transitionWorkspace(ctx, transition)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("finalize workspace: %w", err)
	}

	return updated, nil
}

// ensureWorkspace is the shared provision path for both MCP requests and
// eager pre-run. It creates a new workspace generation or returns the existing one.
func (e *Engine) ensureWorkspace(ctx context.Context, req WorkspaceIntentRequest) (store.WorkspaceGeneration, error) {
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

	if e.workspace == nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("workspace runtime not available")
	}
	source, err := e.workspace.ResolveSource(ctx, t.Cwd)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("resolve workspace source: %w", err)
	}

	now := time.Now().UnixMilli()
	ws = store.WorkspaceGeneration{
		ID:                    req.TaskID + fmt.Sprintf(":g%d", nextGen),
		TaskID:                req.TaskID,
		Generation:            nextGen,
		State:                 store.WorkspaceProvisioning,
		SourceRoot:            source.SourceRoot,
		Scope:                 source.Scope,
		TargetBranch:          source.TargetBranch,
		BaseOID:               source.HeadOID,
		RequestedExecutionID:  req.ExecutionID,
		RequestedUserEventSeq: e.latestUserMessageSeq(ctx, req.TaskID),
		CreatedAt:             now,
		UpdatedAt:             now,
	}

	if ws.Scope == "" {
		ws.Scope = "."
	}
	if strings.TrimSpace(ws.TargetBranch) == "" {
		return store.WorkspaceGeneration{}, fmt.Errorf("source repository is in detached HEAD; writable workspace requires a target branch")
	}

	ev, err := e.store.InsertWorkspaceAsCurrent(ctx, ws)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("insert workspace: %w", err)
	}
	e.bus.PublishEvent(ev)

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
	storedCheckpoint := storeCheckpoint(cp)
	storedCheckpoint.WorkspaceID = ws.ID
	updated, ev, err := e.store.CompleteWorkspaceProvisioning(ctx, store.WorkspaceReadyTransition{
		WorkspaceID:           ws.ID,
		TaskID:                t.ID,
		PhysicalRoot:          meta.Root,
		ExecutionCwd:          meta.Cwd,
		WorkspaceBranch:       meta.Branch,
		BaseOID:               meta.BaseOID,
		RequestedUserEventSeq: ws.RequestedUserEventSeq,
	}, storedCheckpoint)
	if err != nil {
		_ = e.workspace.Release(ctx, meta)
		return store.WorkspaceGeneration{}, fmt.Errorf("transition to ready: %w", err)
	}
	e.bus.PublishEvent(ev)

	return updated, nil
}

func (e *Engine) transitionWorkspace(ctx context.Context, transition store.WorkspaceTransition) (store.WorkspaceGeneration, error) {
	ws, ev, err := e.store.ApplyWorkspaceTransition(ctx, transition)
	if err != nil {
		return store.WorkspaceGeneration{}, err
	}
	e.bus.PublishEvent(ev)
	return ws, nil
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
	if err := e.store.RepairCurrentWorkspacePointers(ctx); err != nil {
		return err
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

		meta := workspaceGenerationMetadata(ws)

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
					_, _ = e.transitionWorkspace(ctx, transition)
				} else {
					transition := store.WorkspaceTransition{
						WorkspaceID: ws.ID,
						TaskID:      t.ID,
						FromStates:  []store.WorkspaceState{store.WorkspaceLegacyPending},
						ToState:     store.WorkspaceOrphaned,
					}
					_, _ = e.transitionWorkspace(ctx, transition)
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
				_, _ = e.transitionWorkspace(ctx, transition)
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
					_, _ = e.transitionWorkspace(ctx, transition)
				}
			}

		case store.WorkspaceFinalizing:
			if t.Status == StatusCanceled {
				reason := "task canceled before workspace integration"
				_, _ = e.transitionWorkspace(ctx, store.WorkspaceTransition{
					WorkspaceID: ws.ID,
					TaskID:      t.ID,
					FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
					ToState:     store.WorkspaceFinalizeBlocked,
					Patch: store.WorkspacePatch{
						FailureReason:        &reason,
						CompletedExecutionID: strPtr(""),
					},
				})
				continue
			}
			// Resume finalization
			status, finalizeErr := e.finalizeWorkspace(ctx, t.ID)
			e.mu.Lock()
			delete(e.workspaceCommitting, t.ID)
			e.mu.Unlock()
			if finalizeErr == nil {
				if _, finishErr := e.finish(ctx, t.ID, status, nil, nil); finishErr != nil {
					return fmt.Errorf("finish recovered task %s: %w", t.ID, finishErr)
				}
			}

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
				if _, err := e.transitionWorkspace(ctx, transition); err == nil &&
					t.Status != StatusSucceeded && t.Status != StatusCanceled {
					if _, finishErr := e.finish(ctx, t.ID, StatusSucceeded, nil, nil); finishErr != nil {
						return fmt.Errorf("finish integrated task %s: %w", t.ID, finishErr)
					}
				}
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
					_, _ = e.transitionWorkspace(ctx, transition)
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

	meta := workspaceGenerationMetadata(ws)
	unlock := lockWorkspaceGeneration(e.workspace, meta)
	defer unlock()
	ws, err = e.store.GetWorkspace(ctx, ws.ID)
	if err != nil {
		return StatusFailed, fmt.Errorf("refresh current workspace: %w", err)
	}
	if ws.State != store.WorkspaceFinalizing {
		return StatusFailed, fmt.Errorf("workspace %s is in state %s, expected finalizing", ws.ID, ws.State)
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
		_, _ = e.transitionWorkspace(ctx, transition)
		return StatusFailed, fmt.Errorf("inspect finalizable: %w", err)
	}

	// Step 2: Inspect integration target. Preserve an already-persisted review
	// base so a restart after the fast-forward cannot rewrite history.
	sourceHead, err := e.workspace.InspectIntegrationTarget(ctx, meta, ws.TargetBranch)
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
		_, _ = e.transitionWorkspace(ctx, transition)
		return StatusFailed, fmt.Errorf("inspect integration target: %w", err)
	}

	// Step 3: Persist final snapshot OIDs while still finalizing
	finalHead, finalTree, reviewBase := ws.FinalHeadOID, ws.FinalTreeOID, ws.ReviewBaseOID
	if finalHead == "" {
		finalHead = insp.HeadOID
	}
	if finalTree == "" {
		finalTree = insp.TreeOID
	}
	if reviewBase == "" {
		reviewBase = sourceHead
	}
	if insp.HeadOID != finalHead || insp.TreeOID != finalTree {
		reason := "workspace changed after final snapshot"
		_, _ = e.transitionWorkspace(ctx, store.WorkspaceTransition{
			WorkspaceID: ws.ID,
			TaskID:      taskID,
			FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
			ToState:     store.WorkspaceFinalizeBlocked,
			Patch: store.WorkspacePatch{
				FailureReason:        &reason,
				CompletedExecutionID: strPtr(""),
			},
		})
		return StatusFailed, errors.New(reason)
	}
	var transition store.WorkspaceTransition
	if ws.FinalHeadOID == "" || ws.FinalTreeOID == "" || ws.ReviewBaseOID == "" {
		transition = store.WorkspaceTransition{
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
		if _, err = e.transitionWorkspace(ctx, transition); err != nil {
			return StatusFailed, fmt.Errorf("persist final snapshot: %w", err)
		}
	}

	e.mu.Lock()
	canceled := e.canceled[taskID]
	if !canceled {
		if e.workspaceCommitting[taskID] == "" {
			owner := e.activeRuns[taskID]
			if owner == "" {
				owner = "recovery"
			}
			e.workspaceCommitting[taskID] = owner
		}
	}
	e.mu.Unlock()
	if canceled {
		reason := "canceled during finalization"
		transition = store.WorkspaceTransition{
			WorkspaceID: ws.ID,
			TaskID:      taskID,
			FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
			ToState:     store.WorkspaceFinalizeBlocked,
			Patch: store.WorkspacePatch{
				FailureReason:        &reason,
				CompletedExecutionID: strPtr(""),
			},
		}
		_, _ = e.transitionWorkspace(ctx, transition)
		return StatusCanceled, nil
	}

	// Step 4: Fast-forward merge. If the source already equals the persisted
	// final head, or contains it as an ancestor, the prior process committed
	// the merge before it crashed.
	integratedOID := finalHead
	alreadyIntegrated := ws.FinalHeadOID != "" && sourceHead == finalHead
	if ws.FinalHeadOID != "" && !alreadyIntegrated {
		alreadyIntegrated, err = e.workspace.IsAncestor(ctx, meta, finalHead, sourceHead)
		if err != nil {
			reason := err.Error()
			_, _ = e.transitionWorkspace(ctx, store.WorkspaceTransition{
				WorkspaceID: ws.ID,
				TaskID:      taskID,
				FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
				ToState:     store.WorkspaceFinalizeBlocked,
				Patch: store.WorkspacePatch{
					FailureReason:        &reason,
					CompletedExecutionID: strPtr(""),
				},
			})
			return StatusFailed, fmt.Errorf("inspect integrated workspace: %w", err)
		}
	}
	if !alreadyIntegrated {
		integratedOID, err = e.workspace.FastForward(ctx, meta, ws.TargetBranch, reviewBase, finalHead)
	}
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
			_, _ = e.transitionWorkspace(ctx, transition)
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
		_, _ = e.transitionWorkspace(ctx, transition)
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
	_, err = e.transitionWorkspace(ctx, transition)
	if err != nil {
		return StatusFailed, fmt.Errorf("transition to integrated: %w", err)
	}

	// Step 6: Release physical worktree
	if err := e.workspace.Release(ctx, meta); err != nil {
		return StatusFailed, fmt.Errorf("release workspace: %w", err)
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
	_, err = e.transitionWorkspace(ctx, transition)
	if err != nil {
		return StatusFailed, fmt.Errorf("transition to released: %w", err)
	}

	return StatusSucceeded, nil
}

type workspaceGenerationLocker interface {
	LockGeneration(meta workspace.Metadata) func()
}

func lockWorkspaceGeneration(runtime WorkspaceRuntime, meta workspace.Metadata) func() {
	if locker, ok := runtime.(workspaceGenerationLocker); ok {
		return locker.LockGeneration(meta)
	}
	return func() {}
}

func strPtr(s string) *string {
	return &s
}
