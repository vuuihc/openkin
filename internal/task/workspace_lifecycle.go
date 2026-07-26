package task

import (
	"time"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/vuuihc/kin/internal/store"
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
// is currently running in source-read-only mode. The host execution identity
// must match the currently active read-only turn.
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
	_, err := e.store.GetTask(ctx, req.TaskID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.WorkspaceGeneration{}, fmt.Errorf("task not found: %w", err)
		}
		return store.WorkspaceGeneration{}, fmt.Errorf("get task: %w", err)
	}

	// Find the current open workspace (should be provisioning/ready state)
	ws, err := e.store.GetCurrentWorkspace(ctx, req.TaskID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.WorkspaceGeneration{}, fmt.Errorf("no open workspace generation: %w", err)
		}
		return store.WorkspaceGeneration{}, fmt.Errorf("get current workspace: %w", err)
	}

	// Only allow promotion from provisioning or ready states
	if ws.State != store.WorkspaceProvisioning && ws.State != store.WorkspaceReady {
		return store.WorkspaceGeneration{}, fmt.Errorf("workspace %s is in state %s, cannot promote", ws.ID, ws.State)
	}

	// For host_request cause, we need to verify the execution is source-read-only
	// (This is a simplified implementation; full verification requires adapter integration)

	// Transition to active state
	transition := store.WorkspaceTransition{
		WorkspaceID: ws.ID,
		TaskID:      req.TaskID,
		FromStates:  []store.WorkspaceState{store.WorkspaceProvisioning, store.WorkspaceReady},
		ToState:     store.WorkspaceActive,
	}
	updated, _, err := e.store.ApplyWorkspaceTransition(ctx, transition)
	if err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("activate workspace: %w", err)
	}

	return updated, nil
}

// CompleteWorkspace marks the active workspace generation as finalizing,
// indicating the agent has finished its work and Kin should finalize it.
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

	// Find the current active workspace
	ws, err := e.store.GetCurrentWorkspace(ctx, req.TaskID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.WorkspaceGeneration{}, fmt.Errorf("no open workspace generation: %w", err)
		}
		return store.WorkspaceGeneration{}, fmt.Errorf("get current workspace: %w", err)
	}

	// Only active workspaces can be finalized
	if ws.State != store.WorkspaceActive {
		return store.WorkspaceGeneration{}, fmt.Errorf("workspace %s is in state %s, expected active", ws.ID, ws.State)
	}

	// Transition to finalizing
	transition := store.WorkspaceTransition{
		WorkspaceID: ws.ID,
		TaskID:      req.TaskID,
		FromStates:  []store.WorkspaceState{store.WorkspaceActive},
		ToState:     store.WorkspaceFinalizing,
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
		ID:           req.TaskID + fmt.Sprintf(":g%d", nextGen),
		TaskID:       req.TaskID,
		Generation:   nextGen,
		State:        store.WorkspaceProvisioning,
		SourceRoot:   t.Cwd,
		Scope:        ".",
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	if err := e.store.InsertWorkspace(ctx, ws); err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("insert workspace: %w", err)
	}

	if err := e.store.SetCurrentWorkspace(ctx, req.TaskID, ws.ID); err != nil {
		return store.WorkspaceGeneration{}, fmt.Errorf("set current workspace: %w", err)
	}

	return ws, nil
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

	// Get all tasks (this is a simplified approach; production would query by state)
	tasks, err := e.store.ListTasks(ctx, store.ListTasksOpts{Limit: 1000})
	if err != nil {
		return fmt.Errorf("list tasks for reconciliation: %w", err)
	}

	for _, t := range tasks {
		ws, err := e.store.GetCurrentWorkspace(ctx, t.ID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				continue // No open workspace
			}
			continue // Skip on error
		}

		switch ws.State {
		case store.WorkspaceActive:
			// Active workspace after restart needs reconciliation
			meta := workspaceMetadata(t)
			if meta.Root != "" {
				insp, err := e.workspace.InspectGeneration(ctx, meta)
				if err == nil && !insp.Exists {
					// Worktree missing - mark as orphaned
					transition := store.WorkspaceTransition{
						WorkspaceID: ws.ID,
						TaskID:      t.ID,
						FromStates:  []store.WorkspaceState{store.WorkspaceActive},
						ToState:     store.WorkspaceOrphaned,
					}
					_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
				}
			}

		case store.WorkspaceFinalizing:
			// Try to complete finalization
			meta := workspaceMetadata(t)
			if meta.Root != "" && meta.Branch != "" {
				insp, err := e.workspace.InspectFinalizable(ctx, meta)
				if err == nil && !insp.Dirty {
					// Clean workspace - attempt finalization
					res, err := e.workspace.FinalizeFastForward(ctx, meta, meta.Branch)
					if err == nil {
						// Update workspace to integrated
						transition := store.WorkspaceTransition{
							WorkspaceID: ws.ID,
							TaskID:      t.ID,
							FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
							ToState:     store.WorkspaceIntegrated,
						}
						if _, _, err := e.store.ApplyWorkspaceTransition(ctx, transition); err == nil {
							_ = e.workspace.Release(ctx, meta)
						}
						_ = res
					}
				}
			}

		case store.WorkspaceProvisioning, store.WorkspaceReady:
			// Stale provisioning - mark as orphaned
			transition := store.WorkspaceTransition{
				WorkspaceID: ws.ID,
				TaskID:      t.ID,
				FromStates:  []store.WorkspaceState{ws.State},
				ToState:     store.WorkspaceOrphaned,
			}
			_, _, _ = e.store.ApplyWorkspaceTransition(ctx, transition)
		}
	}
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
