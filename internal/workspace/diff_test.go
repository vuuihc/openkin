package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLiveTreeAndFileUseWorktreeContents(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}

	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "tracked.txt", "source\n")
	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}
	defer m.CleanupPrepared(context.Background(), testTaskID, meta)

	if err := os.WriteFile(filepath.Join(meta.Root, "tracked.txt"), []byte("worktree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(meta.Root, "untracked.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	entries, truncated, err := m.ListLiveTree(context.Background(), meta, ".")
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("unexpected truncation")
	}
	names := make(map[string]bool, len(entries))
	for _, entry := range entries {
		names[entry.Name] = true
	}
	if !names["tracked.txt"] || !names["untracked.txt"] {
		t.Fatalf("live entries=%+v", entries)
	}

	content, err := m.ReadLiveFile(context.Background(), meta, "tracked.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "worktree\n" {
		t.Fatalf("live content=%q", content)
	}
	written, err := m.WriteLiveFile(context.Background(), meta, "tracked.txt", "edited\n")
	if err != nil {
		t.Fatal(err)
	}
	if string(written) != "edited\n" {
		t.Fatalf("written=%q", written)
	}
	onDisk, err := os.ReadFile(filepath.Join(meta.Root, "tracked.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "edited\n" {
		t.Fatalf("disk content=%q", onDisk)
	}
}

func TestResolveSourceRecordsGitBranchNotScope(t *testing.T) {
	requireGit(t)
	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "sub/file.txt", "content\n")

	m := NewManager(t.TempDir())
	meta, err := m.ResolveSource(context.Background(), filepath.Join(src, "sub"))
	if err != nil {
		t.Fatal(err)
	}
	if meta.Scope != "sub" {
		t.Fatalf("scope=%q want sub", meta.Scope)
	}
	if meta.TargetBranch != "main" {
		t.Fatalf("target branch=%q want main", meta.TargetBranch)
	}
}

func TestCapturePreparedSupportsLaterGeneration(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}
	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "tracked.txt", "source\n")
	source, err := m.ResolveSource(context.Background(), src)
	if err != nil {
		t.Fatal(err)
	}
	meta, err := m.PrepareGeneration(context.Background(), testTaskID, 2, source)
	if err != nil {
		t.Fatal(err)
	}
	defer m.CleanupPrepared(context.Background(), testTaskID, meta)

	if _, err := m.CapturePrepared(context.Background(), meta, testTaskID); err != nil {
		t.Fatalf("capture generation 2: %v", err)
	}
}

func TestLiveFileRejectsEscapingSymlinkAndOversize(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	m := NewManager(t.TempDir())
	meta := Metadata{Mode: ResolvedWorktree, Root: root, Scope: "."}

	if _, err := m.ReadLiveFile(context.Background(), meta, "escape"); err == nil {
		t.Fatal("expected escaping symlink rejection")
	}
	if _, err := m.WriteLiveFile(context.Background(), meta, "escape", "changed"); err == nil {
		t.Fatal("expected escaping symlink write rejection")
	}
	large := strings.Repeat("x", liveFileLimit+1)
	if err := os.WriteFile(filepath.Join(root, "large.txt"), []byte(large), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ReadLiveFile(context.Background(), meta, "large.txt"); err == nil {
		t.Fatal("expected oversized file rejection")
	}
}

func TestLiveFileIOResistsAncestorSymlinkSwap(t *testing.T) {
	root := t.TempDir()
	liveDir := filepath.Join(root, "live")
	parkedDir := filepath.Join(root, "live-parked")
	outsideDir := t.TempDir()
	if err := os.Mkdir(liveDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(liveDir, "note.txt"), []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	outsidePath := filepath.Join(outsideDir, "note.txt")
	if err := os.WriteFile(outsidePath, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outsideDir, "outside-only.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	swapErr := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if err := os.Rename(liveDir, parkedDir); err != nil {
				swapErr <- err
				return
			}
			if err := os.Symlink(outsideDir, liveDir); err != nil {
				swapErr <- err
				return
			}
			runtime.Gosched()
			if err := os.Remove(liveDir); err != nil {
				swapErr <- err
				return
			}
			if err := os.Rename(parkedDir, liveDir); err != nil {
				swapErr <- err
				return
			}
			runtime.Gosched()
		}
	}()

	m := NewManager(t.TempDir())
	meta := Metadata{Mode: ResolvedWorktree, Root: root, Scope: "."}
	for i := 0; i < 2000; i++ {
		data, err := m.ReadLiveFile(context.Background(), meta, "live/note.txt")
		if err == nil && string(data) == "outside" {
			close(stop)
			<-done
			t.Fatal("read escaped workspace during ancestor symlink swap")
		}
		if entries, _, err := m.ListLiveTree(context.Background(), meta, "live"); err == nil {
			for _, entry := range entries {
				if entry.Name == "outside-only.txt" {
					close(stop)
					<-done
					t.Fatal("listed files outside workspace during ancestor symlink swap")
				}
			}
		}
		_, _ = m.WriteLiveFile(context.Background(), meta, "live/note.txt", fmt.Sprintf("inside-%d", i))
	}
	close(stop)
	<-done
	select {
	case err := <-swapErr:
		t.Fatalf("swap ancestor: %v", err)
	default:
	}

	data, err := os.ReadFile(outsidePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "outside" {
		t.Fatalf("write escaped workspace during ancestor symlink swap: %q", data)
	}
}

func TestWriteLiveFileRejectsNULWithoutModifyingFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "note.txt")
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(t.TempDir())
	meta := Metadata{Mode: ResolvedWorktree, Root: root, Scope: "."}

	if _, err := m.WriteLiveFile(context.Background(), meta, "note.txt", "changed\x00content"); err == nil {
		t.Fatal("expected NUL-containing content rejection")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "original" {
		t.Fatalf("rejected write changed file: %q", data)
	}
}

func TestLiveFilePreservesScopeTypeAndWriteSizeChecks(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	scopedPath := filepath.Join(root, "sub", "note.txt")
	if err := os.WriteFile(scopedPath, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	outsideScopePath := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(outsideScopePath, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}

	m := NewManager(t.TempDir())
	meta := Metadata{Mode: ResolvedWorktree, Root: root, Scope: "sub"}
	if _, err := m.ReadLiveFile(context.Background(), meta, "outside.txt"); err == nil {
		t.Fatal("expected out-of-scope read rejection")
	}
	if _, err := m.WriteLiveFile(context.Background(), meta, "outside.txt", "changed"); err == nil {
		t.Fatal("expected out-of-scope write rejection")
	}
	if _, err := m.ReadLiveFile(context.Background(), meta, "sub"); err == nil {
		t.Fatal("expected directory read rejection")
	}
	if _, err := m.WriteLiveFile(context.Background(), meta, "sub", "changed"); err == nil {
		t.Fatal("expected directory write rejection")
	}
	if _, err := m.WriteLiveFile(
		context.Background(),
		meta,
		"sub/note.txt",
		strings.Repeat("x", liveFileLimit+1),
	); err == nil {
		t.Fatal("expected oversized write rejection")
	}
	data, err := os.ReadFile(scopedPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "original" {
		t.Fatalf("rejected write changed scoped file: %q", data)
	}
}

func TestLiveFileHidesAndRejectsGitMetadata(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git", "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "config"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(t.TempDir())
	meta := Metadata{Mode: ResolvedShared, Root: root, Scope: "."}

	entries, _, err := m.ListLiveTree(context.Background(), meta, ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.EqualFold(entry.Name, ".git") {
			t.Fatalf("Git metadata exposed in live tree: %+v", entries)
		}
	}
	for _, path := range []string{".git/config", ".GIT/config", "sub/.git/config"} {
		if _, err := m.ReadLiveFile(context.Background(), meta, path); err == nil {
			t.Fatalf("read %q should be rejected", path)
		}
		if _, err := m.WriteLiveFile(context.Background(), meta, path, "changed"); err == nil {
			t.Fatalf("write %q should be rejected", path)
		}
	}
}

func TestLiveTreeReportsTruncation(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < liveTreeLimit+1; i++ {
		name := filepath.Join(root, fmt.Sprintf("file-%03d.txt", i))
		if err := os.WriteFile(name, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m := NewManager(t.TempDir())
	entries, truncated, err := m.ListLiveTree(
		context.Background(),
		Metadata{Mode: ResolvedShared, Root: root, Scope: "."},
		".",
	)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated || len(entries) != liveTreeLimit {
		t.Fatalf("entries=%d truncated=%v", len(entries), truncated)
	}
}

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
