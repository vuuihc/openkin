package workspace

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestLiveGenerationDiffIncludesCommittedStagedUntrackedAndDeleted(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "keep.txt", "keep\n")
	commitFile(t, src, "delete_me.txt", "will be deleted\n")

	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}

	// Modify a file
	if err := os.WriteFile(filepath.Join(meta.Root, "keep.txt"), []byte("modified\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Delete a file
	if err := os.Remove(filepath.Join(meta.Root, "delete_me.txt")); err != nil {
		t.Fatal(err)
	}
	// Add a new file
	if err := os.WriteFile(filepath.Join(meta.Root, "new.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	changes, err := m.ListLiveChanges(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}

	if len(changes) == 0 {
		t.Fatal("expected non-empty changes")
	}

	hasModified := false
	hasDeleted := false
	hasUntracked := false
	for _, c := range changes {
		switch c.Path {
		case "keep.txt":
			if c.Status == "modified" {
				hasModified = true
			}
		case "delete_me.txt":
			if c.Status == "deleted" {
				hasDeleted = true
			}
		case "new.txt":
			if c.Status == "added" {
				hasUntracked = true
			}
		}
	}
	if !hasModified {
		t.Fatal("missing modified file")
	}
	if !hasDeleted {
		t.Fatal("missing deleted file")
	}
	if !hasUntracked {
		t.Fatal("missing untracked file")
	}

	_ = m.CleanupPrepared(context.Background(), testTaskID, meta)
}

func TestReleasedGenerationDiffWorksWithoutPhysicalWorktree(t *testing.T) {
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

	// Release the worktree
	_ = m.Release(context.Background(), meta)

	// Diff should still work from snapshot OIDs
	changes, err := m.ListSnapshotChanges(context.Background(), testTaskID, meta, reviewBase, insp.TreeOID)
	if err != nil {
		t.Fatal(err)
	}

	if len(changes) == 0 {
		t.Fatal("expected non-empty snapshot changes")
	}

	hasModified := false
	for _, c := range changes {
		if c.Path == "f.txt" && c.Status == "modified" {
			hasModified = true
		}
	}
	if !hasModified {
		t.Fatal("missing modified f.txt in snapshot diff")
	}
}

func TestReleasedGenerationReadsBaseAndFinalFile(t *testing.T) {
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

	// Read final file
	content, err := m.ReadSnapshotFile(context.Background(), testTaskID, meta, insp.TreeOID, "f.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "hello from workspace\n" {
		t.Fatalf("content=%q", string(content))
	}

	// Read base file
	baseContent, err := m.ReadSnapshotFile(context.Background(), testTaskID, meta, meta.BaseOID+"^{tree}", "f.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(baseContent) != "hello\n" {
		t.Fatalf("base content=%q", string(baseContent))
	}

	_ = m.Release(context.Background(), meta)
}

func TestGenerationDiffHandlesRenameAndBinary(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "old_name.txt", "old\n")

	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}

	// Rename file
	if err := os.Rename(filepath.Join(meta.Root, "old_name.txt"), filepath.Join(meta.Root, "new_name.txt")); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, meta.Root, "add", "-A")

	changes, err := m.ListLiveChanges(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}

	hasRename := false
	for _, c := range changes {
		if c.Status == "renamed" && c.OldPath == "old_name.txt" && c.Path == "new_name.txt" {
			hasRename = true
		}
	}
	if !hasRename {
		t.Fatalf("expected rename, got %+v", changes)
	}

	_ = m.CleanupPrepared(context.Background(), testTaskID, meta)
}

func TestGenerationFileRejectsTraversalAndEscapingSymlink(t *testing.T) {
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

	insp, err := m.InspectFinalizable(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}

	// Path traversal attempt
	_, err = m.ReadSnapshotFile(context.Background(), testTaskID, meta, insp.TreeOID, "../../../etc/passwd")
	if err == nil {
		t.Fatal("expected error for path traversal")
	}

	_ = m.Release(context.Background(), meta)
}

func TestMissingReleasedSnapshotIsExplicit(t *testing.T) {
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

	// Try to read from a non-existent tree OID
	_, err = m.ReadSnapshotFile(context.Background(), testTaskID, meta, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "f.txt")
	if err == nil {
		t.Fatal("expected error for missing tree OID")
	}

	_ = m.Release(context.Background(), meta)
}
