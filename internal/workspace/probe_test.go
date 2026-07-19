package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func requireGit(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	return path
}

func gitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=Kin Test",
		"GIT_AUTHOR_EMAIL=kin@test.local",
		"GIT_COMMITTER_NAME=Kin Test",
		"GIT_COMMITTER_EMAIL=kin@test.local",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func initRepo(t *testing.T, dir string) {
	t.Helper()
	gitCmd(t, dir, "init")
	gitCmd(t, dir, "config", "user.email", "kin@test.local")
	gitCmd(t, dir, "config", "user.name", "Kin Test")
}

func commitFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	path := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "add", rel)
	gitCmd(t, dir, "commit", "-m", "add "+rel)
}

func TestProbe_NonGit(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	res, err := m.Probe(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.IsGit {
		t.Fatalf("IsGit=true")
	}
	if res.RecommendedMode != string(ResolvedShared) {
		t.Fatalf("mode=%s", res.RecommendedMode)
	}
	if res.CanWorktree {
		t.Fatal("CanWorktree")
	}
}

func TestProbe_CleanRoot(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	res, err := m.Probe(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsGit || res.IsBare || !res.HasHead || res.Dirty {
		t.Fatalf("%+v", res)
	}
	if !res.CanWorktree {
		t.Fatal("CanWorktree=false")
	}
	if res.RecommendedMode != string(ResolvedWorktree) {
		t.Fatalf("mode=%s", res.RecommendedMode)
	}
	if res.Scope != "." {
		t.Fatalf("scope=%q", res.Scope)
	}
	if res.HeadOID == "" || res.SourceRoot == "" {
		t.Fatalf("%+v", res)
	}
}

func TestProbe_CleanNested(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	root := t.TempDir()
	initRepo(t, root)
	if err := os.MkdirAll(filepath.Join(root, "pkg", "api"), 0o755); err != nil {
		t.Fatal(err)
	}
	commitFile(t, root, "pkg/api/a.go", "package api\n")
	nested := filepath.Join(root, "pkg", "api")
	res, err := m.Probe(context.Background(), nested)
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(t, res.SourceRoot, root) {
		t.Fatalf("source=%s root=%s", res.SourceRoot, root)
	}
	if res.Scope != "pkg/api" {
		t.Fatalf("scope=%q", res.Scope)
	}
	if res.RecommendedMode != string(ResolvedWorktree) {
		t.Fatalf("mode=%s", res.RecommendedMode)
	}
}

func TestProbe_ModifiedTracked(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "f.txt", "a\n")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := m.Probe(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Dirty || !res.CanWorktree {
		t.Fatalf("%+v", res)
	}
	if res.RecommendedMode != string(ResolvedShared) {
		t.Fatalf("mode=%s", res.RecommendedMode)
	}
}

func TestProbe_Untracked(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "f.txt", "a\n")
	if err := os.WriteFile(filepath.Join(dir, "new.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := m.Probe(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Dirty || res.RecommendedMode != string(ResolvedShared) {
		t.Fatalf("%+v", res)
	}
}

func TestProbe_Unborn(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	initRepo(t, dir)
	// no commits
	res, err := m.Probe(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.HasHead || res.CanWorktree {
		t.Fatalf("%+v", res)
	}
	if res.RecommendedMode != string(ResolvedShared) {
		t.Fatalf("mode=%s", res.RecommendedMode)
	}
}

func TestProbe_Bare(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	dir := t.TempDir()
	gitCmd(t, dir, "init", "--bare")
	res, err := m.Probe(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsBare || res.CanWorktree {
		t.Fatalf("%+v", res)
	}
}

func TestProbe_MissingCwd(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	missing := filepath.Join(t.TempDir(), "nope")
	_, err := m.Probe(context.Background(), missing)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "cwd") && !strings.Contains(err.Error(), missing) {
		t.Fatalf("err=%v", err)
	}
	// Must not dump full environment.
	if strings.Contains(err.Error(), "PATH=") {
		t.Fatalf("leaked env: %v", err)
	}
}
