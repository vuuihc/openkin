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

// A resolved tool is run with a working directory of its own choosing, and
// os/exec resolves a relative Path after changing into it. So a relative answer
// would execute a different file from the one that was validated here — the
// caller's directory's copy. `tools/git` reaches this through an override, and
// through PATH if PATH has a relative entry.
func TestResolveNeverReturnsARelativePath(t *testing.T) {
	dir := t.TempDir()
	writeTool(t, filepath.Join(dir, "tools"), "git")
	t.Chdir(dir)

	// No override and nothing on PATH: there is nothing to return, so the
	// assertions below are about the two paths that do return something.
	t.Setenv("PATH", "")
	if got, err := Resolve(Spec{Name: "git", EnvVar: "KIN_TEST_TOOL_PATH_ABS"}); err == nil {
		t.Fatalf("Resolve with no override and no PATH returned %q", got)
	}

	t.Setenv("KIN_TEST_TOOL_PATH_ABS", filepath.Join("tools", "git"))
	got, err := Resolve(Spec{Name: "git", EnvVar: "KIN_TEST_TOOL_PATH_ABS"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !filepath.IsAbs(got) {
		t.Fatalf("Resolve returned %q, which the caller would resolve against its own directory", got)
	}
	if want := filepath.Join(dir, "tools", "git"); got != want {
		t.Fatalf("resolved %q, want %q", got, want)
	}

	// The same through PATH, whose entries need not be absolute either.
	t.Setenv("KIN_TEST_TOOL_PATH_ABS", "")
	t.Setenv("PATH", "tools")
	got, err = Resolve(Spec{Name: "git"})
	if err != nil {
		t.Fatalf("Resolve via PATH: %v", err)
	}
	if !filepath.IsAbs(got) {
		t.Fatalf("Resolve via PATH returned %q, want an absolute path", got)
	}

	// A bare name is the same problem one more step out. exec.Command looks a
	// name without a separator up on PATH again, and it does that against the
	// process's PATH rather than the filtered one the child is handed.
	writeTool(t, dir, "git")
	t.Setenv("PATH", "")
	t.Setenv("KIN_TEST_TOOL_PATH_ABS", "git")
	got, err = Resolve(Spec{Name: "git", EnvVar: "KIN_TEST_TOOL_PATH_ABS"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if want := filepath.Join(dir, "git"); got != want {
		t.Fatalf("resolved %q, want %q rather than a name exec would look up again", got, want)
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

// A relative entry is judged here and searched by a child that has changed
// directory, which is the same substitution as a relative answer.
//
// The working directory is set explicitly because this one is about *why* an
// entry is dropped: a relative path under the state directory is refused for
// the other reason, and the test would pass without the check it exists for.
func TestFilterPATHDropsRelativeEntries(t *testing.T) {
	t.Chdir(t.TempDir())
	if got := FilterPATH("bin:/usr/bin"); got != "/usr/bin" {
		t.Fatalf("FilterPATH kept a relative entry: %q", got)
	}
}

// The refused product injects credential configuration through the environment,
// as a count plus numbered pairs. Removing a member would change what the rest
// mean, so the set goes together.
func TestSanitizeEnvDropsInjectedConfigNamingTheRefusedProduct(t *testing.T) {
	env := []string{
		"PATH=/usr/bin",
		"GIT_CONFIG_COUNT=2",
		"GIT_CONFIG_KEY_0=credential.https://github.com.helper",
		"GIT_CONFIG_VALUE_0=",
		"GIT_CONFIG_KEY_1=credential.https://github.com.helper",
		`GIT_CONFIG_VALUE_1=!node "/Users/dev/.lody/dsh/helper.js"`,
	}
	for _, entry := range SanitizeEnv(env) {
		if strings.HasPrefix(entry, "GIT_CONFIG_") {
			t.Fatalf("kept %q from a configuration that names the refused product", entry)
		}
	}

	// Without the fingerprint it is the user's own injected configuration, and
	// dropping it would break their git.
	const own = `GIT_CONFIG_VALUE_1=!f() { echo hi; }; f`
	kept := SanitizeEnv([]string{"PATH=/usr/bin", "GIT_CONFIG_COUNT=1", own})
	found := false
	for _, entry := range kept {
		if entry == own {
			found = true
		}
	}
	if !found {
		t.Fatalf("dropped an unrelated injected configuration: %v", kept)
	}
}

// A state directory reached through a symlink is the same directory.
func TestRefuseFollowsASymlinkedStateDirectory(t *testing.T) {
	home := t.TempDir()
	real := filepath.Join(home, "product-state")
	if err := os.MkdirAll(filepath.Join(real, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	tool := writeTool(t, filepath.Join(real, "bin"), "git")
	if err := os.Symlink(real, filepath.Join(home, stateDirComponent)); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)

	if got := Refuse(tool); got == "" {
		t.Fatalf("Refuse(%q) accepted a binary inside a symlinked state directory", tool)
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

// git searches GIT_EXEC_PATH before PATH, so filtering PATH alone would leave
// the wrapper reachable one directory over.
func TestSanitizeEnvDropsARefusedHelperDirectory(t *testing.T) {
	for _, entry := range SanitizeEnv([]string{
		"PATH=/usr/bin",
		"GIT_EXEC_PATH=/tmp/gh-session-bin/abc",
	}) {
		if strings.HasPrefix(entry, "GIT_EXEC_PATH=") {
			t.Fatalf("kept %q, a directory git searches before PATH", entry)
		}
	}

	// A GIT_EXEC_PATH of the user's own is configuration, not ours to drop.
	const own = "GIT_EXEC_PATH=/usr/local/libexec/git-core"
	kept := SanitizeEnv([]string{"PATH=/usr/bin", own})
	found := false
	for _, entry := range kept {
		if entry == own {
			found = true
		}
	}
	if !found {
		t.Fatalf("dropped an unrefused GIT_EXEC_PATH: %v", kept)
	}
}

// The variables git uses to reach a remote are doors of their own: a wrapper
// named in one of them runs on every push, on the very path that carries code.
//
// GIT_SSH_COMMAND is the reason these are not judged as paths alone. It holds a
// command line — `ssh -i key` — so a path test finds nothing in it.
func TestSanitizeEnvDropsARefusedRemoteProgram(t *testing.T) {
	cases := []struct {
		name  string
		entry string
	}{
		{"ssh program", "GIT_SSH=/tmp/gh-session-bin/abc/ssh"},
		{"ssh command line", `GIT_SSH_COMMAND=/Users/dev/.lody/gh-session-bin/abc/ssh -o StrictHostKeyChecking=no`},
		{"proxy command", "GIT_PROXY_COMMAND=/tmp/gh-session-bin/abc/connect"},
		{"askpass", "SSH_ASKPASS=/tmp/gh-session-bin/abc/askpass"},
		{"git askpass", "GIT_ASKPASS=/Users/dev/.lody/bin/git-askpass"},
		{"global config", "GIT_CONFIG_GLOBAL=/Users/dev/.lody/gitconfig"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, entry := range SanitizeEnv([]string{"PATH=/usr/bin", tc.entry}) {
				if entry == tc.entry {
					t.Fatalf("kept %q, which names the refused product", entry)
				}
			}
		})
	}

	// The user's own, which is not ours to drop. Dropping a working
	// GIT_SSH_COMMAND would break their push rather than protect it.
	for _, own := range []string{
		"GIT_SSH_COMMAND=ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes",
		"GIT_SSH=/usr/bin/ssh",
		"GIT_CONFIG_GLOBAL=/Users/dev/.gitconfig",
	} {
		kept := SanitizeEnv([]string{"PATH=/usr/bin", own})
		found := false
		for _, entry := range kept {
			if entry == own {
				found = true
			}
		}
		if !found {
			t.Fatalf("dropped %q, which names nothing refused", own)
		}
	}
}

// A refused path spelled the way a shell writes it — and the way it reaches git
// through an environment variable — is the same path.
//
// The two cases here are not the same test. `~/.lody/bin` is caught by the
// product's fingerprint wherever it appears, so it documents the realistic
// spelling. The symlinked one is caught by nothing else: the literal spelling
// names an innocent directory, and only resolving it after expanding `~` shows
// where it goes. A lexical check would wave it through.
func TestSanitizeEnvDropsAShellSpelledRefusedPath(t *testing.T) {
	home := t.TempDir()
	shim := filepath.Join(home, SessionShimComponent, "abc")
	if err := os.MkdirAll(shim, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTool(t, shim, "git-askpass")
	if err := os.Symlink(shim, filepath.Join(home, "bin")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)

	for _, entry := range []string{
		"GIT_EXEC_PATH=~/.lody/bin",
		"GIT_ASKPASS=~/bin/git-askpass",
	} {
		for _, got := range SanitizeEnv([]string{"PATH=/usr/bin", entry}) {
			if got == entry {
				t.Fatalf("kept %q, a shell spelling of a refused path", got)
			}
		}
	}
}

// A command line is not a path, and Kin's working directory is not the child's.
//
// Judging `ssh -i key` by resolving it here refuses the user's own
// GIT_SSH_COMMAND whenever the daemon happens to run from inside the state
// directory — which is exactly where it runs on a machine that lays its
// worktrees out there. The working directory is set explicitly so the case does
// not depend on where this checkout lives.
func TestSanitizeEnvKeepsACommandLineValue(t *testing.T) {
	home := t.TempDir()
	state := filepath.Join(home, stateDirComponent)
	if err := os.MkdirAll(state, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Chdir(state)

	for _, entry := range []string{
		"GIT_SSH_COMMAND=ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes",
		"GIT_SSH=ssh",
		"GIT_CONFIG=worktree.config",
	} {
		kept := SanitizeEnv([]string{"PATH=/usr/bin", entry})
		found := false
		for _, got := range kept {
			if got == entry {
				found = true
			}
		}
		if !found {
			t.Fatalf("dropped %q, which names nothing refused: %v", entry, kept)
		}
	}
}

// A relative spelling of the state directory names the same directory, and
// nothing can resolve it here: the child changes into a repository of its own
// choosing, so the value is read as text.
//
// The working directory is a fresh temporary directory rather than this
// checkout, which lives under the refused state directory — from there `Refuse`
// rejects the value for the other reason and the test would pass with the guard
// removed, which is how the earlier relative-path test went wrong.
func TestSanitizeEnvDropsARelativeSpellingOfTheStateDirectory(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("HOME", t.TempDir())

	const entry = "GIT_EXEC_PATH=.lody/bin"
	for _, got := range SanitizeEnv([]string{"PATH=/usr/bin", entry}) {
		if got == entry {
			t.Fatalf("kept %q, a relative spelling of the refused state directory", got)
		}
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
