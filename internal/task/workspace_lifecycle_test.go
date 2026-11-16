package task

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

func TestEngineRequestWorkspace(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	bus := NewBus()
	eng := NewEngine(s, nil, bus, 1)
	// Set up a fake workspace runtime so provisionWorkspace can create the worktree.
	eng.SetWorkspaceRuntime(&fakeWorkspaceRuntime{})
	ctx := context.Background()

	task := store.Task{
		ID: "01REQWSP00000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "running", CreatedAt: 1000,
		WorkspacePolicy: "auto",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	userPayload := json.RawMessage(`{"role":"user","content":[{"type":"text","text":"edit"}]}`)
	userEvent, _, err := s.AppendUserEventWithTurnWorkspace(ctx, task.ID, userPayload, store.TaskTurnWorkspace{
		Access: string("source_read_only"),
	})
	if err != nil {
		t.Fatal(err)
	}
	sub := bus.Subscribe()
	defer bus.Unsubscribe(sub)

	// Request workspace promotion — should transition to ready (not active).
	// startOne handles ready → active before the adapter starts.
	req := WorkspaceIntentRequest{
		TaskID:      task.ID,
		ExecutionID: "exec-1",
		Agent:       "claude-code",
	}
	updated, err := eng.RequestWorkspace(ctx, req)
	if err != nil {
		t.Fatalf("request workspace: %v", err)
	}
	if updated.State != store.WorkspaceReady {
		t.Fatalf("state=%q want ready", updated.State)
	}
	if updated.WorkspaceBranch == "" {
		t.Fatal("workspace branch was not persisted")
	}
	if updated.BaseOID == "" {
		t.Fatal("workspace base OID was not persisted")
	}
	if updated.RequestedExecutionID != req.ExecutionID {
		t.Fatalf("requested execution=%q want %q", updated.RequestedExecutionID, req.ExecutionID)
	}
	if updated.RequestedUserEventSeq != userEvent.Seq {
		t.Fatalf("requested user seq=%d want %d", updated.RequestedUserEventSeq, userEvent.Seq)
	}
	turn, err := s.GetTurnWorkspace(ctx, task.ID, userEvent.Seq)
	if err != nil {
		t.Fatal(err)
	}
	if turn.WorkspaceID == nil || *turn.WorkspaceID != updated.ID || turn.Access != "writable" {
		t.Fatalf("turn binding=%+v want writable %q", turn, updated.ID)
	}
	cp, err := s.GetCheckpointForWorkspace(ctx, task.ID, userEvent.Seq, updated.ID)
	if err != nil {
		t.Fatalf("get initial checkpoint: %v", err)
	}
	if cp.EventSeq != userEvent.Seq || cp.WorkspaceID != updated.ID {
		t.Fatalf("checkpoint=%+v", cp)
	}

	gotEvents := map[string]bool{}
	for len(gotEvents) < 2 {
		select {
		case msg := <-sub:
			if msg.Kind == "event" {
				ev := msg.Data.(store.Event)
				gotEvents[ev.Type] = true
			}
		case <-time.After(time.Second):
			t.Fatalf("workspace events not published: %+v", gotEvents)
		}
	}
	if !gotEvents["workspace_provisioning"] || !gotEvents["workspace_ready"] {
		t.Fatalf("workspace events=%+v", gotEvents)
	}
}

func TestEngineRequestWorkspaceRejectsMissingTask(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	eng := NewEngine(s, nil, NewBus(), 1)

	req := WorkspaceIntentRequest{
		TaskID:      "nonexistent",
		ExecutionID: "exec-1",
	}
	_, err = eng.RequestWorkspace(context.Background(), req)
	if err == nil {
		t.Fatal("expected error for nonexistent task")
	}
}

func TestEngineCompleteWorkspace(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	eng := NewEngine(s, nil, NewBus(), 1)
	eng.SetWorkspaceRuntime(&fakeWorkspaceRuntime{})
	ctx := context.Background()

	task := store.Task{
		ID: "01CMPWSP00000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "running", CreatedAt: 1000,
		WorkspacePolicy: "auto",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	// Create workspace in active state
	ws := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: store.WorkspaceActive, SourceRoot: "/repo", Scope: ".",
		CreatedAt: 1000, UpdatedAt: 1000,
	}
	if err := s.InsertWorkspace(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if err := s.SetCurrentWorkspace(ctx, task.ID, ws.ID); err != nil {
		t.Fatal(err)
	}

	req := WorkspaceIntentRequest{
		TaskID:      task.ID,
		ExecutionID: "exec-1",
	}
	updated, err := eng.CompleteWorkspace(ctx, req)
	if err != nil {
		t.Fatalf("complete workspace: %v", err)
	}
	if updated.State != store.WorkspaceFinalizing {
		t.Fatalf("state=%q want finalizing", updated.State)
	}
}

func TestCancelRejectsAfterWorkspaceCommitPoint(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	engine := NewEngine(st, nil, NewBus(), 1)
	task := store.Task{
		ID: "01COMMITPOINT0000000000001", Title: "commit", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: StatusRunning, CreatedAt: store.NowMilli(),
	}
	if err := st.InsertTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	engine.mu.Lock()
	engine.workspaceCommitting[task.ID] = "execution-1"
	engine.mu.Unlock()

	if _, err := engine.Cancel(context.Background(), task.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("cancel error=%v want ErrConflict", err)
	}
	got, err := st.GetTask(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusRunning {
		t.Fatalf("status=%s want running", got.Status)
	}
}

func TestEngineCompleteWorkspaceRejectsNonActive(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	eng := NewEngine(s, nil, NewBus(), 1)
	ctx := context.Background()

	task := store.Task{
		ID: "01CMPERR00000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "running", CreatedAt: 1000,
		WorkspacePolicy: "auto",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	// Workspace in provisioning state (not active)
	ws := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: store.WorkspaceProvisioning, SourceRoot: "/repo", Scope: ".",
		CreatedAt: 1000, UpdatedAt: 1000,
	}
	if err := s.InsertWorkspace(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if err := s.SetCurrentWorkspace(ctx, task.ID, ws.ID); err != nil {
		t.Fatal(err)
	}

	req := WorkspaceIntentRequest{
		TaskID:      task.ID,
		ExecutionID: "exec-1",
	}
	_, err = eng.CompleteWorkspace(ctx, req)
	if err == nil {
		t.Fatal("expected error for non-active workspace")
	}
}

func TestCompleteWorkspaceRejectsStaleExecution(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	eng := NewEngine(s, nil, NewBus(), 1)
	eng.SetWorkspaceRuntime(&fakeWorkspaceRuntime{})
	ctx := context.Background()
	task := store.Task{
		ID: "01STALEEXEC00000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/source", Prompt: "p", Status: StatusRunning, CreatedAt: 1000,
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	ws := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: store.WorkspaceActive, SourceRoot: "/source", Scope: ".",
		RequestedExecutionID: "execution-b", CreatedAt: 1000, UpdatedAt: 1000,
	}
	if _, err := s.InsertWorkspaceAsCurrent(ctx, ws); err != nil {
		t.Fatal(err)
	}

	if _, err := eng.CompleteWorkspace(ctx, WorkspaceIntentRequest{
		TaskID: task.ID, ExecutionID: "execution-a",
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale completion error=%v want conflict", err)
	}
	got, err := s.GetWorkspace(ctx, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != store.WorkspaceActive {
		t.Fatalf("state=%q want active", got.State)
	}
}

func TestCompleteWorkspaceClearsBlockedFinalizationSnapshot(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	eng := NewEngine(s, nil, NewBus(), 1)
	eng.SetWorkspaceRuntime(&fakeWorkspaceRuntime{})
	ctx := context.Background()
	task := store.Task{
		ID: "01REFINALIZE0000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/source", Prompt: "p", Status: StatusRunning, CreatedAt: 1000,
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	ws := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: store.WorkspaceMergeBlocked, SourceRoot: "/source", Scope: ".",
		TargetBranch: "main", WorkspaceBranch: "kin/task/g1",
		PhysicalRoot: "/worktree", ExecutionCwd: "/worktree", BaseOID: "base",
		ReviewBaseOID: "old-review", FinalHeadOID: "old-head",
		FinalTreeOID: "old-tree", CompletedExecutionID: "old-exec",
		FailureReason: "conflict", CreatedAt: 1000, UpdatedAt: 1000,
	}
	if _, err := s.InsertWorkspaceAsCurrent(ctx, ws); err != nil {
		t.Fatal(err)
	}

	got, err := eng.CompleteWorkspace(ctx, WorkspaceIntentRequest{
		TaskID: task.ID, ExecutionID: "new-exec",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.State != store.WorkspaceFinalizing ||
		got.ReviewBaseOID != "" || got.FinalHeadOID != "" ||
		got.FinalTreeOID != "" || got.FailureReason != "" {
		t.Fatalf("stale finalization snapshot retained: %+v", got)
	}
}

func TestEnsureWorkspaceCreatesNewGeneration(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	eng := NewEngine(s, nil, NewBus(), 1)
	eng.SetWorkspaceRuntime(&fakeWorkspaceRuntime{})
	ctx := context.Background()

	task := store.Task{
		ID: "01ENSURE000000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "running", CreatedAt: 1000,
		WorkspacePolicy: "auto",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	req := WorkspaceIntentRequest{
		TaskID:      task.ID,
		ExecutionID: "exec-1",
	}
	ws, err := eng.ensureWorkspace(ctx, req)
	if err != nil {
		t.Fatalf("ensure workspace: %v", err)
	}
	if ws.ID == "" {
		t.Fatal("empty workspace id")
	}
	if ws.State != store.WorkspaceProvisioning {
		t.Fatalf("state=%q want provisioning", ws.State)
	}
}

func TestEnsureWorkspaceRejectsDetachedHead(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	eng := NewEngine(s, nil, NewBus(), 1)
	eng.SetWorkspaceRuntime(&fakeWorkspaceRuntime{detached: true})
	ctx := context.Background()

	task := store.Task{
		ID: "01DETACH000000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/repo", Prompt: "p", Status: "running", CreatedAt: 1000,
		WorkspacePolicy: "auto", WorkspaceSourceRoot: "/repo", WorkspaceScope: ".",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	_, err = eng.ensureWorkspace(ctx, WorkspaceIntentRequest{
		TaskID: task.ID, ExecutionID: "exec-1",
	})
	if err == nil || !strings.Contains(err.Error(), "detached HEAD") {
		t.Fatalf("err=%v want detached HEAD rejection", err)
	}
	workspaces, err := s.ListTaskWorkspaces(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaces) != 0 {
		t.Fatalf("created %d workspace(s) after branch rejection", len(workspaces))
	}
}

func TestCheckWorkspaceEventType(t *testing.T) {
	ev := store.Event{
		TaskID: "test",
		Seq:    1,
		TS:     1000,
		Type:   "workspace_active",
	}
	if !CheckWorkspaceEventType(ev, "workspace_active") {
		t.Fatal("expected true for matching type")
	}
	if CheckWorkspaceEventType(ev, "workspace_ready") {
		t.Fatal("expected false for non-matching type")
	}
}

func TestFinalizeWorkspaceUsesGenerationTargetBranchAndMetadata(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rt := &fakeWorkspaceRuntime{}
	bus := NewBus()
	eng := NewEngine(s, nil, bus, 1)
	eng.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task := store.Task{
		ID: "01FINALTGT0000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/legacy", Prompt: "p", Status: "running", CreatedAt: 1000,
		WorkspaceMode: "worktree", WorkspaceSourceRoot: "/legacy",
		WorkspaceRoot: "/legacy/root", ExecutionCwd: "/legacy/cwd",
		WorkspaceScope: "wrong-target", WorkspaceBranch: "legacy-branch",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	ws := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: store.WorkspaceFinalizing, SourceRoot: "/source", Scope: "scope",
		TargetBranch: "develop", WorkspaceBranch: "kin/task/g1",
		PhysicalRoot: "/worktree", ExecutionCwd: "/worktree/scope",
		BaseOID: "base", CompletedExecutionID: "exec-1",
		CreatedAt: 1000, UpdatedAt: 1000,
	}
	if _, err := s.InsertWorkspaceAsCurrent(ctx, ws); err != nil {
		t.Fatal(err)
	}

	sub := bus.Subscribe()
	defer bus.Unsubscribe(sub)
	status, err := eng.finalizeWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatalf("finalize workspace: %v", err)
	}
	if status != StatusSucceeded {
		t.Fatalf("status=%q", status)
	}

	rt.mu.Lock()
	gotTarget := rt.fastForwardTargetBranch
	gotMeta := rt.fastForwardMeta
	gotReleaseMeta := rt.releaseMeta
	rt.mu.Unlock()
	if gotTarget != ws.TargetBranch {
		t.Fatalf("fast-forward target=%q want %q", gotTarget, ws.TargetBranch)
	}
	if gotMeta.Root != ws.PhysicalRoot || gotMeta.Branch != ws.WorkspaceBranch {
		t.Fatalf("fast-forward metadata=%+v", gotMeta)
	}
	if gotReleaseMeta.Root != ws.PhysicalRoot {
		t.Fatalf("release metadata=%+v", gotReleaseMeta)
	}

	wantEvents := map[string]bool{
		"workspace_finalizing": false,
		"workspace_integrated": false,
		"workspace_released":   false,
	}
	deadline := time.After(time.Second)
	for {
		all := true
		for _, seen := range wantEvents {
			all = all && seen
		}
		if all {
			break
		}
		select {
		case msg := <-sub:
			if msg.Kind == "event" {
				ev := msg.Data.(store.Event)
				if _, ok := wantEvents[ev.Type]; ok {
					wantEvents[ev.Type] = true
				}
			}
		case <-deadline:
			t.Fatalf("transition events not published: %+v", wantEvents)
		}
	}
}

func TestFinalizeWorkspaceRetainsIntegratedStateWhenReleaseFails(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rt := &fakeWorkspaceRuntime{releaseErr: errors.New("remove failed")}
	eng := NewEngine(s, nil, NewBus(), 1)
	eng.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task := store.Task{
		ID: "01RELFAIL00000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/source", Prompt: "p", Status: "running", CreatedAt: 1000,
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	ws := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: store.WorkspaceFinalizing, SourceRoot: "/source", Scope: ".",
		TargetBranch: "main", WorkspaceBranch: "kin/task/g1",
		PhysicalRoot: "/worktree", ExecutionCwd: "/worktree", BaseOID: "base",
		CreatedAt: 1000, UpdatedAt: 1000,
	}
	if _, err := s.InsertWorkspaceAsCurrent(ctx, ws); err != nil {
		t.Fatal(err)
	}

	if _, err := eng.finalizeWorkspace(ctx, task.ID); err == nil {
		t.Fatal("expected release failure")
	}
	got, err := s.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != store.WorkspaceIntegrated {
		t.Fatalf("state=%q want integrated", got.State)
	}
	if got.ReleasedAt != nil {
		t.Fatalf("released_at=%v want nil", got.ReleasedAt)
	}
}

func TestReconcileFinalizingWorkspacePreservesSnapshotAfterFastForward(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rt := &fakeWorkspaceRuntime{
		finalizeInspection: &workspace.FinalizeInspection{
			HeadOID: "final-head",
			TreeOID: "final-tree",
		},
		integrationTarget: "final-head",
	}
	eng := NewEngine(s, nil, NewBus(), 1)
	eng.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task := store.Task{
		ID: "01RECOVERFINAL000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/source", Prompt: "p", Status: StatusFailed, CreatedAt: 1000,
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	ws := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: store.WorkspaceFinalizing, SourceRoot: "/source", Scope: ".",
		TargetBranch: "main", WorkspaceBranch: "kin/task/g1",
		PhysicalRoot: "/worktree", ExecutionCwd: "/worktree", BaseOID: "base",
		ReviewBaseOID: "review-base", FinalHeadOID: "final-head",
		FinalTreeOID: "final-tree", CompletedExecutionID: "exec-1",
		CreatedAt: 1000, UpdatedAt: 1000,
	}
	if _, err := s.InsertWorkspaceAsCurrent(ctx, ws); err != nil {
		t.Fatal(err)
	}

	if err := eng.reconcileWorkspaces(ctx); err != nil {
		t.Fatal(err)
	}
	gotTask, err := s.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotTask.Status != StatusSucceeded {
		t.Fatalf("task status=%q want succeeded", gotTask.Status)
	}
	gotWorkspace, err := s.GetWorkspace(ctx, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotWorkspace.State != store.WorkspaceReleased {
		t.Fatalf("workspace state=%q want released", gotWorkspace.State)
	}
	if gotWorkspace.ReviewBaseOID != ws.ReviewBaseOID {
		t.Fatalf("review base=%q want %q", gotWorkspace.ReviewBaseOID, ws.ReviewBaseOID)
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.fastForwardCalls != 0 {
		t.Fatalf("fast-forward called %d times after source already advanced", rt.fastForwardCalls)
	}
}

func TestReconcileFinalizingWorkspaceAcceptsIntegratedDescendant(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rt := &fakeWorkspaceRuntime{
		finalizeInspection: &workspace.FinalizeInspection{
			HeadOID: "final-head",
			TreeOID: "final-tree",
		},
		integrationTarget: "descendant-head",
		ancestorResult:    true,
	}
	eng := NewEngine(s, nil, NewBus(), 1)
	eng.SetWorkspaceRuntime(rt)
	ctx := context.Background()
	task := store.Task{
		ID: "01RECOVERDESC0000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/source", Prompt: "p", Status: StatusFailed, CreatedAt: 1000,
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	ws := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: store.WorkspaceFinalizing, SourceRoot: "/source", Scope: ".",
		TargetBranch: "main", WorkspaceBranch: "kin/task/g1",
		PhysicalRoot: "/worktree", ExecutionCwd: "/worktree", BaseOID: "base",
		ReviewBaseOID: "review-base", FinalHeadOID: "final-head",
		FinalTreeOID: "final-tree", CompletedExecutionID: "exec-1",
		CreatedAt: 1000, UpdatedAt: 1000,
	}
	if _, err := s.InsertWorkspaceAsCurrent(ctx, ws); err != nil {
		t.Fatal(err)
	}

	if err := eng.reconcileWorkspaces(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetWorkspace(ctx, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != store.WorkspaceReleased || got.ReviewBaseOID != ws.ReviewBaseOID {
		t.Fatalf("recovered workspace=%+v", got)
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.fastForwardCalls != 0 {
		t.Fatalf("fast-forward called %d times for integrated descendant", rt.fastForwardCalls)
	}
}

func TestReconcileIntegratedWorkspaceUsesGenerationMetadata(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rt := &fakeWorkspaceRuntime{}
	eng := NewEngine(s, nil, NewBus(), 1)
	eng.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task := store.Task{
		ID: "01RECONMETA000000000000001", Title: "t", Agent: "claude-code",
		Cwd: "/legacy", Prompt: "p", Status: StatusSucceeded, CreatedAt: 1000,
		WorkspaceMode: "worktree", WorkspaceRoot: "/legacy/root",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	ws := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: store.WorkspaceIntegrated, SourceRoot: "/source", Scope: "scope",
		WorkspaceBranch: "kin/task/g1", PhysicalRoot: "/generation/root",
		ExecutionCwd: "/generation/root/scope", BaseOID: "base",
		CreatedAt: 1000, UpdatedAt: 1000,
	}
	if _, err := s.InsertWorkspaceAsCurrent(ctx, ws); err != nil {
		t.Fatal(err)
	}

	if err := eng.reconcileWorkspaces(ctx); err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	got := rt.releaseMeta
	rt.mu.Unlock()
	if got.Root != ws.PhysicalRoot || got.Cwd != ws.ExecutionCwd || got.Branch != ws.WorkspaceBranch {
		t.Fatalf("release metadata=%+v", got)
	}
	if _, err := s.GetCurrentWorkspace(ctx, task.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("current workspace err=%v want ErrNotFound", err)
	}
}
