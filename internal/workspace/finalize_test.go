package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFinalizeFastForwardsAndReleases(t *testing.T) {
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

	insp, err := m.InspectFinalizable(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}
	if insp.HeadOID == "" || insp.TreeOID == "" {
		t.Fatal("empty OIDs")
	}
	if insp.Dirty {
		t.Fatal("unexpected dirty")
	}

	integratedOID, err := m.FinalizeFastForward(context.Background(), meta, "main")
	if err != nil {
		t.Fatal(err)
	}
	if integratedOID == "" {
		t.Fatal("empty integrated OID")
	}

	if err := m.Release(context.Background(), meta); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(meta.Root); !os.IsNotExist(err) {
		t.Fatal("worktree still exists after release")
	}
}

func TestFinalizeRejectsUncommittedWorkspace(t *testing.T) {
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

	if err := os.WriteFile(filepath.Join(meta.Root, "f.txt"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err = m.InspectFinalizable(context.Background(), meta)
	if err == nil {
		t.Fatal("expected error for dirty workspace")
	}
	if !strings.Contains(err.Error(), "uncommitted") {
		t.Fatalf("err=%v", err)
	}

	_ = m.CleanupPrepared(context.Background(), testTaskID, meta)
}

func TestFinalizeRejectsDirtySource(t *testing.T) {
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

	if err := os.WriteFile(filepath.Join(src, "f.txt"), []byte("dirty source\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err = m.FinalizeFastForward(context.Background(), meta, "main")
	if err == nil {
		t.Fatal("expected error for dirty source")
	}
	if !strings.Contains(err.Error(), "dirty") {
		t.Fatalf("err=%v", err)
	}

	_ = m.CleanupPrepared(context.Background(), testTaskID, meta)
}

func TestFinalizeBlocksNonFastForwardWithoutTouchingSource(t *testing.T) {
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

	// Make a divergent commit in source
	commitFile(t, src, "other.txt", "external\n")

	// Commit in workspace (divergent)
	commitFile(t, meta.Root, "f.txt", "hello from workspace\n")

	// Record source HEAD before merge attempt
	headBefore, err := m.git.Run(context.Background(), src, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+m.emptyHooksDir(), "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}

	_, err = m.FinalizeFastForward(context.Background(), meta, "main")
	if err == nil {
		t.Fatal("expected non-fast-forward error")
	}

	// Source HEAD should be unchanged after failed merge
	headAfter, err := m.git.Run(context.Background(), src, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+m.emptyHooksDir(), "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(headBefore)) != strings.TrimSpace(string(headAfter)) {
		t.Fatal("source HEAD changed after failed merge")
	}

	_ = m.CleanupPrepared(context.Background(), testTaskID, meta)
}

func TestFinalizeDoesNotRunRepositoryHooks(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "f.txt", "hello\n")

	hooksDir := filepath.Join(src, ".git", "hooks")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(src, "HOOK_RAN_MARKER")
	hookScript := "#!/bin/sh\necho 'HOOK RAN' > " + markerPath + "\n"
	if err := os.WriteFile(filepath.Join(hooksDir, "post-merge"), []byte(hookScript), 0o755); err != nil {
		t.Fatal(err)
	}

	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}

	commitFile(t, meta.Root, "f.txt", "hello from workspace\n")

	_, err = m.FinalizeFastForward(context.Background(), meta, "main")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(markerPath); err == nil {
		t.Fatal("repository hook ran when it should have been suppressed")
	}

	_ = m.Release(context.Background(), meta)
}

func TestReleaseNeverRunsBeforeSnapshot(t *testing.T) {
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

	if err := m.Release(context.Background(), meta); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(meta.Root); !os.IsNotExist(err) {
		t.Fatal("worktree still exists after release")
	}
}

func TestReleaseIsIdempotentAfterIntegration(t *testing.T) {
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

	if err := m.Release(context.Background(), meta); err != nil {
		t.Fatal(err)
	}

	if err := m.Release(context.Background(), meta); err != nil {
		t.Fatalf("second release should be idempotent: %v", err)
	}
}

func TestFinalizeRejectsWorkspaceHeadChangedAfterSnapshot(t *testing.T) {
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

	insp, err := m.InspectFinalizable(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}

	reviewBase, err := m.InspectIntegrationTarget(context.Background(), meta, "main")
	if err != nil {
		t.Fatal(err)
	}

	// Make another commit in workspace (HEAD moved after snapshot)
	commitFile(t, meta.Root, "extra.txt", "extra\n")

	// FastForward with the old snapshot OID should fail
	_, err = m.FastForward(context.Background(), meta, "main", reviewBase, insp.HeadOID)
	if err == nil {
		t.Fatal("expected error when workspace HEAD changed after snapshot")
	}
	if !strings.Contains(err.Error(), "HEAD changed after snapshot") {
		t.Fatalf("err=%v", err)
	}

	_ = m.Release(context.Background(), meta)
}
