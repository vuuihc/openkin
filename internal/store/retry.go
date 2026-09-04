package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

const retryingStatus = "retrying"

type RetryMutation struct {
	TaskID              string
	FromSeq             int
	ExpectedEventEpoch  int64
	Prompt              string
	UserPayload         json.RawMessage
	DeleteCheckpoints   bool
	WorkspaceID         string
	ActivateWorkspaceID string
	NewWorkspace        *WorkspaceGeneration
	WorkspacePlanned    bool
}

type RetryMutationResult struct {
	Task           Task
	UserEvent      Event
	WorkspaceEvent *Event
}

// RetryRestoreIntent is the write-ahead record and durable resume marker for a retry.
type RetryRestoreIntent struct {
	TaskID             string
	RestoreFiles       bool
	FromSeq            int
	ExpectedEventEpoch int64
	PreviousStatus     string
	Prompt             string
	UserPayload        json.RawMessage
	Checkpoint         TaskCheckpoint
	RollbackCheckpoint TaskCheckpoint
	Target             WorkspaceGeneration
	TargetIsNew        bool
	ActivateTarget     bool
	CreatedAt          int64
}

// BeginRetryRestore reserves the task and, for a file-restoring retry with a
// new target, registers the generation before any filesystem mutation.
func (s *Store) BeginRetryRestore(ctx context.Context, in RetryRestoreIntent) error {
	if in.TaskID == "" || in.FromSeq < 1 {
		return fmt.Errorf("invalid retry restore intent")
	}
	if in.RestoreFiles || in.TargetIsNew {
		if in.Target.ID == "" || in.Target.TaskID != in.TaskID ||
			in.Target.Generation < 1 || in.Target.SourceRoot == "" {
			return fmt.Errorf("incomplete retry restore intent")
		}
	}
	if in.RestoreFiles {
		if in.Checkpoint.HeadOID == "" || in.Checkpoint.TreeOID == "" {
			return fmt.Errorf("incomplete retry restore checkpoint")
		}
		if !in.TargetIsNew &&
			(in.RollbackCheckpoint.HeadOID == "" || in.RollbackCheckpoint.TreeOID == "") {
			return fmt.Errorf("existing retry target requires rollback checkpoint")
		}
	}
	if in.CreatedAt == 0 {
		in.CreatedAt = NowMilli()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin retry restore: %w", err)
	}
	defer tx.Rollback()

	if err := tx.QueryRowContext(ctx,
		`SELECT status FROM tasks WHERE id = ? AND event_epoch = ?`,
		in.TaskID, in.ExpectedEventEpoch,
	).Scan(&in.PreviousStatus); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrConflict
		}
		return err
	}
	switch in.PreviousStatus {
	case "succeeded", "failed", "canceled":
	default:
		return ErrConflict
	}
	if in.TargetIsNew {
		planned := in.Target
		planned.State = WorkspaceProvisioning
		planned.PhysicalRoot = ""
		planned.ExecutionCwd = ""
		planned.WorkspaceBranch = ""
		if planned.CreatedAt == 0 {
			planned.CreatedAt = in.CreatedAt
		}
		planned.UpdatedAt = planned.CreatedAt
		if err := insertWorkspace(ctx, tx, planned); err != nil {
			return err
		}
	} else if in.RestoreFiles {
		ws, err := getWorkspace(ctx, tx, in.Target.ID)
		if err != nil {
			return err
		}
		switch ws.State {
		case WorkspaceReady, WorkspaceActive, WorkspaceMergeBlocked, WorkspaceFinalizeBlocked:
		default:
			return fmt.Errorf("workspace %s is in state %s: %w", ws.ID, ws.State, ErrConflict)
		}
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE tasks SET status = ?
		WHERE id = ? AND event_epoch = ?
		  AND status IN ('succeeded', 'failed', 'canceled')`,
		retryingStatus, in.TaskID, in.ExpectedEventEpoch)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO retry_restore_intents (
			task_id, restore_files, from_seq, expected_event_epoch, previous_status, prompt, user_payload,
			checkpoint_head_oid, checkpoint_tree_oid, checkpoint_size_bytes,
			checkpoint_created_at, checkpoint_workspace_id,
			rollback_head_oid, rollback_tree_oid, rollback_size_bytes, rollback_created_at,
			target_workspace_id, target_generation, target_is_new, activate_target,
			source_root, scope, target_branch, workspace_branch, physical_root,
			execution_cwd, base_oid, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		in.TaskID, boolInt(in.RestoreFiles), in.FromSeq, in.ExpectedEventEpoch, in.PreviousStatus, in.Prompt,
		string(in.UserPayload), in.Checkpoint.HeadOID, in.Checkpoint.TreeOID,
		in.Checkpoint.SizeBytes, in.Checkpoint.CreatedAt, in.Checkpoint.WorkspaceID,
		in.RollbackCheckpoint.HeadOID, in.RollbackCheckpoint.TreeOID,
		in.RollbackCheckpoint.SizeBytes, in.RollbackCheckpoint.CreatedAt,
		in.Target.ID, in.Target.Generation, boolInt(in.TargetIsNew), boolInt(in.ActivateTarget),
		in.Target.SourceRoot, in.Target.Scope, in.Target.TargetBranch,
		in.Target.WorkspaceBranch, in.Target.PhysicalRoot, in.Target.ExecutionCwd,
		in.Target.BaseOID, in.CreatedAt); err != nil {
		return fmt.Errorf("insert retry restore intent: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit retry restore: %w", err)
	}
	return nil
}

func (s *Store) MarkRetryRestoreTargetPrepared(
	ctx context.Context, taskID string, target WorkspaceGeneration,
) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `
		UPDATE task_workspaces
		SET source_root = ?, scope = ?, target_branch = ?, workspace_branch = ?,
		    physical_root = ?, execution_cwd = ?, base_oid = ?, updated_at = ?
		WHERE id = ? AND task_id = ? AND state = ?`,
		target.SourceRoot, target.Scope, target.TargetBranch, target.WorkspaceBranch,
		target.PhysicalRoot, target.ExecutionCwd, target.BaseOID, NowMilli(),
		target.ID, taskID, WorkspaceProvisioning)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrConflict
	}
	res, err = tx.ExecContext(ctx, `
		UPDATE retry_restore_intents
		SET source_root = ?, scope = ?, target_branch = ?, workspace_branch = ?,
		    physical_root = ?, execution_cwd = ?, base_oid = ?
		WHERE task_id = ? AND target_workspace_id = ? AND target_is_new = 1`,
		target.SourceRoot, target.Scope, target.TargetBranch, target.WorkspaceBranch,
		target.PhysicalRoot, target.ExecutionCwd, target.BaseOID, taskID, target.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrConflict
	}
	return tx.Commit()
}

func (s *Store) ListRetryRestoreIntents(ctx context.Context) ([]RetryRestoreIntent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+retryIntentColumns+
		` FROM retry_restore_intents ORDER BY created_at, task_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RetryRestoreIntent
	for rows.Next() {
		in, err := scanRetryRestoreIntent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, in)
	}
	return out, rows.Err()
}

func (s *Store) GetRetryRestoreIntent(ctx context.Context, taskID string) (RetryRestoreIntent, error) {
	in, err := scanRetryRestoreIntent(s.db.QueryRowContext(ctx,
		`SELECT `+retryIntentColumns+` FROM retry_restore_intents WHERE task_id = ?`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return RetryRestoreIntent{}, ErrNotFound
	}
	return in, err
}

func (s *Store) DeleteRetryRestoreIntent(ctx context.Context, taskID string) error {
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM retry_restore_intents WHERE task_id = ?`, taskID); err != nil {
		return fmt.Errorf("delete retry restore intent: %w", err)
	}
	return nil
}

// AbortRetryRestore is called only after filesystem compensation succeeds.
func (s *Store) AbortRetryRestore(ctx context.Context, taskID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	in, err := getRetryRestoreIntent(ctx, tx, taskID)
	if err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE tasks SET status = ?
		WHERE id = ? AND status = ? AND event_epoch = ?`,
		in.PreviousStatus, taskID, retryingStatus, in.ExpectedEventEpoch)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM retry_restore_intents WHERE task_id = ?`, taskID); err != nil {
		return err
	}
	if in.TargetIsNew {
		res, err := tx.ExecContext(ctx, `
			DELETE FROM task_workspaces
			WHERE id = ? AND task_id = ? AND state = ?`,
			in.Target.ID, taskID, WorkspaceProvisioning)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return ErrConflict
		}
	}
	return tx.Commit()
}

func (s *Store) CompleteRetryRestore(ctx context.Context, taskID string) (RetryMutationResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RetryMutationResult{}, err
	}
	defer tx.Rollback()
	in, err := getRetryRestoreIntent(ctx, tx, taskID)
	if err != nil {
		return RetryMutationResult{}, err
	}
	m := RetryMutation{
		TaskID: taskID, FromSeq: in.FromSeq, ExpectedEventEpoch: in.ExpectedEventEpoch,
		Prompt: in.Prompt, UserPayload: in.UserPayload, DeleteCheckpoints: in.RestoreFiles,
		WorkspaceID: in.Target.ID,
	}
	if in.TargetIsNew {
		target := in.Target
		target.State = WorkspaceActive
		m.NewWorkspace = &target
		m.WorkspacePlanned = true
	} else if in.RestoreFiles && in.ActivateTarget {
		m.ActivateWorkspaceID = in.Target.ID
	}
	result, err := applyRetryMutationTx(ctx, tx, m, retryingStatus)
	if err != nil {
		return RetryMutationResult{}, err
	}
	if in.RestoreFiles {
		replayedCheckpoint := in.Checkpoint
		replayedCheckpoint.TaskID = taskID
		replayedCheckpoint.EventSeq = result.UserEvent.Seq
		replayedCheckpoint.WorkspaceID = in.Target.ID
		replayedCheckpoint.CreatedAt = NowMilli()
		if in.TargetIsNew {
			replayedCheckpoint.HeadOID = in.Target.BaseOID
		} else if in.Checkpoint.WorkspaceID != "" &&
			in.Checkpoint.WorkspaceID != in.Target.ID {
			replayedCheckpoint.HeadOID = in.RollbackCheckpoint.HeadOID
		}
		if _, err := tx.ExecContext(ctx, `
		INSERT INTO task_checkpoints
			(task_id, event_seq, head_oid, tree_oid, size_bytes, created_at, workspace_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(task_id, event_seq) DO UPDATE SET
			head_oid = excluded.head_oid, tree_oid = excluded.tree_oid,
			size_bytes = excluded.size_bytes, created_at = excluded.created_at,
			workspace_id = excluded.workspace_id`,
			replayedCheckpoint.TaskID, replayedCheckpoint.EventSeq,
			replayedCheckpoint.HeadOID, replayedCheckpoint.TreeOID,
			replayedCheckpoint.SizeBytes, replayedCheckpoint.CreatedAt,
			replayedCheckpoint.WorkspaceID); err != nil {
			return RetryMutationResult{}, fmt.Errorf("persist retry checkpoint: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return RetryMutationResult{}, err
	}
	return result, nil
}

// ApplyRetryMutation keeps conversation-only retry in one DB transaction.
func (s *Store) ApplyRetryMutation(ctx context.Context, m RetryMutation) (RetryMutationResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RetryMutationResult{}, err
	}
	defer tx.Rollback()
	result, err := applyRetryMutationTx(ctx, tx, m, "")
	if err != nil {
		return RetryMutationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return RetryMutationResult{}, err
	}
	return result, nil
}

func applyRetryMutationTx(
	ctx context.Context, tx *sql.Tx, m RetryMutation, reservedStatus string,
) (RetryMutationResult, error) {
	if m.TaskID == "" || m.FromSeq < 1 {
		return RetryMutationResult{}, fmt.Errorf("task_id and from_seq are required")
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM events WHERE task_id = ? AND seq >= ?`, m.TaskID, m.FromSeq); err != nil {
		return RetryMutationResult{}, err
	}
	if m.DeleteCheckpoints {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM task_checkpoints WHERE task_id = ? AND event_seq >= ?`,
			m.TaskID, m.FromSeq); err != nil {
			return RetryMutationResult{}, err
		}
	}
	predicate := "status IN ('succeeded', 'failed', 'canceled')"
	args := []any{m.Prompt, m.TaskID, m.ExpectedEventEpoch}
	if reservedStatus != "" {
		predicate = "status = ?"
		args = append(args, reservedStatus)
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE tasks
		SET event_epoch = event_epoch + 1, status = 'queued', prompt = ?,
		    exit_code = NULL, finished_at = NULL, session_ref = NULL
		WHERE id = ? AND event_epoch = ? AND `+predicate, args...)
	if err != nil {
		return RetryMutationResult{}, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return RetryMutationResult{}, ErrConflict
	}

	var workspaceEvent *Event
	if m.NewWorkspace != nil {
		ws := *m.NewWorkspace
		if ws.TaskID != m.TaskID {
			return RetryMutationResult{}, fmt.Errorf("retry workspace task mismatch")
		}
		if m.WorkspacePlanned {
			res, err := tx.ExecContext(ctx, `
				UPDATE task_workspaces
				SET state = ?, source_root = ?, scope = ?, target_branch = ?,
				    workspace_branch = ?, physical_root = ?, execution_cwd = ?,
				    base_oid = ?, updated_at = ?
				WHERE id = ? AND task_id = ? AND state = ?`,
				WorkspaceActive, ws.SourceRoot, ws.Scope, ws.TargetBranch,
				ws.WorkspaceBranch, ws.PhysicalRoot, ws.ExecutionCwd, ws.BaseOID,
				NowMilli(), ws.ID, m.TaskID, WorkspaceProvisioning)
			if err != nil {
				return RetryMutationResult{}, err
			}
			if n, _ := res.RowsAffected(); n != 1 {
				return RetryMutationResult{}, ErrConflict
			}
		} else if err := insertWorkspace(ctx, tx, ws); err != nil {
			return RetryMutationResult{}, err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE tasks
			SET current_workspace_id = ?, workspace_mode = 'worktree',
			    workspace_source_root = ?, workspace_root = ?, execution_cwd = ?,
			    workspace_scope = ?, workspace_base_oid = ?, workspace_branch = ?
			WHERE id = ?`,
			ws.ID, ws.SourceRoot, ws.PhysicalRoot, ws.ExecutionCwd, ws.Scope,
			ws.BaseOID, ws.WorkspaceBranch, m.TaskID); err != nil {
			return RetryMutationResult{}, err
		}
		ev, err := appendWorkspaceEvent(ctx, tx, m.TaskID, "workspace_active", ws.ID)
		if err != nil {
			return RetryMutationResult{}, err
		}
		workspaceEvent = &ev
	} else if m.ActivateWorkspaceID != "" {
		res, err := tx.ExecContext(ctx, `
			UPDATE task_workspaces
			SET state = ?, updated_at = ?,
			    review_base_oid = '', final_head_oid = '', final_tree_oid = '',
			    integrated_oid = '', completed_execution_id = '',
			    failure_reason = '', integrated_at = NULL, released_at = NULL
			WHERE id = ? AND task_id = ? AND state IN (?, ?, ?)`,
			WorkspaceActive, NowMilli(), m.ActivateWorkspaceID, m.TaskID,
			WorkspaceReady, WorkspaceMergeBlocked, WorkspaceFinalizeBlocked)
		if err != nil {
			return RetryMutationResult{}, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return RetryMutationResult{}, ErrConflict
		}
		ev, err := appendWorkspaceEvent(ctx, tx, m.TaskID, "workspace_active", m.ActivateWorkspaceID)
		if err != nil {
			return RetryMutationResult{}, err
		}
		workspaceEvent = &ev
	}

	seq, err := nextEventSeq(ctx, tx, m.TaskID)
	if err != nil {
		return RetryMutationResult{}, err
	}
	now := NowMilli()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO events (task_id, seq, ts, type, payload)
		VALUES (?, ?, ?, 'message', ?)`, m.TaskID, seq, now, string(m.UserPayload)); err != nil {
		return RetryMutationResult{}, err
	}
	if m.WorkspaceID != "" {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO task_turn_workspaces
				(task_id, user_event_seq, workspace_id, access, created_at, updated_at)
			VALUES (?, ?, ?, 'writable', ?, ?)
			ON CONFLICT(task_id, user_event_seq) DO UPDATE SET
				workspace_id = excluded.workspace_id, access = excluded.access,
				updated_at = excluded.updated_at`,
			m.TaskID, seq, m.WorkspaceID, now, now); err != nil {
			return RetryMutationResult{}, err
		}
	}
	task, err := scanTask(tx.QueryRowContext(ctx,
		`SELECT `+taskColumns+` FROM tasks WHERE id = ?`, m.TaskID))
	if err != nil {
		return RetryMutationResult{}, err
	}
	userEvent := Event{
		TaskID: m.TaskID, EventEpoch: task.EventEpoch, Seq: seq,
		TS: now, Type: "message", Payload: m.UserPayload,
	}
	return RetryMutationResult{Task: task, UserEvent: userEvent, WorkspaceEvent: workspaceEvent}, nil
}

const retryIntentColumns = `
	task_id, restore_files, from_seq, expected_event_epoch, previous_status, prompt, user_payload,
	checkpoint_head_oid, checkpoint_tree_oid, checkpoint_size_bytes,
	checkpoint_created_at, checkpoint_workspace_id,
	rollback_head_oid, rollback_tree_oid, rollback_size_bytes, rollback_created_at,
	target_workspace_id, target_generation, target_is_new, activate_target,
	source_root, scope, target_branch, workspace_branch, physical_root,
	execution_cwd, base_oid, created_at`

type retryIntentScanner interface {
	Scan(...any) error
}

func getRetryRestoreIntent(ctx context.Context, tx *sql.Tx, taskID string) (RetryRestoreIntent, error) {
	in, err := scanRetryRestoreIntent(tx.QueryRowContext(ctx,
		`SELECT `+retryIntentColumns+` FROM retry_restore_intents WHERE task_id = ?`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return RetryRestoreIntent{}, ErrNotFound
	}
	return in, err
}

func scanRetryRestoreIntent(scanner retryIntentScanner) (RetryRestoreIntent, error) {
	var in RetryRestoreIntent
	var payload string
	var restoreFiles, targetIsNew, activate int
	err := scanner.Scan(
		&in.TaskID, &restoreFiles, &in.FromSeq, &in.ExpectedEventEpoch, &in.PreviousStatus,
		&in.Prompt, &payload, &in.Checkpoint.HeadOID, &in.Checkpoint.TreeOID,
		&in.Checkpoint.SizeBytes, &in.Checkpoint.CreatedAt, &in.Checkpoint.WorkspaceID,
		&in.RollbackCheckpoint.HeadOID, &in.RollbackCheckpoint.TreeOID,
		&in.RollbackCheckpoint.SizeBytes, &in.RollbackCheckpoint.CreatedAt,
		&in.Target.ID, &in.Target.Generation, &targetIsNew, &activate,
		&in.Target.SourceRoot, &in.Target.Scope, &in.Target.TargetBranch,
		&in.Target.WorkspaceBranch, &in.Target.PhysicalRoot, &in.Target.ExecutionCwd,
		&in.Target.BaseOID, &in.CreatedAt)
	if err != nil {
		return RetryRestoreIntent{}, err
	}
	in.UserPayload = json.RawMessage(payload)
	in.Checkpoint.TaskID, in.Checkpoint.EventSeq = in.TaskID, in.FromSeq
	in.RollbackCheckpoint.TaskID = in.TaskID
	in.Target.TaskID = in.TaskID
	in.RestoreFiles = restoreFiles != 0
	in.TargetIsNew, in.ActivateTarget = targetIsNew != 0, activate != 0
	return in, nil
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
