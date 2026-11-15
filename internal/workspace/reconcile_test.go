package workspace

import (
	"context"
	"os"
	"testing"
)

func TestReconcileMissingActiveWorkspaceAsOrphaned(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "f.txt", "hello\n")

	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}

	// Remove the worktree to simulate missing physical state
	if err := os.RemoveAll(meta.Root); err != nil {
		t.Fatal(err)
	}

	report, err := m.ReconcileWorkspace(context.Background(), meta, "active", "ws-1", testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Outcome != ReconcileOrphaned {
		t.Fatalf("outcome=%q want orphaned", report.Outcome)
	}
	if report.State != "orphaned" {
		t.Fatalf("state=%q want orphaned", report.State)
	}
}

func TestReconcileFinalizingWorkspaceCompletes(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "f.txt", "hello\n")

	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}

	// Commit to make it clean
	commitFile(t, meta.Root, "f.txt", "hello from workspace\n")

	report, err := m.ReconcileWorkspace(context.Background(), meta, "finalizing", "ws-1", testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Outcome != ReconcileCompleted {
		t.Fatalf("outcome=%q want completed", report.Outcome)
	}

	_ = m.CleanupPrepared(context.Background(), testTaskID, meta)
}

func TestReconcileReadyWorkspaceRequestsResume(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "f.txt", "hello\n")

	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}

	report, err := m.ReconcileWorkspace(context.Background(), meta, "ready", "ws-1", testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Outcome != ReconcileResumeRequest {
		t.Fatalf("outcome=%q want resume_request", report.Outcome)
	}

	_ = m.CleanupPrepared(context.Background(), testTaskID, meta)
}

func TestReconcileAfterFastForwardBeforeIntegratedRecord(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "f.txt", "hello\n")

	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}

	commitFile(t, meta.Root, "f.txt", "hello from workspace\n")

	// Fast-forward but don't mark integrated in DB (simulating crash)
	_, err = m.FinalizeFastForward(context.Background(), meta, "main")
	if err != nil {
		t.Fatal(err)
	}

	// Reconcile in finalizing state — should report completed
	report, err := m.ReconcileWorkspace(context.Background(), meta, "finalizing", "ws-1", testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Outcome != ReconcileCompleted {
		t.Fatalf("outcome=%q want completed", report.Outcome)
	}

	_ = m.Release(context.Background(), meta)
}

func TestReconcileActiveWorkspacePresent(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "f.txt", "hello\n")

	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}

	report, err := m.ReconcileWorkspace(context.Background(), meta, "active", "ws-1", testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Outcome != ReconcileResumeRequest {
		t.Fatalf("outcome=%q want resume_request", report.Outcome)
	}

	_ = m.CleanupPrepared(context.Background(), testTaskID, meta)
}

func TestReconcileIntegratedCleansUp(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "f.txt", "hello\n")

	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}

	commitFile(t, meta.Root, "f.txt", "hello from workspace\n")
	_, err = m.FinalizeFastForward(context.Background(), meta, "main")
	if err != nil {
		t.Fatal(err)
	}

	report, err := m.ReconcileWorkspace(context.Background(), meta, "integrated", "ws-1", testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Outcome != ReconcileAlreadyRemoved {
		t.Fatalf("outcome=%q want already_removed", report.Outcome)
	}

	// Worktree should be cleaned up
	if _, err := os.Stat(meta.Root); !os.IsNotExist(err) {
		t.Fatal("worktree should have been cleaned up")
	}
}

func TestReconcileReleasedCleansUp(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "f.txt", "hello\n")

	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}

	commitFile(t, meta.Root, "f.txt", "hello from workspace\n")
	_, err = m.FinalizeFastForward(context.Background(), meta, "main")
	if err != nil {
		t.Fatal(err)
	}
	_ = m.Release(context.Background(), meta)

	report, err := m.ReconcileWorkspace(context.Background(), meta, "released", "ws-1", testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Outcome != ReconcileAlreadyRemoved {
		t.Fatalf("outcome=%q want already_removed", report.Outcome)
	}
}
