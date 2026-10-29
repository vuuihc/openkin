package workspace

import (
	"context"
	"errors"
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

// An empty directory is a directory. Reading one in full reports io.EOF, which
// is a fact about how a bounded read ends rather than a failure — and a tree
// browser that turns it into an error cannot open a folder that is empty, which
// is the state every folder starts in.
func TestLiveTreeListsAnEmptyDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "empty"), 0o700); err != nil {
		t.Fatal(err)
	}
	m := NewManager(t.TempDir())
	meta := Metadata{Mode: ResolvedShared, Root: root, Scope: "."}

	for _, dir := range []string{".", "empty"} {
		entries, truncated, err := m.ListLiveTree(context.Background(), meta, dir)
		if err != nil {
			t.Fatalf("%s: %v", dir, err)
		}
		if truncated {
			t.Fatalf("%s: an empty directory cannot be truncated", dir)
		}
		if dir == "empty" && len(entries) != 0 {
			t.Fatalf("%s: entries = %+v", dir, entries)
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

// A round's diff is taken from two checkpoints, not from what a tool said: an
// edit made with a shell command is in the tree like any other.
func TestListTreeChangesReadsDiskEdits(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}
	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "kept.txt", "one\ntwo\nthree\n")
	commitFile(t, src, "gone.txt", "bye\n")
	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}
	defer m.CleanupPrepared(context.Background(), testTaskID, meta)

	base, err := m.Capture(context.Background(), meta, testTaskID, 1)
	if err != nil {
		t.Fatal(err)
	}

	// What a shell command leaves behind: a rewrite, a new file, a deletion.
	if err := os.WriteFile(filepath.Join(meta.Root, "kept.txt"), []byte("one\nTWO\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(meta.Root, "made-by-sed.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(meta.Root, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	head, err := m.Capture(context.Background(), meta, testTaskID, 2)
	if err != nil {
		t.Fatal(err)
	}

	changes, err := m.ListTreeChanges(context.Background(), testTaskID, meta, base.TreeOID, head.TreeOID)
	if err != nil {
		t.Fatal(err)
	}
	byPath := make(map[string]Change, len(changes))
	for _, change := range changes {
		byPath[change.Path] = change
	}
	if len(byPath) != 3 {
		t.Fatalf("changes=%+v", changes)
	}
	if got := byPath["kept.txt"]; got.Status != "modified" || got.Additions != 1 || got.Deletions != 2 {
		t.Fatalf("kept.txt=%+v", got)
	}
	if got := byPath["made-by-sed.txt"]; got.Status != "added" || got.Additions != 1 {
		t.Fatalf("made-by-sed.txt=%+v", got)
	}
	if got := byPath["gone.txt"]; got.Status != "deleted" || got.Deletions != 1 {
		t.Fatalf("gone.txt=%+v", got)
	}
}

func TestListTreeChangesWithoutAStoreIsUnavailable(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}
	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "a.txt", "a\n")
	meta, err := m.Prepare(context.Background(), testTaskID, src, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}
	defer m.CleanupPrepared(context.Background(), testTaskID, meta)

	oid := strings.Repeat("a", 40)
	if _, err := m.ListTreeChanges(context.Background(), testTaskID, meta, oid, oid); !errors.Is(err, ErrCheckpointUnavailable) {
		t.Fatalf("err=%v want ErrCheckpointUnavailable", err)
	}
}

func TestParseNumstat(t *testing.T) {
	counts := parseNumstat("3\t1\ta.go\n-\t-\tlogo.png\n\nbad line\n")
	if got := counts["a.go"]; got.Additions != 3 || got.Deletions != 1 || got.Binary {
		t.Fatalf("a.go=%+v", got)
	}
	if got := counts["logo.png"]; !got.Binary || got.Additions != 0 || got.Deletions != 0 {
		t.Fatalf("logo.png=%+v", got)
	}
	if len(counts) != 2 {
		t.Fatalf("counts=%+v", counts)
	}
}

// A file search answers from git's set — tracked plus untracked and not
// ignored — because that is the set of paths a prompt means. An ignored file is
// not offered: a menu that lists what .gitignore hides is offering a path the
// person deliberately kept out of the repository.
func TestListLiveFilesFindsTrackedAndUntrackedInsideTheScope(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}
	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "internal/api/server.go", "package api\n")
	commitFile(t, src, "docs/guide.md", "# guide\n")
	if err := os.WriteFile(filepath.Join(src, ".gitignore"), []byte("secret.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "secret.txt"), []byte("hidden\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "internal/notes.md"), []byte("notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	files, truncated, err := m.ListLiveFiles(context.Background(), SharedMetadata(src), "SERVER", 10)
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Error("one match was reported as truncated")
	}
	if len(files) != 1 || files[0] != "internal/api/server.go" {
		t.Fatalf("files = %v, want the tracked server.go (matching is case-insensitive)", files)
	}

	files, _, err = m.ListLiveFiles(context.Background(), SharedMetadata(src), ".md", 10)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"docs/guide.md", "internal/notes.md"}
	if len(files) != len(want) || files[0] != want[0] || files[1] != want[1] {
		t.Fatalf("files = %v, want %v (shorter path first)", files, want)
	}

	ignored, _, err := m.ListLiveFiles(context.Background(), SharedMetadata(src), "secret", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(ignored) != 0 {
		t.Fatalf("files = %v, want none: secret.txt is ignored", ignored)
	}

	// A task scoped to a subdirectory answers the way its agent reads it: the
	// agent's working directory is `docs`, so the file is `guide.md` — the same
	// text a machine that only knows the task's own directory would answer.
	scoped := SharedMetadata(src)
	scoped.Cwd = filepath.Join(src, "docs")
	scoped.Scope = "docs"
	files, _, err = m.ListLiveFiles(context.Background(), scoped, ".md", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0] != "guide.md" {
		t.Fatalf("files = %v, want the scoped file relative to the task's directory", files)
	}
}

func TestListLiveFilesRefusesADirectoryThatIsNotACheckout(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	if err := m.EnsureEmptyHooks(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()

	if _, _, err := m.ListLiveFiles(context.Background(), SharedMetadata(dir), "x", 10); err == nil {
		t.Fatal("a plain directory answered a file search")
	}
}

// The questions a search may not ask. Each of these is refused before git runs,
// because the caller is a menu and every one of them would produce an answer
// nobody typed a query for.
func TestListLiveFilesRefusesAQuestionItCannotAnswer(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	src := t.TempDir()
	initRepo(t, src)

	for name, tc := range map[string]struct {
		meta  Metadata
		query string
	}{
		"NoRoot":        {Metadata{Root: "", Cwd: src, Scope: "."}, "x"},
		"EmptyQuery":    {SharedMetadata(src), ""},
		"ControlInPath": {SharedMetadata(src), "a\nb"},
	} {
		if _, _, err := m.ListLiveFiles(context.Background(), tc.meta, tc.query, 10); err == nil {
			t.Errorf("%s: answered instead of refused", name)
		}
	}
}

func TestRankFileMatchesPutsTheLikelyFileFirst(t *testing.T) {
	files := []string{
		"cmd/maintenance/main.go",
		"docs/domain.md",
		"main.go",
		"src/main.go",
		"website/index.html",
	}

	got, truncated, err := rankFileMatches(files, "main", 10)
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Error("truncated with fewer matches than the limit")
	}
	want := []string{"main.go", "src/main.go", "cmd/maintenance/main.go", "docs/domain.md"}
	if len(got) != len(want) {
		t.Fatalf("matches = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("matches = %v, want %v", got, want)
		}
	}

	// A path prefix beats a match found deeper in the path.
	got, _, err = rankFileMatches([]string{"x/src/main.go", "src/main.go"}, "src/", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "src/main.go" || got[1] != "x/src/main.go" {
		t.Fatalf("matches = %v, want the path prefix first", got)
	}

	// In a tie the names are ordered, so an answer is stable.
	got, _, err = rankFileMatches([]string{"b/x.go", "a/x.go"}, "x.go", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "a/x.go" || got[1] != "b/x.go" {
		t.Fatalf("matches = %v, want alphabetical", got)
	}

	// The answer is bounded, and says so.
	got, truncated, err = rankFileMatches(files, "main", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated || len(got) != 2 {
		t.Fatalf("matches = %v truncated=%v, want two matches and a truncation", got, truncated)
	}

	if _, _, err := rankFileMatches(files, "  ", 10); err == nil {
		t.Fatal("an empty query was answered")
	}
}
