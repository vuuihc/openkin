package task

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
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

	// Create a workspace generation first
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

func TestEnsureWorkspaceCreatesNewGeneration(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	eng := NewEngine(s, nil, NewBus(), 1)
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
	ws, err := eng.ensureWorkspace(ctx, req, ProvisionFromHostRequest)
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
	}, ProvisionFromHostRequest)
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
