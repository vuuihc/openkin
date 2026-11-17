package workspace

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
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

// A download opens the file instead of reading it into memory: the same
// containment as every other live read, no preview cap, and the caller owns
// what it gets.
func TestOpenLiveFileStreamsWithoutThePreviewCap(t *testing.T) {
	root := t.TempDir()
	m := NewManager(t.TempDir())
	meta := Metadata{Mode: ResolvedWorktree, Root: root, Scope: "."}
	big := bytes.Repeat([]byte{0x2a}, int(rawFileLimit)+1)
	if err := os.WriteFile(filepath.Join(root, "talk.mp4"), big, 0o600); err != nil {
		t.Fatal(err)
	}

	file, info, err := m.OpenLiveFile(context.Background(), meta, "talk.mp4")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if info.Size() != int64(len(big)) {
		t.Fatalf("size = %d, want %d", info.Size(), len(big))
	}
	got := make([]byte, len(big))
	if _, err := io.ReadFull(file, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, big) {
		t.Fatal("streamed bytes differ from the file")
	}

	// A download widens what may be read, not where it may be read from.
	if _, _, err := m.OpenLiveFile(context.Background(), meta, "."); err == nil {
		t.Fatal("expected a directory to be refused")
	}
	outside := filepath.Join(t.TempDir(), "secret.mp4")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.mp4")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.OpenLiveFile(context.Background(), meta, "escape.mp4"); err == nil {
		t.Fatal("expected an escaping symlink to be refused")
	}
}

// The preview path reads the bytes the text path refuses, and refuses the same
// places and the same sizes: widening what may be read must not widen where it
// may be read from.
func TestLiveFileRawReadsWhatTheTextPathRefuses(t *testing.T) {
	root := t.TempDir()
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	if err := os.WriteFile(filepath.Join(root, "shot.png"), png, 0o600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(t.TempDir())
	meta := Metadata{Mode: ResolvedWorktree, Root: root, Scope: "."}

	if _, err := m.ReadLiveFile(context.Background(), meta, "shot.png"); err == nil {
		t.Fatal("expected the text path to refuse an image")
	}
	data, err := m.ReadLiveFileRaw(context.Background(), meta, "shot.png")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, png) {
		t.Fatalf("raw bytes = %q", data)
	}

	// 1 MiB is the text cap, not the preview cap: a screenshot over it is still
	// a screenshot, and refusing it would be the bug this read exists to fix.
	mid := bytes.Repeat([]byte{0x89}, liveFileLimit+1)
	if err := os.WriteFile(filepath.Join(root, "mid.png"), mid, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ReadLiveFile(context.Background(), meta, "mid.png"); err == nil {
		t.Fatal("expected the text path to refuse a file over its cap")
	}
	if data, err := m.ReadLiveFileRaw(context.Background(), meta, "mid.png"); err != nil || len(data) != len(mid) {
		t.Fatalf("raw read of a preview-sized image: len=%d err=%v", len(data), err)
	}

	outside := filepath.Join(t.TempDir(), "secret.png")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ReadLiveFileRaw(context.Background(), meta, "escape.png"); err == nil {
		t.Fatal("expected raw read of an escaping symlink to be refused")
	}

	over := make([]byte, rawFileLimit+1)
	if err := os.WriteFile(filepath.Join(root, "huge.png"), over, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ReadLiveFileRaw(context.Background(), meta, "huge.png"); !errors.Is(err, ErrOutputTooLarge) {
		t.Fatalf("oversized raw read error = %v, want ErrOutputTooLarge", err)
	}
}

// statusByPath is the change list as the console reads it: one status per path.
func statusByPath(changes []Change) map[string]string {
	status := make(map[string]string, len(changes))
	for _, change := range changes {
		status[change.Path] = change.Status
	}
	return status
}

// A checkout that has committed a round of work has changes, and the live list
// is not the place they show up: `git diff HEAD` is the uncommitted answer by
// definition. The branch list is the one that carries the work a session already
// committed, against the base the checkout was started from.
func TestListBranchChangesIncludesCommittedWork(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "base.txt", "base\n")
	gitCmd(t, src, "branch", "-m", "main")
	gitCmd(t, src, "checkout", "-q", "-b", "feature")
	commitFile(t, src, "feature.txt", "feature\n")
	// A binary file carries the flag the console reads, with no line counts.
	commitFile(t, src, "image.bin", "\x00\x01binary\n")
	// The tracked base is the branch's own upstream, which is where the base
	// ref comes from first.
	gitCmd(t, src, "branch", "--set-upstream-to=main", "feature")

	if err := os.WriteFile(filepath.Join(src, "base.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "untracked.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	meta := SharedMetadata(src)
	live, err := m.ListLiveChanges(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}
	liveStatus := statusByPath(live)
	if liveStatus["base.txt"] != "modified" || liveStatus["untracked.txt"] != "added" {
		t.Fatalf("live changes = %v, want the modified and untracked files", liveStatus)
	}
	if _, ok := liveStatus["feature.txt"]; ok {
		t.Fatalf("live changes = %v, want no committed work: ListLiveChanges is the uncommitted answer", liveStatus)
	}

	branch, err := m.ListBranchChanges(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}
	branchStatus := statusByPath(branch)
	if branchStatus["feature.txt"] != "added" {
		t.Errorf("branch changes = %v, want the committed feature.txt", branchStatus)
	}
	if branchStatus["base.txt"] != "modified" || branchStatus["untracked.txt"] != "added" {
		t.Errorf("branch changes = %v, want the uncommitted work too", branchStatus)
	}
	// The counts come from one numstat pass and still land on the files the
	// status pass named.
	for _, change := range branch {
		switch change.Path {
		case "feature.txt":
			if change.Additions != 1 || change.Deletions != 0 {
				t.Errorf("feature.txt = %+v, want 1 addition", change)
			}
		case "base.txt":
			if change.Additions != 1 || change.Deletions != 1 {
				t.Errorf("base.txt = %+v, want 1 addition and 1 deletion", change)
			}
		case "image.bin":
			if !change.Binary || change.Additions != 0 || change.Deletions != 0 {
				t.Errorf("image.bin = %+v, want a binary entry with no counts", change)
			}
		}
	}
}

// pushedCheckout is a checkout whose main is pushed to a local origin, the way
// a clone has one: refs/remotes/origin/main exists, main tracks it, and
// origin/HEAD names it.
func pushedCheckout(t *testing.T) string {
	t.Helper()
	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "tracked.txt", "one\n")
	gitCmd(t, src, "branch", "-m", "main")
	remote := filepath.Join(t.TempDir(), "origin.git")
	gitCmd(t, src, "init", "--bare", remote)
	gitCmd(t, src, "remote", "add", "origin", remote)
	gitCmd(t, src, "push", "-q", "-u", "origin", "main")
	gitCmd(t, src, "remote", "set-head", "origin", "main")
	return src
}

// Sitting exactly on the base ref is the regression case, not a mode: the merge
// base is HEAD, so the branch answer is today's answer, byte for byte.
func TestListBranchChangesOnBaseBranchMatchesLiveChanges(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	src := pushedCheckout(t)

	if err := os.WriteFile(filepath.Join(src, "tracked.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "untracked.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	meta := SharedMetadata(src)
	live, err := m.ListLiveChanges(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}
	branch, err := m.ListBranchChanges(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(live, branch) {
		t.Fatalf("branch changes = %+v, want the live answer %+v on the base branch", branch, live)
	}
}

// A directory git only half-knows is still answered the way it always was: no
// upstream, no origin, nothing to measure from, and the answer falls back to
// HEAD rather than becoming an error.
func TestListBranchChangesWithoutBaseFallsBackToHEAD(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "tracked.txt", "one\n")
	if err := os.WriteFile(filepath.Join(src, "tracked.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	meta := SharedMetadata(src)
	live, err := m.ListLiveChanges(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}
	branch, err := m.ListBranchChanges(context.Background(), meta)
	if err != nil {
		t.Fatalf("no base should fall back to HEAD, not fail: %v", err)
	}
	if !reflect.DeepEqual(live, branch) {
		t.Fatalf("branch changes = %+v, want the live answer %+v with no base", branch, live)
	}
}

// The measurement is the merge base, not the base branch's tip: a branch that
// forked before main moved on should not report main's later commits, and
// certainly not as deletions of this working tree.
func TestListBranchChangesMeasuresFromTheMergeBaseNotTheBaseTip(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "shared.txt", "base\n")
	gitCmd(t, src, "branch", "-m", "main")
	gitCmd(t, src, "checkout", "-q", "-b", "feature")
	commitFile(t, src, "feature.txt", "feature\n")
	gitCmd(t, src, "branch", "--set-upstream-to=main", "feature")
	// The base moves on after this branch forked.
	gitCmd(t, src, "checkout", "-q", "main")
	commitFile(t, src, "base-only.txt", "later\n")
	gitCmd(t, src, "checkout", "-q", "feature")

	changes, err := m.ListBranchChanges(context.Background(), SharedMetadata(src))
	if err != nil {
		t.Fatal(err)
	}
	status := statusByPath(changes)
	if status["feature.txt"] != "added" {
		t.Errorf("changes = %v, want this branch's own commit", status)
	}
	if _, ok := status["base-only.txt"]; ok {
		t.Fatalf("changes = %v, want no file from a commit this branch does not contain", status)
	}
}

// Without an upstream, the base is the remote's default branch. Both shapes git
// records it in are read: the symbolic ref a clone writes, and a direct ref left
// by a hand-added remote. A detached checkout keeps that answer, because the
// base is about history, not about which branch is checked out.
func TestListBranchChangesBaseFromTheRemoteDefault(t *testing.T) {
	requireGit(t)
	cases := []struct {
		name    string
		prepare func(t *testing.T, src string)
	}{
		{"symbolic origin/HEAD", func(t *testing.T, src string) {
			gitCmd(t, src, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
		}},
		{"direct origin/HEAD", func(t *testing.T, src string) {
			gitCmd(t, src, "update-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
		}},
		{"detached HEAD with origin/HEAD", func(t *testing.T, src string) {
			gitCmd(t, src, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
			gitCmd(t, src, "checkout", "-q", "--detach")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := NewManager(t.TempDir())
			src := pushedCheckout(t)
			gitCmd(t, src, "checkout", "-q", "-b", "feature")
			commitFile(t, src, "feature.txt", "feature\n")
			tc.prepare(t, src)

			changes, err := m.ListBranchChanges(context.Background(), SharedMetadata(src))
			if err != nil {
				t.Fatal(err)
			}
			if statusByPath(changes)["feature.txt"] != "added" {
				t.Fatalf("changes = %v, want the committed feature.txt measured from the remote default", changes)
			}
		})
	}
}

// A commit made on the base branch itself is unreviewed work too: with main
// tracking origin/main, a local commit on main is in the answer.
func TestListBranchChangesIncludesLocalCommitsOnTheBaseBranch(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	src := pushedCheckout(t)
	commitFile(t, src, "local.txt", "unpushed\n")

	changes, err := m.ListBranchChanges(context.Background(), SharedMetadata(src))
	if err != nil {
		t.Fatal(err)
	}
	if statusByPath(changes)["local.txt"] != "added" {
		t.Fatalf("changes = %v, want the local commit on the base branch", changes)
	}
}

// Kin's own Publish pushes with --set-upstream, so a published branch tracks its
// own remote counterpart. Measured from there the merge base is HEAD: the panel
// would empty the moment a round was pushed, and every later round would show
// only what is still unpushed. The base stays the branch this one forked from.
func TestListBranchChangesIgnoresUpstreamThatIsOwnRemoteCounterpart(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	src := pushedCheckout(t)
	gitCmd(t, src, "checkout", "-q", "-b", "feature")
	commitFile(t, src, "feature.txt", "feature\n")
	// Publish, the way Kin's Publish does: feature now tracks origin/feature.
	gitCmd(t, src, "push", "-q", "-u", "origin", "feature")
	// A later round commits and pushes again, leaving HEAD == its upstream.
	commitFile(t, src, "second.txt", "second\n")
	gitCmd(t, src, "push", "-q", "origin", "feature")

	changes, err := m.ListBranchChanges(context.Background(), SharedMetadata(src))
	if err != nil {
		t.Fatal(err)
	}
	status := statusByPath(changes)
	if status["feature.txt"] != "added" || status["second.txt"] != "added" {
		t.Fatalf("changes = %v, want the branch's committed work after publishing it", status)
	}
}

// A base ref that shares no history with HEAD is not a base: merge-base fails,
// and the answer falls back to HEAD rather than erroring or measuring from an
// unrelated tip.
func TestListBranchChangesUnrelatedBaseFallsBackToHEAD(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	src := t.TempDir()
	initRepo(t, src)
	commitFile(t, src, "tracked.txt", "one\n")
	gitCmd(t, src, "branch", "-m", "main")
	// An orphan branch has its own root commit and no common ancestor.
	gitCmd(t, src, "checkout", "-q", "--orphan", "unrelated")
	commitFile(t, src, "other.txt", "other\n")
	gitCmd(t, src, "checkout", "-q", "main")
	commitFile(t, src, "committed.txt", "work\n")
	gitCmd(t, src, "branch", "--set-upstream-to=unrelated", "main")

	meta := SharedMetadata(src)
	live, err := m.ListLiveChanges(context.Background(), meta)
	if err != nil {
		t.Fatal(err)
	}
	branch, err := m.ListBranchChanges(context.Background(), meta)
	if err != nil {
		t.Fatalf("an unrelated base should fall back to HEAD, not fail: %v", err)
	}
	if !reflect.DeepEqual(live, branch) {
		t.Fatalf("branch changes = %+v, want the live answer %+v", branch, live)
	}
}
