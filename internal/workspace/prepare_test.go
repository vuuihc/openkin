package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// valid-looking ULID (26 Crockford chars).
const testTaskID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

func TestPrepare_AutoCleanCreatesWorktree(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	root := t.TempDir()
	initRepo(t, root)
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	commitFile(t, root, "sub/a.txt", "hello\n")
	nested := filepath.Join(root, "sub")

	meta, err := m.Prepare(context.Background(), testTaskID, nested, ModeAuto)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Mode != ResolvedWorktree {
		t.Fatalf("mode=%s", meta.Mode)
	}
	wantRoot := filepath.Join(state, "worktrees", testTaskID)
	if !samePath(t, meta.Root, wantRoot) {
		t.Fatalf("root=%s want %s", meta.Root, wantRoot)
	}
	if meta.Branch != "kin/task/"+strings.ToLower(testTaskID) {
		t.Fatalf("branch=%s", meta.Branch)
	}
	if meta.Scope != "sub" {
		t.Fatalf("scope=%s", meta.Scope)
	}
	wantCwd := filepath.Join(wantRoot, "sub")
	if !samePath(t, meta.Cwd, wantCwd) {
		t.Fatalf("cwd=%s want %s", meta.Cwd, wantCwd)
	}
	if _, err := os.Stat(wantRoot); err != nil {
		t.Fatal(err)
	}
	// Source checkout unchanged: still clean, original file content.
	res, err := m.Probe(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if res.Dirty {
		t.Fatal("source became dirty")
	}
	// Cleanup
	if err := m.CleanupPrepared(context.Background(), testTaskID, meta); err != nil {
		t.Fatal(err)
	}
}

func TestPrepare_AutoDirtyShared(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "f.txt", "a\n")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, err := m.Prepare(context.Background(), testTaskID, dir, ModeAuto)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Mode != ResolvedShared {
		t.Fatalf("mode=%s", meta.Mode)
	}
	if !samePath(t, meta.Cwd, dir) {
		t.Fatalf("cwd=%s", meta.Cwd)
	}
	// No worktree dir.
	if _, err := os.Stat(filepath.Join(m.stateDir, "worktrees", testTaskID)); !os.IsNotExist(err) {
		t.Fatalf("unexpected worktree: %v", err)
	}
}

func TestPrepare_AutoNonGitShared(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	meta, err := m.Prepare(context.Background(), testTaskID, dir, ModeAuto)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Mode != ResolvedShared {
		t.Fatalf("mode=%s", meta.Mode)
	}
}

func TestPrepare_ExplicitSharedNoWorktree(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "f.txt", "a\n")
	meta, err := m.Prepare(context.Background(), testTaskID, dir, ModeShared)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Mode != ResolvedShared {
		t.Fatalf("mode=%s", meta.Mode)
	}
	if meta.BaseOID == "" {
		t.Fatal("expected base oid when git available")
	}
	if _, err := os.Stat(filepath.Join(state, "worktrees", testTaskID)); !os.IsNotExist(err) {
		t.Fatalf("worktree should not exist: %v", err)
	}
}

func TestPrepare_ExplicitWorktreeDirtySource(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "f.txt", "clean\n")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("dirty-in-source\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, err := m.Prepare(context.Background(), testTaskID, dir, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Mode != ResolvedWorktree {
		t.Fatalf("mode=%s", meta.Mode)
	}
	// Worktree should have committed content, not dirty source bytes.
	body, err := os.ReadFile(filepath.Join(meta.Root, "f.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "clean\n" {
		t.Fatalf("worktree file=%q", body)
	}
	_ = m.CleanupPrepared(context.Background(), testTaskID, meta)
}

func TestPrepare_ExplicitWorktreeNonGit(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	_, err := m.Prepare(context.Background(), testTaskID, t.TempDir(), ModeWorktree)
	if !errors.Is(err, ErrNotGit) {
		t.Fatalf("err=%v", err)
	}
}

func TestPrepare_ExplicitWorktreeUnborn(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	initRepo(t, dir)
	_, err := m.Prepare(context.Background(), testTaskID, dir, ModeWorktree)
	if !errors.Is(err, ErrNoHead) {
		t.Fatalf("err=%v", err)
	}
}

func TestPrepare_ExplicitWorktreeBare(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	gitCmd(t, dir, "init", "--bare")
	_, err := m.Prepare(context.Background(), testTaskID, dir, ModeWorktree)
	if !errors.Is(err, ErrBareRepository) {
		t.Fatalf("err=%v", err)
	}
}

func TestPrepare_InvalidMode(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	_, err := m.Prepare(context.Background(), testTaskID, t.TempDir(), RequestedMode("weird"))
	if !errors.Is(err, ErrInvalidMode) {
		t.Fatalf("err=%v", err)
	}
}

func TestPrepare_InvalidTaskID(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "f.txt", "a\n")
	_, err := m.Prepare(context.Background(), "not-a-ulid", dir, ModeWorktree)
	if !errors.Is(err, ErrInvalidTaskID) {
		t.Fatalf("err=%v", err)
	}
}

func TestPrepare_PreexistingWorktreeDir(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "f.txt", "a\n")
	pre := filepath.Join(state, "worktrees", testTaskID)
	if err := os.MkdirAll(pre, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pre, "marker"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := m.Prepare(context.Background(), testTaskID, dir, ModeWorktree)
	if !errors.Is(err, ErrWorktreeExists) {
		t.Fatalf("err=%v", err)
	}
	// Must not delete preexisting.
	if _, err := os.Stat(filepath.Join(pre, "marker")); err != nil {
		t.Fatal("preexisting dir was modified")
	}
}

func TestCleanupPrepared_RefusesSharedAndOutside(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	err := m.CleanupPrepared(context.Background(), testTaskID, Metadata{Mode: ResolvedShared})
	if !errors.Is(err, ErrNotIsolated) {
		t.Fatalf("err=%v", err)
	}
	err = m.CleanupPrepared(context.Background(), testTaskID, Metadata{
		Mode:       ResolvedWorktree,
		Root:       filepath.Join(t.TempDir(), "outside"),
		SourceRoot: t.TempDir(),
		Branch:     "kin/task/x",
	})
	if !errors.Is(err, ErrNotIsolated) {
		t.Fatalf("err=%v", err)
	}
}

func TestCleanupPrepared_RemovesWorktree(t *testing.T) {
	requireGit(t)
	state := t.TempDir()
	m := NewManager(state)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "f.txt", "a\n")
	meta, err := m.Prepare(context.Background(), testTaskID, dir, ModeWorktree)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.CleanupPrepared(context.Background(), testTaskID, meta); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(meta.Root); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists: %v", err)
	}
	// Branch should be gone.
	cmdOut, err := m.git.Run(context.Background(), dir, nil, ControlStdoutLimit, "branch", "--list", meta.Branch)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(cmdOut)) != "" {
		t.Fatalf("branch still listed: %q", cmdOut)
	}
}

func TestMetadata_EffectiveCwd(t *testing.T) {
	if (Metadata{Cwd: "/a"}).EffectiveCwd("/b") != "/a" {
		t.Fatal()
	}
	if (Metadata{}).EffectiveCwd("/b") != "/b" {
		t.Fatal()
	}
}
