package store

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func TestApplyRetryMutationRollsBackOnWorkspaceFailure(t *testing.T) {
	ctx := context.Background()
	st, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	task := Task{
		ID: "01RETRYATOMIC0000000000001", Title: "retry", Agent: "codex",
		Cwd: "/tmp", Prompt: "before", Status: "succeeded", CreatedAt: NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	original, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(`{"role":"user","text":"before"}`))
	if err != nil {
		t.Fatal(err)
	}

	_, err = st.ApplyRetryMutation(ctx, RetryMutation{
		TaskID:      task.ID,
		FromSeq:     original.Seq,
		Prompt:      "after",
		UserPayload: json.RawMessage(`{"role":"user","text":"after"}`),
		NewWorkspace: &WorkspaceGeneration{
			ID: "wrong:g2", TaskID: "different-task", Generation: 2,
			State: WorkspaceActive,
		},
	})
	if err == nil {
		t.Fatal("expected retry mutation failure")
	}
	events, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Seq != original.Seq {
		t.Fatalf("events changed after rollback: %+v", events)
	}
	unchanged, err := st.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.EventEpoch != 0 || unchanged.Status != "succeeded" || unchanged.Prompt != "before" {
		t.Fatalf("task changed after rollback: %+v", unchanged)
	}
}

func TestApplyRetryMutationRejectsStaleEpoch(t *testing.T) {
	ctx := context.Background()
	st, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	task := Task{
		ID: "01RETRYCAS0000000000000001", Title: "retry", Agent: "codex",
		Cwd: "/tmp", Prompt: "before", Status: "succeeded", CreatedAt: NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	event, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(`{"role":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	mutation := RetryMutation{
		TaskID: task.ID, FromSeq: event.Seq, ExpectedEventEpoch: 0,
		Prompt: "after", UserPayload: json.RawMessage(`{"role":"user","text":"after"}`),
	}
	if _, err := st.ApplyRetryMutation(ctx, mutation); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ApplyRetryMutation(ctx, mutation); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale retry error=%v want ErrConflict", err)
	}
	updated, err := st.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.EventEpoch != 1 {
		t.Fatalf("event_epoch=%d want 1", updated.EventEpoch)
	}
}

func TestApplyRetryMutationReactivatesBlockedWorkspace(t *testing.T) {
	ctx := context.Background()
	st, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	task := Task{
		ID: "01RETRYBLOCKED00000000001", Title: "retry", Agent: "codex",
		Cwd: "/tmp", Prompt: "before", Status: "failed", CreatedAt: NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	event, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(`{"role":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	now := NowMilli()
	ws := WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: WorkspaceMergeBlocked, SourceRoot: "/tmp", Scope: ".",
		PhysicalRoot: "/tmp/worktree", ExecutionCwd: "/tmp/worktree",
		ReviewBaseOID: "review", FinalHeadOID: "head", FinalTreeOID: "tree",
		CompletedExecutionID: "exec", FailureReason: "conflict",
		CreatedAt: now, UpdatedAt: now,
	}
	if _, err := st.InsertWorkspaceAsCurrent(ctx, ws); err != nil {
		t.Fatal(err)
	}

	result, err := st.ApplyRetryMutation(ctx, RetryMutation{
		TaskID: task.ID, FromSeq: event.Seq, ExpectedEventEpoch: 0,
		Prompt: "after", UserPayload: json.RawMessage(`{"role":"user","text":"after"}`),
		WorkspaceID: ws.ID, ActivateWorkspaceID: ws.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.WorkspaceEvent == nil || result.WorkspaceEvent.Type != "workspace_active" {
		t.Fatalf("workspace event=%+v", result.WorkspaceEvent)
	}
	got, err := st.GetWorkspace(ctx, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != WorkspaceActive {
		t.Fatalf("state=%q want active", got.State)
	}
	if got.ReviewBaseOID != "" || got.FinalHeadOID != "" || got.FinalTreeOID != "" ||
		got.CompletedExecutionID != "" || got.FailureReason != "" {
		t.Fatalf("stale finalization metadata was not cleared: %+v", got)
	}
}

func TestMigration016CreatesRetryRestoreIntents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := openSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DROP TABLE retry_restore_intents; PRAGMA user_version = 15`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	var version, tables int
	if err := st.DB().QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := st.DB().QueryRow(`
		SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name = 'retry_restore_intents'`).Scan(&tables); err != nil {
		t.Fatal(err)
	}
	if version != 16 || tables != 1 {
		t.Fatalf("version=%d tables=%d", version, tables)
	}
}

func TestRetryRestoreReservationAndCompletion(t *testing.T) {
	ctx := context.Background()
	st, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	task := Task{
		ID: "01RETRYINTENT000000000001", Title: "retry", Agent: "codex",
		Cwd: "/tmp", Prompt: "before", Status: "failed", CreatedAt: NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	event, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(`{"role":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	now := NowMilli()
	ws := WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1, State: WorkspaceActive,
		SourceRoot: "/repo", Scope: ".", TargetBranch: "main",
		WorkspaceBranch: "kin/task/retry/g1", PhysicalRoot: "/worktree",
		ExecutionCwd: "/worktree", BaseOID: "base", CreatedAt: now, UpdatedAt: now,
	}
	if _, err := st.InsertWorkspaceAsCurrent(ctx, ws); err != nil {
		t.Fatal(err)
	}
	intent := RetryRestoreIntent{
		TaskID: task.ID, RestoreFiles: true, FromSeq: event.Seq, Prompt: "after",
		UserPayload: json.RawMessage(`{"role":"user","text":"after"}`),
		Checkpoint: TaskCheckpoint{
			TaskID: task.ID, EventSeq: event.Seq, HeadOID: "head", TreeOID: "tree",
			WorkspaceID: "prior:g1",
		},
		RollbackCheckpoint: TaskCheckpoint{
			TaskID: task.ID, HeadOID: "current-head", TreeOID: "old-tree",
		},
		Target: ws,
	}
	if err := st.BeginRetryRestore(ctx, intent); err != nil {
		t.Fatal(err)
	}
	reserved, err := st.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reserved.Status != "retrying" || reserved.EventEpoch != 0 {
		t.Fatalf("reserved task=%+v", reserved)
	}
	if _, err := st.GetRetryRestoreIntent(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.BeginRetryRestore(ctx, intent); !errors.Is(err, ErrConflict) {
		t.Fatalf("concurrent reservation error=%v", err)
	}
	result, err := st.CompleteRetryRestore(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Task.Status != "queued" || result.Task.EventEpoch != 1 {
		t.Fatalf("completed task=%+v", result.Task)
	}
	if _, err := st.GetRetryRestoreIntent(ctx, task.ID); err != nil {
		t.Fatalf("resume intent missing after completion: %v", err)
	}
	orphaned, err := st.FailOrphaned(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(orphaned) != 0 {
		t.Fatalf("committed retry was failed as orphaned: %v", orphaned)
	}
	started, err := st.StartQueuedTask(ctx, task.ID, NowMilli())
	if err != nil {
		t.Fatal(err)
	}
	if started.Status != "running" {
		t.Fatalf("started task status=%q", started.Status)
	}
	if _, err := st.GetRetryRestoreIntent(ctx, task.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("resume intent after start error=%v", err)
	}
	turn, err := st.GetTurnWorkspace(ctx, task.ID, result.UserEvent.Seq)
	if err != nil {
		t.Fatal(err)
	}
	if turn.WorkspaceID == nil || *turn.WorkspaceID != ws.ID {
		t.Fatalf("turn binding=%+v", turn)
	}
	checkpoint, err := st.GetCheckpointForWorkspace(
		ctx, task.ID, result.UserEvent.Seq, ws.ID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.HeadOID != intent.RollbackCheckpoint.HeadOID ||
		checkpoint.TreeOID != intent.Checkpoint.TreeOID {
		t.Fatalf("replayed checkpoint=%+v", checkpoint)
	}
}

func TestRetryRestoreCompletionRollsBackAsAUnit(t *testing.T) {
	ctx := context.Background()
	st, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	task := Task{
		ID: "01RETRYCOMPLETE0000000001", Title: "retry", Agent: "codex",
		Cwd: "/repo", Prompt: "before", Status: "failed", CreatedAt: NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	event, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(`{"role":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	now := NowMilli()
	target := WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: WorkspaceProvisioning, SourceRoot: "/repo", Scope: ".",
		TargetBranch: "main", BaseOID: "base", CreatedAt: now, UpdatedAt: now,
	}
	intent := RetryRestoreIntent{
		TaskID: task.ID, RestoreFiles: true, FromSeq: event.Seq, Prompt: "after",
		UserPayload: json.RawMessage(`{"role":"user"}`),
		Checkpoint: TaskCheckpoint{
			TaskID: task.ID, EventSeq: event.Seq, HeadOID: "head", TreeOID: "tree",
		},
		Target: target, TargetIsNew: true,
	}
	if err := st.BeginRetryRestore(ctx, intent); err != nil {
		t.Fatal(err)
	}
	target.State = WorkspaceActive
	target.PhysicalRoot = "/worktree"
	target.ExecutionCwd = "/worktree"
	target.WorkspaceBranch = "kin/task/retry/g1"
	if err := st.MarkRetryRestoreTargetPrepared(ctx, task.ID, target); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().Exec(`UPDATE task_workspaces SET state = 'ready' WHERE id = ?`, target.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := st.CompleteRetryRestore(ctx, task.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("completion error=%v want conflict", err)
	}
	got, err := st.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "retrying" || got.EventEpoch != 0 {
		t.Fatalf("task changed after failed completion: %+v", got)
	}
	events, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Seq != event.Seq {
		t.Fatalf("events changed after failed completion: %+v", events)
	}
	if _, err := st.GetRetryRestoreIntent(ctx, task.ID); err != nil {
		t.Fatalf("intent was cleared after failed completion: %v", err)
	}
}
