package github

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/workspace"
)

// TestRejectGHPathRefusesSessionWrappers is the guard that keeps Kin from
// executing another product's per-session gh wrapper, which is injected into
// this daemon's PATH ahead of the real CLI.
func TestRejectGHPathRefusesSessionWrappers(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}

	cases := []struct {
		name string
		path string
		want string // "" means accepted
	}{
		{"homebrew", "/opt/homebrew/bin/gh", ""},
		{"usr-local", "/usr/local/bin/gh", ""},
		{"session wrapper", "/home/dev/.lody/gh-session-bin/0123456789abcdef/gh", "wrapper"},
		{"nested wrapper dir", "/tmp/gh-session-bin/gh", "wrapper"},
		{"inside product state dir", filepath.Join(home, ".lody", "bin", "gh"), "state directory"},
		{"product state dir itself", filepath.Join(home, ".lody"), "state directory"},
		{"lookalike sibling", filepath.Join(home, ".lody-backup", "bin", "gh"), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rejectGHPath(tc.path)
			if tc.want == "" && got != "" {
				t.Fatalf("rejectGHPath(%q) = %q, want accepted", tc.path, got)
			}
			if tc.want != "" && got == "" {
				t.Fatalf("rejectGHPath(%q) accepted, want rejection", tc.path)
			}
		})
	}
}

// A symlink into a wrapper directory must not launder the path.
func TestRejectGHPathFollowsSymlinks(t *testing.T) {
	dir := t.TempDir()
	shimDir := filepath.Join(dir, sessionShimComponent, "abc")
	if err := os.MkdirAll(shimDir, 0o755); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(shimDir, "gh")
	if err := os.WriteFile(real, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "gh")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if got := rejectGHPath(link); got == "" {
		t.Fatalf("rejectGHPath(%q) accepted a symlink into a wrapper directory", link)
	}
}

func TestResolveGHRejectsOverridePointingAtWrapper(t *testing.T) {
	t.Setenv(ghPathEnv, "/tmp/gh-session-bin/deadbeef/gh")
	if _, err := ResolveGH(); err == nil {
		t.Fatal("ResolveGH accepted a wrapper path from the override")
	}
}

func TestFilterShimFromPathDropsWrapperDirs(t *testing.T) {
	in := "/usr/bin:/tmp/gh-session-bin/abc:/opt/homebrew/bin"
	got := filterShimFromPath(in)
	want := "/usr/bin:/opt/homebrew/bin"
	if got != want {
		t.Fatalf("filterShimFromPath(%q) = %q, want %q", in, got, want)
	}
}

// A `gh` sitting in a clean PATH directory that is a symlink into a wrapper
// directory must not be executed. Vetoing the directory alone accepts it, and
// the child's own PATH filter does not help because the candidate's directory is
// not the thing that is dirty.
func TestResolveFromPathJudgesTheCandidateNotJustItsDirectory(t *testing.T) {
	root := t.TempDir()
	clean := filepath.Join(root, "bin")
	shimDir := filepath.Join(root, sessionShimComponent, "sess")
	for _, dir := range []string{clean, shimDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	real := filepath.Join(shimDir, "gh")
	if err := os.WriteFile(real, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(clean, "gh")); err != nil {
		t.Fatal(err)
	}

	var searched []string
	if bin, found := resolveFromPath(clean, &searched); found {
		t.Fatalf("accepted %q, a symlink into a wrapper directory", bin.Path)
	}
	if len(searched) == 0 {
		t.Fatal("a refused candidate should still be reported as looked at")
	}

	// The same directory with an honest binary is still accepted, so the check
	// is about the candidate rather than having disabled the PATH scan.
	honest := filepath.Join(root, "honest")
	if err := os.MkdirAll(honest, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(honest, "gh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	bin, found := resolveFromPath(honest, &searched)
	if !found {
		t.Fatal("rejected an ordinary gh")
	}
	if want := filepath.Join(honest, "gh"); bin.Path != want {
		t.Fatalf("resolved %q, want %q", bin.Path, want)
	}
}

// gh runs helpers of its own, so it must never be handed an environment with no
// PATH at all — that fails in a way that reads like a gh bug rather than like
// something Kin did.
func TestGHEnvAlwaysCarriesAPath(t *testing.T) {
	t.Setenv("PATH", "/tmp/gh-session-bin/abc")
	var path string
	for _, entry := range ghEnv() {
		if name, value, ok := strings.Cut(entry, "="); ok && name == "PATH" {
			path = value
		}
	}
	if path == "" {
		t.Fatal("ghEnv dropped PATH entirely when every entry was filtered")
	}
	if strings.Contains(path, sessionShimComponent) {
		t.Fatalf("PATH still names the wrapper: %q", path)
	}
}

// A lexical guard is only as good as its spelling rules. On a volume that does
// not distinguish case, `.LODY` names the same directory as `.lody`; and a
// relative path compared against the working directory names nothing at all.
func TestRejectGHPathFoldsCaseAndResolvesRelativePaths(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}

	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		for _, p := range []string{
			filepath.Join(home, ".LODY", "bin", "gh"),
			filepath.Join(home, ".Lody", "GH-SESSION-BIN", "abc", "gh"),
		} {
			if got := rejectGHPath(p); got == "" {
				t.Errorf("rejectGHPath(%q) accepted a case-varied spelling of a refused path", p)
			}
		}
	}

	// Judged from $HOME, a relative spelling has to reach the same verdict as the
	// absolute one it points at.
	t.Chdir(home)
	if got := rejectGHPath(filepath.Join(".lody", "bin", "gh")); got == "" {
		t.Error(`rejectGHPath(".lody/bin/gh") accepted a relative path into the state directory`)
	}
}

// filterShimFromPath is what keeps gh's own subprocesses from picking the
// wrapper up, so it must drop the directory without dropping everything else.
func TestFilterShimFromPathKeepsOrdinaryDirectories(t *testing.T) {
	in := strings.Join([]string{"/usr/bin", "/tmp/gh-session-bin/abc", "/bin"}, ":")
	if got, want := filterShimFromPath(in), "/usr/bin:/bin"; got != want {
		t.Fatalf("filterShimFromPath(%q) = %q, want %q", in, got, want)
	}
}

// A truncated read must fail rather than look like a short but valid answer:
// half a JSON document can parse into something plausible.
func TestLimitWriterSignalsTruncation(t *testing.T) {
	var buf bytes.Buffer
	w := &limitWriter{w: &buf, n: 16}
	if _, err := w.Write(bytes.Repeat([]byte("a"), 16)); err != nil {
		t.Fatalf("write up to the cap: %v", err)
	}
	if _, err := w.Write([]byte("more")); err != nil {
		t.Fatalf("write past the cap: %v", err)
	}
	if buf.Len() != 16 {
		t.Fatalf("buffered %d bytes, want the cap of 16", buf.Len())
	}
}

// A workspace whose source checkout has been moved or deleted has no repository
// to read. That is the same answer as "not a GitHub project", not a failure —
// otherwise a tidied-up folder turns into a broken panel.
func TestRepoForDirTreatsAMissingDirectoryAsNotGitHub(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "gone")
	repo, ok, err := RepoForDir(context.Background(), workspace.NewAnchorResolver(), missing)
	if err != nil {
		t.Fatalf("a missing directory must not be an error: %v", err)
	}
	if ok {
		t.Fatalf("found a repository at a path that does not exist: %+v", repo)
	}
}

func TestClassifyGHError(t *testing.T) {
	cases := []struct {
		name   string
		stderr string
		want   error
	}{
		{"unauthorized", "gh: Bad credentials (HTTP 401)", ErrNotAuthenticated},
		{"forbidden", "gh: API rate limit exceeded (HTTP 403)", ErrRateLimited},
		{"missing", "gh: Not Found (HTTP 404)", ErrNotFound},
		{"logged out", "To get started with GitHub CLI, please run: gh auth login", ErrNotAuthenticated},
		{"unrecognized", "gh: something new happened", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := classifyGHError(tc.stderr)
			if tc.want == nil {
				if errors.Is(err, ErrNotAuthenticated) || errors.Is(err, ErrRateLimited) || errors.Is(err, ErrNotFound) {
					t.Fatalf("classifyGHError(%q) = %v, want an unclassified error", tc.stderr, err)
				}
				return
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("classifyGHError(%q) = %v, want %v", tc.stderr, err, tc.want)
			}
		})
	}
}
