package task

import (
	"context"
	"path/filepath"
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

	// Request workspace promotion
	req := WorkspaceIntentRequest{
		TaskID:      task.ID,
		ExecutionID: "exec-1",
		Agent:       "claude-code",
	}
	updated, err := eng.RequestWorkspace(ctx, req)
	if err != nil {
		t.Fatalf("request workspace: %v", err)
	}
	if updated.State != store.WorkspaceActive {
		t.Fatalf("state=%q want active", updated.State)
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
