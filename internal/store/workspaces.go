package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// WorkspacePolicy determines how a task workspace is allocated.
type WorkspacePolicy string

const (
	WorkspacePolicyAuto     WorkspacePolicy = "auto"
	WorkspacePolicyShared   WorkspacePolicy = "shared"
	WorkspacePolicyWorktree WorkspacePolicy = "worktree"
)

// WorkspaceState is the lifecycle state of a generation.
type WorkspaceState string

const (
	WorkspaceProvisioning    WorkspaceState = "provisioning"
	WorkspaceReady           WorkspaceState = "ready"
	WorkspaceActive          WorkspaceState = "active"
	WorkspaceFinalizing      WorkspaceState = "finalizing"
	WorkspaceIntegrated      WorkspaceState = "integrated"
	WorkspaceReleased        WorkspaceState = "released"
	WorkspaceMergeBlocked    WorkspaceState = "merge_blocked"
	WorkspaceFinalizeBlocked WorkspaceState = "finalize_blocked"
	WorkspaceOrphaned        WorkspaceState = "orphaned"
	WorkspaceLegacyPending   WorkspaceState = "legacy_pending"
)

// WorkspaceGeneration represents a single workspace generation for a task.
type WorkspaceGeneration struct {
	ID                    string         `json:"id"`
	TaskID                string         `json:"task_id"`
	Generation            int            `json:"generation"`
	State                 WorkspaceState `json:"state"`
	SourceRoot            string         `json:"source_root"`
	Scope                 string         `json:"scope"`
	TargetBranch          string         `json:"target_branch,omitempty"`
	WorkspaceBranch       string         `json:"workspace_branch,omitempty"`
	PhysicalRoot          string         `json:"physical_root,omitempty"`
	ExecutionCwd          string         `json:"execution_cwd,omitempty"`
	BaseOID               string         `json:"base_oid,omitempty"`
	ReviewBaseOID         string         `json:"review_base_oid,omitempty"`
	FinalHeadOID          string         `json:"final_head_oid,omitempty"`
	FinalTreeOID          string         `json:"final_tree_oid,omitempty"`
	IntegratedOID         string         `json:"integrated_oid,omitempty"`
	RequestedExecutionID  string         `json:"requested_execution_id,omitempty"`
	RequestedUserEventSeq int            `json:"requested_user_event_seq,omitempty"`
	CompletedExecutionID  string         `json:"completed_execution_id,omitempty"`
	FailureReason         string         `json:"failure_reason,omitempty"`
	CreatedAt             int64          `json:"created_at"`
	UpdatedAt             int64          `json:"updated_at"`
	IntegratedAt          *int64         `json:"integrated_at,omitempty"`
	ReleasedAt            *int64         `json:"released_at,omitempty"`
}

// TaskTurnWorkspace binds a user turn to a workspace generation and access level.
type TaskTurnWorkspace struct {
	TaskID       string  `json:"task_id"`
	UserEventSeq int     `json:"user_event_seq"`
	WorkspaceID  *string `json:"workspace_id,omitempty"`
	Access       string  `json:"access"` // pending_isolation, source_read_only, writable, shared
	CreatedAt    int64   `json:"created_at"`
	UpdatedAt    int64   `json:"updated_at"`
}

// WorkspacePatch groups optional fields for a workspace state transition.
type WorkspacePatch struct {
	PhysicalRoot         *string
	ExecutionCwd         *string
	WorkspaceBranch      *string
	BaseOID              *string
	ReviewBaseOID        *string
	FinalHeadOID         *string
	FinalTreeOID         *string
	IntegratedOID        *string
	CompletedExecutionID *string
	FailureReason        *string
	IntegratedAt         *int64
	ReleasedAt           *int64
}

// WorkspaceEvent is a lifecycle event entry.
type WorkspaceEvent struct {
	Type        string          `json:"type"` // workspace_provisioning, workspace_created, etc.
	WorkspaceID string          `json:"workspace_id"`
	TaskID      string          `json:"task_id"`
	Payload     json.RawMessage `json:"payload,omitempty"`
}

// WorkspaceTransition groups a workspace state change with optional task patch for atomicity.
type WorkspaceTransition struct {
	WorkspaceID string
	TaskID      string
	FromStates  []WorkspaceState
	ToState     WorkspaceState
	Patch       WorkspacePatch
}

// WorkspaceReadyTransition contains data for promote-provisioning→ready transition.
type WorkspaceReadyTransition struct {
	WorkspaceID           string
	TaskID                string
	PhysicalRoot          string
	ExecutionCwd          string
	BaseOID               string
	RequestedUserEventSeq int
}

// InsertWorkspace inserts a new workspace generation.
func (s *Store) InsertWorkspace(ctx context.Context, ws WorkspaceGeneration) error {
	if ws.ID == "" || ws.TaskID == "" {
		return fmt.Errorf("workspace id and task_id required")
	}
	if ws.CreatedAt == 0 {
		ws.CreatedAt = NowMilli()
	}
	if ws.UpdatedAt == 0 {
		ws.UpdatedAt = ws.CreatedAt
	}

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO task_workspaces (
			id, task_id, generation, state, source_root, scope,
			target_branch, workspace_branch, physical_root, execution_cwd,
			base_oid, review_base_oid, final_head_oid, final_tree_oid,
			integrated_oid, requested_execution_id, requested_user_event_seq,
			completed_execution_id, failure_reason, created_at, updated_at,
			integrated_at, released_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		ws.ID, ws.TaskID, ws.Generation, ws.State, ws.SourceRoot, ws.Scope,
		ws.TargetBranch, ws.WorkspaceBranch, ws.PhysicalRoot, ws.ExecutionCwd,
		ws.BaseOID, ws.ReviewBaseOID, ws.FinalHeadOID, ws.FinalTreeOID,
		ws.IntegratedOID, ws.RequestedExecutionID, ws.RequestedUserEventSeq,
		ws.CompletedExecutionID, ws.FailureReason, ws.CreatedAt, ws.UpdatedAt,
		ws.IntegratedAt, ws.ReleasedAt,
	)
	if err != nil {
		return fmt.Errorf("insert workspace: %w", err)
	}
	return nil
}

// GetWorkspace retrieves a workspace by id.
func (s *Store) GetWorkspace(ctx context.Context, id string) (WorkspaceGeneration, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, task_id, generation, state, source_root, scope,
			target_branch, workspace_branch, physical_root, execution_cwd,
			base_oid, review_base_oid, final_head_oid, final_tree_oid,
			integrated_oid, requested_execution_id, requested_user_event_seq,
			completed_execution_id, failure_reason, created_at, updated_at,
			integrated_at, released_at
		FROM task_workspaces WHERE id = ?
	`, id)

	ws, err := scanWorkspace(row)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceGeneration{}, ErrNotFound
	}
	if err != nil {
		return WorkspaceGeneration{}, fmt.Errorf("get workspace: %w", err)
	}
	return ws, nil
}

// GetCurrentWorkspace retrieves the current (open) workspace for a task.
func (s *Store) GetCurrentWorkspace(ctx context.Context, taskID string) (WorkspaceGeneration, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, task_id, generation, state, source_root, scope,
			target_branch, workspace_branch, physical_root, execution_cwd,
			base_oid, review_base_oid, final_head_oid, final_tree_oid,
			integrated_oid, requested_execution_id, requested_user_event_seq,
			completed_execution_id, failure_reason, created_at, updated_at,
			integrated_at, released_at
		FROM task_workspaces
		WHERE task_id = ? AND state IN (
			'provisioning', 'ready', 'active', 'finalizing', 'integrated',
			'merge_blocked', 'finalize_blocked', 'legacy_pending'
		)
	`, taskID)

	ws, err := scanWorkspace(row)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceGeneration{}, ErrNotFound
	}
	if err != nil {
		return WorkspaceGeneration{}, fmt.Errorf("get current workspace: %w", err)
	}
	return ws, nil
}

// ListTaskWorkspaces lists all workspaces for a task, ordered by generation.
func (s *Store) ListTaskWorkspaces(ctx context.Context, taskID string) ([]WorkspaceGeneration, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, task_id, generation, state, source_root, scope,
			target_branch, workspace_branch, physical_root, execution_cwd,
			base_oid, review_base_oid, final_head_oid, final_tree_oid,
			integrated_oid, requested_execution_id, requested_user_event_seq,
			completed_execution_id, failure_reason, created_at, updated_at,
			integrated_at, released_at
		FROM task_workspaces
		WHERE task_id = ?
		ORDER BY generation ASC
	`, taskID)

	if err != nil {
		return nil, fmt.Errorf("list task workspaces: %w", err)
	}
	defer rows.Close()

	var workspaces []WorkspaceGeneration
	for rows.Next() {
		ws, err := scanWorkspace(rows)
		if err != nil {
			return nil, fmt.Errorf("scan workspace: %w", err)
		}
		workspaces = append(workspaces, ws)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return workspaces, nil
}

// TransitionWorkspace atomically transitions a workspace state.
// Returns ErrConflict-like error if current state does not match 'from'.
func (s *Store) TransitionWorkspace(
	ctx context.Context, id string, from []WorkspaceState, toState WorkspaceState,
) (WorkspaceGeneration, error) {
	fromStrs := make([]string, len(from))
	for i, s := range from {
		fromStrs[i] = string(s)
	}

	stateList := "(" + strings.Join(sliceToPlaceholders(len(from)), ",") + ")"
	args := make([]interface{}, 0, len(from)+3)
	args = append(args, string(toState), NowMilli(), id)
	for _, s := range from {
		args = append(args, string(s))
	}

	res, err := s.db.ExecContext(ctx, fmt.Sprintf(`
		UPDATE task_workspaces
		SET state = ?, updated_at = ?
		WHERE id = ? AND state IN %s
	`, stateList), args...)

	if err != nil {
		return WorkspaceGeneration{}, fmt.Errorf("transition workspace: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return WorkspaceGeneration{}, fmt.Errorf("workspace %s not in expected state: %w", id, ErrConflict)
	}
	return s.GetWorkspace(ctx, id)
}

// SetCurrentWorkspace sets the current workspace for a task (idempotent).
func (s *Store) SetCurrentWorkspace(ctx context.Context, taskID, workspaceID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE tasks SET current_workspace_id = ? WHERE id = ?
	`, workspaceID, taskID)
	if err != nil {
		return fmt.Errorf("set current workspace: %w", err)
	}
	return nil
}

// ClearCurrentWorkspace clears the current workspace if it matches workspaceID.
func (s *Store) ClearCurrentWorkspace(ctx context.Context, taskID, workspaceID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE tasks SET current_workspace_id = ''
		WHERE id = ? AND current_workspace_id = ?
	`, taskID, workspaceID)
	if err != nil {
		return fmt.Errorf("clear current workspace: %w", err)
	}
	return nil
}

// AppendUserEventWithTurnWorkspace appends a user event and its associated turn workspace binding.
func (s *Store) AppendUserEventWithTurnWorkspace(
	ctx context.Context, taskID string, payload json.RawMessage, turn TaskTurnWorkspace,
) (Event, TaskTurnWorkspace, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Event{}, TaskTurnWorkspace{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Get next event sequence
	var nextSeq int
	err = tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(seq), 0) + 1
		FROM events WHERE task_id = ?
	`, taskID).Scan(&nextSeq)
	if err != nil {
		return Event{}, TaskTurnWorkspace{}, fmt.Errorf("get next seq: %w", err)
	}

	// Insert event
	now := NowMilli()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO events (task_id, seq, ts, type, payload)
		VALUES (?, ?, ?, ?, ?)
	`, taskID, nextSeq, now, "message", payload)
	if err != nil {
		return Event{}, TaskTurnWorkspace{}, fmt.Errorf("insert event: %w", err)
	}

	// Insert turn workspace
	if turn.CreatedAt == 0 {
		turn.CreatedAt = now
	}
	if turn.UpdatedAt == 0 {
		turn.UpdatedAt = now
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO task_turn_workspaces (task_id, user_event_seq, workspace_id, access, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, taskID, nextSeq, turn.WorkspaceID, turn.Access, turn.CreatedAt, turn.UpdatedAt)
	if err != nil {
		return Event{}, TaskTurnWorkspace{}, fmt.Errorf("insert turn workspace: %w", err)
	}

	turn.TaskID = taskID
	turn.UserEventSeq = nextSeq

	if err := tx.Commit(); err != nil {
		return Event{}, TaskTurnWorkspace{}, fmt.Errorf("commit tx: %w", err)
	}

	return Event{
		TaskID:  taskID,
		Seq:     nextSeq,
		Type:    "message",
		TS:      now,
		Payload: payload,
	}, turn, nil
}

// GetTurnWorkspace retrieves the workspace binding for a user turn.
func (s *Store) GetTurnWorkspace(ctx context.Context, taskID string, userEventSeq int) (TaskTurnWorkspace, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT task_id, user_event_seq, workspace_id, access, created_at, updated_at
		FROM task_turn_workspaces
		WHERE task_id = ? AND user_event_seq = ?
	`, taskID, userEventSeq)

	var t TaskTurnWorkspace
	var wsID sql.NullString
	err := row.Scan(&t.TaskID, &t.UserEventSeq, &wsID, &t.Access, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskTurnWorkspace{}, ErrNotFound
	}
	if err != nil {
		return TaskTurnWorkspace{}, fmt.Errorf("get turn workspace: %w", err)
	}
	if wsID.Valid {
		t.WorkspaceID = &wsID.String
	}
	return t, nil
}

// GetCheckpointForWorkspace retrieves a checkpoint bound to a specific workspace.
func (s *Store) GetCheckpointForWorkspace(
	ctx context.Context, taskID string, eventSeq int, workspaceID string,
) (TaskCheckpoint, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT task_id, event_seq, head_oid, tree_oid, size_bytes, created_at, workspace_id
		FROM task_checkpoints
		WHERE task_id = ? AND event_seq = ? AND workspace_id = ?
	`, taskID, eventSeq, workspaceID)

	cp, err := scanCheckpointWithWorkspace(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TaskCheckpoint{}, ErrNotFound
	}
	if err != nil {
		return TaskCheckpoint{}, fmt.Errorf("get checkpoint for workspace: %w", err)
	}
	return cp, nil
}

// ApplyWorkspaceTransition atomically applies a workspace state transition with event.
func (s *Store) ApplyWorkspaceTransition(
	ctx context.Context, transition WorkspaceTransition,
) (WorkspaceGeneration, Event, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Transition workspace state
	fromStrs := make([]interface{}, 0, len(transition.FromStates)+3)
	fromStrs = append(fromStrs, string(transition.ToState), NowMilli(), transition.WorkspaceID)
	for _, s := range transition.FromStates {
		fromStrs = append(fromStrs, string(s))
	}

	stateList := "(" + strings.Join(sliceToPlaceholders(len(transition.FromStates)), ",") + ")"
	res, err := tx.ExecContext(ctx, fmt.Sprintf(`
		UPDATE task_workspaces
		SET state = ?, updated_at = ?
		WHERE id = ? AND state IN %s
	`, stateList), fromStrs...)

	if err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("update workspace: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("workspace state mismatch: %w", ErrConflict)
	}

	// Apply optional patch
	if transition.Patch.PhysicalRoot != nil ||
		transition.Patch.ExecutionCwd != nil ||
		transition.Patch.WorkspaceBranch != nil ||
		transition.Patch.BaseOID != nil ||
		transition.Patch.ReviewBaseOID != nil ||
		transition.Patch.FinalHeadOID != nil ||
		transition.Patch.FinalTreeOID != nil ||
		transition.Patch.IntegratedOID != nil ||
		transition.Patch.CompletedExecutionID != nil ||
		transition.Patch.FailureReason != nil ||
		transition.Patch.IntegratedAt != nil ||
		transition.Patch.ReleasedAt != nil {

		patchArgs := make([]interface{}, 0)
		patchSet := ""

		if transition.Patch.PhysicalRoot != nil {
			patchSet += "physical_root = ?,"
			patchArgs = append(patchArgs, *transition.Patch.PhysicalRoot)
		}
		if transition.Patch.ExecutionCwd != nil {
			patchSet += "execution_cwd = ?,"
			patchArgs = append(patchArgs, *transition.Patch.ExecutionCwd)
		}
		if transition.Patch.WorkspaceBranch != nil {
			patchSet += "workspace_branch = ?,"
			patchArgs = append(patchArgs, *transition.Patch.WorkspaceBranch)
		}
		if transition.Patch.BaseOID != nil {
			patchSet += "base_oid = ?,"
			patchArgs = append(patchArgs, *transition.Patch.BaseOID)
		}
		if transition.Patch.ReviewBaseOID != nil {
			patchSet += "review_base_oid = ?,"
			patchArgs = append(patchArgs, *transition.Patch.ReviewBaseOID)
		}
		if transition.Patch.FinalHeadOID != nil {
			patchSet += "final_head_oid = ?,"
			patchArgs = append(patchArgs, *transition.Patch.FinalHeadOID)
		}
		if transition.Patch.FinalTreeOID != nil {
			patchSet += "final_tree_oid = ?,"
			patchArgs = append(patchArgs, *transition.Patch.FinalTreeOID)
		}
		if transition.Patch.IntegratedOID != nil {
			patchSet += "integrated_oid = ?,"
			patchArgs = append(patchArgs, *transition.Patch.IntegratedOID)
		}
		if transition.Patch.CompletedExecutionID != nil {
			patchSet += "completed_execution_id = ?,"
			patchArgs = append(patchArgs, *transition.Patch.CompletedExecutionID)
		}
		if transition.Patch.FailureReason != nil {
			patchSet += "failure_reason = ?,"
			patchArgs = append(patchArgs, *transition.Patch.FailureReason)
		}
		if transition.Patch.IntegratedAt != nil {
			patchSet += "integrated_at = ?,"
			patchArgs = append(patchArgs, *transition.Patch.IntegratedAt)
		}
		if transition.Patch.ReleasedAt != nil {
			patchSet += "released_at = ?,"
			patchArgs = append(patchArgs, *transition.Patch.ReleasedAt)
		}

		patchSet = patchSet[:len(patchSet)-1] // remove trailing comma
		patchArgs = append(patchArgs, transition.WorkspaceID)

		if _, err := tx.ExecContext(ctx, `UPDATE task_workspaces SET `+patchSet+` WHERE id = ?`, patchArgs...); err != nil {
			return WorkspaceGeneration{}, Event{}, fmt.Errorf("apply patch: %w", err)
		}
	}

	// Get next event sequence and append event
	var nextSeq int
	err = tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(seq), 0) + 1
		FROM events WHERE task_id = ?
	`, transition.TaskID).Scan(&nextSeq)
	if err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("get next event seq: %w", err)
	}

	now := NowMilli()
	eventType := "workspace_" + string(transition.ToState)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO events (task_id, seq, ts, type, payload)
		VALUES (?, ?, ?, ?, ?)
	`, transition.TaskID, nextSeq, now, eventType, `{"workspace_id":"`+transition.WorkspaceID+`"}`)
	if err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("insert event: %w", err)
	}

	// Commit and re-fetch workspace
	if err := tx.Commit(); err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("commit tx: %w", err)
	}

	ws, err := s.GetWorkspace(ctx, transition.WorkspaceID)
	if err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("fetch workspace after transition: %w", err)
	}

	return ws, Event{
		TaskID:  transition.TaskID,
		Seq:     nextSeq,
		Type:    eventType,
		TS:      now,
		Payload: json.RawMessage(`{"workspace_id":"` + transition.WorkspaceID + `"}`),
	}, nil
}

// Helper functions

func scanWorkspace(scanner interface {
	Scan(dest ...any) error
}) (WorkspaceGeneration, error) {
	var ws WorkspaceGeneration
	var intAt, relAt sql.NullInt64

	err := scanner.Scan(
		&ws.ID, &ws.TaskID, &ws.Generation, &ws.State, &ws.SourceRoot, &ws.Scope,
		&ws.TargetBranch, &ws.WorkspaceBranch, &ws.PhysicalRoot, &ws.ExecutionCwd,
		&ws.BaseOID, &ws.ReviewBaseOID, &ws.FinalHeadOID, &ws.FinalTreeOID,
		&ws.IntegratedOID, &ws.RequestedExecutionID, &ws.RequestedUserEventSeq,
		&ws.CompletedExecutionID, &ws.FailureReason, &ws.CreatedAt, &ws.UpdatedAt,
		&intAt, &relAt,
	)
	if err != nil {
		return WorkspaceGeneration{}, err
	}
	if intAt.Valid {
		ws.IntegratedAt = &intAt.Int64
	}
	if relAt.Valid {
		ws.ReleasedAt = &relAt.Int64
	}
	return ws, nil
}

func scanCheckpointWithWorkspace(scanner interface {
	Scan(dest ...any) error
}) (TaskCheckpoint, error) {
	var cp TaskCheckpoint
	var wsID string

	err := scanner.Scan(
		&cp.TaskID, &cp.EventSeq, &cp.HeadOID, &cp.TreeOID, &cp.SizeBytes, &cp.CreatedAt, &wsID,
	)
	if err != nil {
		return TaskCheckpoint{}, err
	}
	return cp, nil
}

func sliceToPlaceholders(n int) []string {
	out := make([]string, n)
	for i := 0; i < n; i++ {
		out[i] = "?"
	}
	return out
}

// ErrConflict is returned for state transition conflicts (for test compatibility).
var ErrConflict = errors.New("conflict")
