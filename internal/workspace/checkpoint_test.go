package workspace

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckpointCaptureAndRestore(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	root := t.TempDir()
	initRepo(t, root)
	commitFile(t, root, ".gitignore", ".env\n")
	commitFile(t, root, "tracked.txt", "base\n")
	commitFile(t, root, "deleted.txt", "delete me\n")

	meta, err := m.Prepare(context.Background(), testTaskID, root, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = m.CleanupPrepared(context.Background(), testTaskID, meta) }()

	mustWriteCheckpointFile(t, meta.Root, "tracked.txt", "checkpoint\n")
	if err := os.Remove(filepath.Join(meta.Root, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	mustWriteCheckpointFile(t, meta.Root, "new.txt", "new checkpoint\n")
	mustWriteCheckpointFile(t, meta.Root, ".env", "ignored stays local\n")

	cp, err := m.Capture(context.Background(), meta, testTaskID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if cp.HeadOID == "" || cp.TreeOID == "" || cp.SizeBytes <= 0 {
		t.Fatalf("checkpoint=%+v", cp)
	}
	objectsDir := filepath.Join(state, "checkpoints", testTaskID, "objects")
	if countCheckpointObjects(t, objectsDir) == 0 {
		t.Fatal("no private checkpoint objects written")
	}

	mustWriteCheckpointFile(t, meta.Root, "tracked.txt", "after\n")
	mustWriteCheckpointFile(t, meta.Root, "new.txt", "after new\n")
	mustWriteCheckpointFile(t, meta.Root, "later.txt", "later\n")
	mustWriteCheckpointFile(t, meta.Root, ".env", "ignored after\n")
	gitCmd(t, meta.Root, "add", "tracked.txt")
	gitCmd(t, meta.Root, "commit", "-m", "agent commit")

	if err := m.Restore(context.Background(), meta, testTaskID, cp); err != nil {
		t.Fatal(err)
	}
	if got := readCheckpointFile(t, meta.Root, "tracked.txt"); got != "checkpoint\n" {
		t.Fatalf("tracked=%q", got)
	}
	if _, err := os.Stat(filepath.Join(meta.Root, "deleted.txt")); !os.IsNotExist(err) {
		t.Fatalf("deleted file restored unexpectedly: %v", err)
	}
	if got := readCheckpointFile(t, meta.Root, "new.txt"); got != "new checkpoint\n" {
		t.Fatalf("new=%q", got)
	}
	if got := readCheckpointFile(t, meta.Root, ".env"); got != "ignored after\n" {
		t.Fatalf("ignored=%q", got)
	}
	if _, err := os.Stat(filepath.Join(meta.Root, "later.txt")); !os.IsNotExist(err) {
		t.Fatalf("later file survived clean: %v", err)
	}
	status := gitStatus(t, meta.Root)
	for _, want := range []string{" M tracked.txt", " D deleted.txt", "?? new.txt"} {
		if !strings.Contains(status, want) {
			t.Fatalf("status missing %q:\n%s", want, status)
		}
	}
}

func TestPrepareForkFromCheckpoint(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	root := t.TempDir()
	initRepo(t, root)
	commitFile(t, root, "tracked.txt", "base\n")

	meta, err := m.Prepare(context.Background(), testTaskID, root, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = m.CleanupPrepared(context.Background(), testTaskID, meta) }()

	mustWriteCheckpointFile(t, meta.Root, "tracked.txt", "checkpoint\n")
	mustWriteCheckpointFile(t, meta.Root, "new.txt", "new checkpoint\n")
	cp, err := m.Capture(context.Background(), meta, testTaskID, 1)
	if err != nil {
		t.Fatal(err)
	}

	const forkID = "01BRANCHNDEKTSV4RRFFQ69G5A"
	forkMeta, err := m.PrepareFork(context.Background(), forkID, meta, cp)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = m.CleanupPrepared(context.Background(), forkID, forkMeta) }()

	if forkMeta.Root == meta.Root {
		t.Fatal("fork reused source worktree")
	}
	if got := readCheckpointFile(t, forkMeta.Root, "tracked.txt"); got != "checkpoint\n" {
		t.Fatalf("tracked=%q", got)
	}
	if got := readCheckpointFile(t, forkMeta.Root, "new.txt"); got != "new checkpoint\n" {
		t.Fatalf("new=%q", got)
	}
}

func TestCheckpointRejectsSharedAndOversized(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	if _, err := m.Capture(context.Background(), Metadata{Mode: ResolvedShared}, testTaskID, 1); !errors.Is(err, ErrNotIsolated) {
		t.Fatalf("shared err=%v", err)
	}

	root := t.TempDir()
	initRepo(t, root)
	commitFile(t, root, "tracked.txt", "base\n")
	meta, err := m.Prepare(context.Background(), testTaskID, root, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = m.CleanupPrepared(context.Background(), testTaskID, meta) }()
	path := filepath.Join(meta.Root, "huge.bin")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(MaxCheckpointFileBytes + 1); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Capture(context.Background(), meta, testTaskID, 2); !errors.Is(err, ErrSnapshotTooLarge) {
		t.Fatalf("oversized err=%v", err)
	}
}

func mustWriteCheckpointFile(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readCheckpointFile(t *testing.T, root, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func countCheckpointObjects(t *testing.T, root string) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			n++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func gitStatus(t *testing.T, dir string) string {
	t.Helper()
	out, err := mTestGit(dir, "status", "--porcelain=v1")
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func mTestGit(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	return cmd.CombinedOutput()
}
