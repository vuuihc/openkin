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
	WorkspaceBranch       string
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

	if err := insertWorkspace(ctx, s.db, ws); err != nil {
		return err
	}
	return nil
}

type workspaceExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func insertWorkspace(ctx context.Context, execer workspaceExecer, ws WorkspaceGeneration) error {
	_, err := execer.ExecContext(ctx, `
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

// InsertWorkspaceAsCurrent atomically inserts a generation, points the task at
// it, and appends the committed lifecycle event.
func (s *Store) InsertWorkspaceAsCurrent(ctx context.Context, ws WorkspaceGeneration) (Event, error) {
	if ws.ID == "" || ws.TaskID == "" {
		return Event{}, fmt.Errorf("workspace id and task_id required")
	}
	if ws.CreatedAt == 0 {
		ws.CreatedAt = NowMilli()
	}
	if ws.UpdatedAt == 0 {
		ws.UpdatedAt = ws.CreatedAt
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Event{}, fmt.Errorf("begin workspace insert: %w", err)
	}
	defer tx.Rollback()

	if err := insertWorkspace(ctx, tx, ws); err != nil {
		return Event{}, err
	}
	res, err := tx.ExecContext(ctx, `UPDATE tasks SET current_workspace_id = ? WHERE id = ?`, ws.ID, ws.TaskID)
	if err != nil {
		return Event{}, fmt.Errorf("set current workspace: %w", err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return Event{}, fmt.Errorf("set current workspace: %w", ErrNotFound)
	}
	ev, err := appendWorkspaceEvent(ctx, tx, ws.TaskID, "workspace_"+string(ws.State), ws.ID)
	if err != nil {
		return Event{}, err
	}
	if err := tx.Commit(); err != nil {
		return Event{}, fmt.Errorf("commit workspace insert: %w", err)
	}
	return ev, nil
}

// GetWorkspace retrieves a workspace by id.
func (s *Store) GetWorkspace(ctx context.Context, id string) (WorkspaceGeneration, error) {
	return getWorkspace(ctx, s.db, id)
}

type workspaceQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func getWorkspace(ctx context.Context, queryer workspaceQueryer, id string) (WorkspaceGeneration, error) {
	row := queryer.QueryRowContext(ctx, `
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

// RepairCurrentWorkspacePointers restores the authoritative task pointer for a
// unique open generation left behind by a pre-atomic write or interrupted upgrade.
func (s *Store) RepairCurrentWorkspacePointers(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace pointer repair: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		UPDATE tasks
		SET current_workspace_id = ''
		WHERE current_workspace_id <> ''
		  AND NOT EXISTS (
			SELECT 1 FROM task_workspaces w
			WHERE w.id = tasks.current_workspace_id AND w.task_id = tasks.id
			  AND w.state IN (
				'provisioning', 'ready', 'active', 'finalizing', 'integrated',
				'merge_blocked', 'finalize_blocked', 'legacy_pending'
			  )
		  )`); err != nil {
		return fmt.Errorf("clear invalid workspace pointers: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE tasks
		SET current_workspace_id = (
			SELECT w.id FROM task_workspaces w
			WHERE w.task_id = tasks.id
			  AND w.state IN (
				'provisioning', 'ready', 'active', 'finalizing', 'integrated',
				'merge_blocked', 'finalize_blocked', 'legacy_pending'
			  )
			LIMIT 1
		)
		WHERE current_workspace_id = ''
		  AND 1 = (
			SELECT COUNT(*) FROM task_workspaces w
			WHERE w.task_id = tasks.id
			  AND w.state IN (
				'provisioning', 'ready', 'active', 'finalizing', 'integrated',
				'merge_blocked', 'finalize_blocked', 'legacy_pending'
			  )
		  )`); err != nil {
		return fmt.Errorf("restore workspace pointers: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace pointer repair: %w", err)
	}
	return nil
}

// GetCurrentWorkspace retrieves the current (open) workspace for a task.
func (s *Store) GetCurrentWorkspace(ctx context.Context, taskID string) (WorkspaceGeneration, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT w.id, w.task_id, w.generation, w.state, w.source_root, w.scope,
			w.target_branch, w.workspace_branch, w.physical_root, w.execution_cwd,
			w.base_oid, w.review_base_oid, w.final_head_oid, w.final_tree_oid,
			w.integrated_oid, w.requested_execution_id, w.requested_user_event_seq,
			w.completed_execution_id, w.failure_reason, w.created_at, w.updated_at,
			w.integrated_at, w.released_at
		FROM tasks t
		JOIN task_workspaces w ON w.id = t.current_workspace_id AND w.task_id = t.id
		WHERE t.id = ?
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

// ClaimWorkspaceExecution records the execution currently authorized to
// complete an open generation.
func (s *Store) ClaimWorkspaceExecution(
	ctx context.Context, workspaceID, taskID, executionID string,
) error {
	if workspaceID == "" || taskID == "" || executionID == "" {
		return fmt.Errorf("workspace, task, and execution ids are required")
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE task_workspaces
		SET requested_execution_id = ?, updated_at = ?
		WHERE id = ? AND task_id = ?
		  AND state IN ('ready', 'active', 'merge_blocked', 'finalize_blocked')`,
		executionID, NowMilli(), workspaceID, taskID)
	if err != nil {
		return fmt.Errorf("claim workspace execution: %w", err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return fmt.Errorf("claim workspace execution: %w", ErrConflict)
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
	var eventEpoch int64
	if err := tx.QueryRowContext(ctx, `SELECT event_epoch FROM tasks WHERE id = ?`, taskID).Scan(&eventEpoch); err != nil {
		return Event{}, TaskTurnWorkspace{}, fmt.Errorf("get task event epoch: %w", err)
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
		TaskID:     taskID,
		EventEpoch: eventEpoch,
		Seq:        nextSeq,
		TS:         now,
		Type:       "message",
		Payload:    payload,
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

// CompleteWorkspaceProvisioning atomically persists the initial checkpoint,
// binds the requesting turn to the generation, and marks the workspace ready.
func (s *Store) CompleteWorkspaceProvisioning(
	ctx context.Context, ready WorkspaceReadyTransition, cp TaskCheckpoint,
) (WorkspaceGeneration, Event, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("begin workspace ready: %w", err)
	}
	defer tx.Rollback()

	now := NowMilli()
	res, err := tx.ExecContext(ctx, `
		UPDATE task_workspaces
		SET state = ?, physical_root = ?, execution_cwd = ?, workspace_branch = ?,
			base_oid = ?, requested_user_event_seq = ?, updated_at = ?
		WHERE id = ? AND task_id = ? AND state = ?
	`, WorkspaceReady, ready.PhysicalRoot, ready.ExecutionCwd, ready.WorkspaceBranch,
		ready.BaseOID, ready.RequestedUserEventSeq, now, ready.WorkspaceID, ready.TaskID,
		WorkspaceProvisioning)
	if err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("mark workspace ready: %w", err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("workspace state mismatch: %w", ErrConflict)
	}

	if ready.RequestedUserEventSeq > 0 {
		cp.TaskID = ready.TaskID
		cp.EventSeq = ready.RequestedUserEventSeq
		cp.WorkspaceID = ready.WorkspaceID
		if _, err := tx.ExecContext(ctx, `
		INSERT INTO task_checkpoints
			(task_id, event_seq, head_oid, tree_oid, size_bytes, created_at, workspace_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(task_id, event_seq) DO UPDATE SET
			head_oid = excluded.head_oid, tree_oid = excluded.tree_oid,
			size_bytes = excluded.size_bytes, created_at = excluded.created_at,
			workspace_id = excluded.workspace_id
		`, cp.TaskID, cp.EventSeq, cp.HeadOID, cp.TreeOID, cp.SizeBytes, cp.CreatedAt, cp.WorkspaceID); err != nil {
			return WorkspaceGeneration{}, Event{}, fmt.Errorf("persist initial checkpoint: %w", err)
		}

		res, err = tx.ExecContext(ctx, `
		INSERT INTO task_turn_workspaces
			(task_id, user_event_seq, workspace_id, access, created_at, updated_at)
		SELECT ?, ?, ?, 'writable', ?, ?
		WHERE EXISTS (SELECT 1 FROM events WHERE task_id = ? AND seq = ?)
		ON CONFLICT(task_id, user_event_seq) DO UPDATE SET
			workspace_id = excluded.workspace_id, access = excluded.access,
			updated_at = excluded.updated_at
		`, ready.TaskID, ready.RequestedUserEventSeq, ready.WorkspaceID, now, now,
			ready.TaskID, ready.RequestedUserEventSeq)
		if err != nil {
			return WorkspaceGeneration{}, Event{}, fmt.Errorf("bind workspace turn: %w", err)
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return WorkspaceGeneration{}, Event{}, fmt.Errorf("bind workspace turn: %w", ErrNotFound)
		}
	}

	ev, err := appendWorkspaceEvent(ctx, tx, ready.TaskID, "workspace_ready", ready.WorkspaceID)
	if err != nil {
		return WorkspaceGeneration{}, Event{}, err
	}
	ws, err := getWorkspace(ctx, tx, ready.WorkspaceID)
	if err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("read workspace before commit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("commit workspace ready: %w", err)
	}
	return ws, ev, nil
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

	if transition.ToState == WorkspaceReleased || transition.ToState == WorkspaceOrphaned {
		if _, err := tx.ExecContext(ctx, `
			UPDATE tasks SET current_workspace_id = ''
			WHERE id = ? AND current_workspace_id = ?
		`, transition.TaskID, transition.WorkspaceID); err != nil {
			return WorkspaceGeneration{}, Event{}, fmt.Errorf("clear current workspace: %w", err)
		}
	}

	eventType := "workspace_" + string(transition.ToState)
	ev, err := appendWorkspaceEvent(ctx, tx, transition.TaskID, eventType, transition.WorkspaceID)
	if err != nil {
		return WorkspaceGeneration{}, Event{}, err
	}

	// Commit and re-fetch workspace
	if err := tx.Commit(); err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("commit tx: %w", err)
	}

	ws, err := s.GetWorkspace(ctx, transition.WorkspaceID)
	if err != nil {
		return WorkspaceGeneration{}, Event{}, fmt.Errorf("fetch workspace after transition: %w", err)
	}

	return ws, ev, nil
}

func appendWorkspaceEvent(ctx context.Context, tx *sql.Tx, taskID, eventType, workspaceID string) (Event, error) {
	var nextSeq int
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE task_id = ?
	`, taskID).Scan(&nextSeq); err != nil {
		return Event{}, fmt.Errorf("get next event seq: %w", err)
	}
	var eventEpoch int64
	if err := tx.QueryRowContext(ctx, `SELECT event_epoch FROM tasks WHERE id = ?`, taskID).Scan(&eventEpoch); err != nil {
		return Event{}, fmt.Errorf("get task event epoch: %w", err)
	}
	now := NowMilli()
	payload, _ := json.Marshal(map[string]string{"workspace_id": workspaceID})
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO events (task_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)
	`, taskID, nextSeq, now, eventType, payload); err != nil {
		return Event{}, fmt.Errorf("insert event: %w", err)
	}
	return Event{
		TaskID: taskID, EventEpoch: eventEpoch, Seq: nextSeq,
		Type: eventType, TS: now, Payload: payload,
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
	cp.WorkspaceID = wsID
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
