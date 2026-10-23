package toolpath

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The guard that keeps Kin from executing another product's per-session wrapper
// for a tool, which is injected into this daemon's PATH ahead of the real one.
func TestRefuseRefusesSessionWrappers(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}

	cases := []struct {
		name string
		path string
		want string // "" means accepted
	}{
		{"homebrew", "/opt/homebrew/bin/git", ""},
		{"usr-local", "/usr/local/bin/git", ""},
		{"session wrapper", "/home/dev/.lody/gh-session-bin/0123456789abcdef/git", "wrapper"},
		{"nested wrapper dir", "/tmp/gh-session-bin/git", "wrapper"},
		{"inside product state dir", filepath.Join(home, ".lody", "bin", "git"), "state directory"},
		{"product state dir itself", filepath.Join(home, ".lody"), "state directory"},
		{"lookalike sibling", filepath.Join(home, ".lody-backup", "bin", "git"), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Refuse(tc.path)
			if tc.want == "" && got != "" {
				t.Fatalf("Refuse(%q) = %q, want accepted", tc.path, got)
			}
			if tc.want != "" && got == "" {
				t.Fatalf("Refuse(%q) accepted, want rejection", tc.path)
			}
		})
	}
}

// A symlink into a wrapper directory must not launder the path.
func TestRefuseFollowsSymlinks(t *testing.T) {
	dir := t.TempDir()
	shimDir := filepath.Join(dir, SessionShimComponent, "abc")
	if err := os.MkdirAll(shimDir, 0o755); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(shimDir, "git")
	if err := os.WriteFile(real, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "git")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if got := Refuse(link); got == "" {
		t.Fatalf("Refuse(%q) accepted a symlink into a wrapper directory", link)
	}
}

// A lexical guard is only as good as its spelling rules. On a volume that does
// not distinguish case, `.LODY` names the same directory as `.lody`; and a
// relative path compared against the working directory names nothing at all.
func TestRefuseFoldsCaseAndResolvesRelativePaths(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}

	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		for _, p := range []string{
			filepath.Join(home, ".LODY", "bin", "git"),
			filepath.Join(home, ".Lody", "GH-SESSION-BIN", "abc", "git"),
		} {
			if got := Refuse(p); got == "" {
				t.Errorf("Refuse(%q) accepted a case-varied spelling of a refused path", p)
			}
		}
	}

	t.Chdir(home)
	if got := Refuse(filepath.Join(".lody", "bin", "git")); got == "" {
		t.Error(`Refuse(".lody/bin/git") accepted a relative path into the state directory`)
	}
}

func TestResolvePrefersKnownLocationsOverPATH(t *testing.T) {
	dir := t.TempDir()
	known := writeTool(t, filepath.Join(dir, "known"), "git")
	// A wrapper that a plain PATH lookup would have found first.
	shim := writeTool(t, filepath.Join(dir, SessionShimComponent, "abc"), "git")
	t.Setenv("PATH", filepath.Dir(shim))

	got, err := Resolve(Spec{Name: "git", Known: []string{known}})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != known {
		t.Fatalf("resolved %q, want %q", got, known)
	}
}

func TestResolveFallsBackToPATHButNotToTheWrapper(t *testing.T) {
	dir := t.TempDir()
	clean := writeTool(t, filepath.Join(dir, "bin"), "git")
	shim := writeTool(t, filepath.Join(dir, SessionShimComponent, "abc"), "git")
	// The wrapper comes first, which is the ordering that matters.
	t.Setenv("PATH", strings.Join(
		[]string{filepath.Dir(shim), filepath.Dir(clean)}, string(filepath.ListSeparator)))

	got, err := Resolve(Spec{Name: "git"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != clean {
		t.Fatalf("resolved %q, want %q", got, clean)
	}
}

func TestResolveReportsWhatItSearched(t *testing.T) {
	t.Setenv("PATH", filepath.Join(t.TempDir(), "empty"))
	_, err := Resolve(Spec{Name: "git", Known: []string{"/nonexistent/git"}})
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if !strings.Contains(err.Error(), "/nonexistent/git") {
		t.Fatalf("err = %v, want it to name the places searched", err)
	}
}

// Someone who set the override meant it. Silently running a different binary
// would be worse than refusing.
func TestResolveRejectsAnOverridePointingAtAWrapper(t *testing.T) {
	t.Setenv("KIN_TEST_TOOL_PATH", "/tmp/gh-session-bin/deadbeef/git")
	_, err := Resolve(Spec{Name: "git", EnvVar: "KIN_TEST_TOOL_PATH"})
	if err == nil {
		t.Fatal("Resolve accepted a wrapper path from the override")
	}
	// One question, one sentinel: "is there an executable I can run?" is no,
	// whether the path was refused or merely absent, and the message says which.
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want it to match ErrUnavailable", err)
	}
	if !strings.Contains(err.Error(), "wrapper") {
		t.Fatalf("err = %v, want the reason to survive into the text", err)
	}
}

func TestResolveHonoursAnOverride(t *testing.T) {
	dir := t.TempDir()
	tool := writeTool(t, dir, "git")
	t.Setenv("KIN_TEST_TOOL_PATH", tool)
	got, err := Resolve(Spec{Name: "git", EnvVar: "KIN_TEST_TOOL_PATH"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != tool {
		t.Fatalf("resolved %q, want %q", got, tool)
	}
}

// A tool sitting in a clean PATH directory that is a symlink into a wrapper
// directory must not be executed. Vetoing the directory alone accepts it.
func TestResolveJudgesTheCandidateNotJustItsDirectory(t *testing.T) {
	root := t.TempDir()
	clean := filepath.Join(root, "bin")
	shimDir := filepath.Join(root, SessionShimComponent, "sess")
	for _, dir := range []string{clean, shimDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	real := writeTool(t, shimDir, "git")
	if err := os.Symlink(real, filepath.Join(clean, "git")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", clean)

	if got, err := Resolve(Spec{Name: "git"}); err == nil {
		t.Fatalf("accepted %q, a symlink into a wrapper directory", got)
	}

	// The same setup with an honest binary is accepted, so the check is about
	// the candidate rather than having disabled the PATH scan.
	honest := writeTool(t, filepath.Join(root, "honest"), "git")
	t.Setenv("PATH", filepath.Dir(honest))
	got, err := Resolve(Spec{Name: "git"})
	if err != nil {
		t.Fatalf("rejected an ordinary tool: %v", err)
	}
	if got != honest {
		t.Fatalf("resolved %q, want %q", got, honest)
	}
}

func TestFilterPATHDropsWrapperDirectories(t *testing.T) {
	in := strings.Join([]string{"/usr/bin", "/tmp/gh-session-bin/abc", "/opt/homebrew/bin"}, ":")
	want := strings.Join([]string{"/usr/bin", "/opt/homebrew/bin"}, ":")
	if got := FilterPATH(in); got != want {
		t.Fatalf("FilterPATH(%q) = %q, want %q", in, got, want)
	}
}

func TestSanitizeEnvKeepsAPATHAndDropsTheWrapper(t *testing.T) {
	env := SanitizeEnv([]string{"HOME=/home/dev", "PATH=/tmp/gh-session-bin/abc"})
	var path string
	for _, entry := range env {
		if name, value, ok := strings.Cut(entry, "="); ok && name == "PATH" {
			path = value
		}
	}
	if path == "" {
		t.Fatal("SanitizeEnv dropped PATH entirely when every entry was filtered")
	}
	if strings.Contains(path, SessionShimComponent) {
		t.Fatalf("PATH still names the wrapper: %q", path)
	}

	// Entries other than PATH are passed through untouched: the point is to
	// keep the user's own configuration.
	kept := SanitizeEnv([]string{"HOME=/home/dev", "PATH=/usr/bin"})
	found := false
	for _, entry := range kept {
		if entry == "HOME=/home/dev" {
			found = true
		}
	}
	if !found {
		t.Fatalf("SanitizeEnv dropped an unrelated variable: %v", kept)
	}
}

func writeTool(t *testing.T, dir, name string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
