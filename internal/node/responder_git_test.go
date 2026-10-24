package node

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/workspace"
)

// The two questions a console asks a machine about the checkouts it already has.
//
// They are the only pair in the table that reads and writes a directory a person
// chose rather than one the machine derived, so the boundary is the whole test:
// every case below is about what this machine will and will not touch, not about
// what git reports.

// gitRepo makes a repository with a second branch and returns its path.
func gitRepo(t *testing.T, path string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = path
		cmd.Env = append(os.Environ(),
			"GIT_CONFIG_GLOBAL=/dev/null",
			"GIT_CONFIG_SYSTEM=/dev/null",
			"GIT_AUTHOR_NAME=Kin Test",
			"GIT_AUTHOR_EMAIL=owner@example.com",
			"GIT_COMMITTER_NAME=Kin Test",
			"GIT_COMMITTER_EMAIL=owner@example.com",
			"GIT_TERMINAL_PROMPT=0",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "owner@example.com")
	run("config", "user.name", "Kin Test")
	run("config", "gc.auto", "0")
	if err := os.WriteFile(filepath.Join(path, "README"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "README")
	run("commit", "-m", "init")
	run("branch", "dev")
	return path
}

// repoOn is a machine whose roots are the directory given, with git.
func repoOn(t *testing.T, root string) (*Responder, *testConn) {
	r, conn := responderOn(t, root)
	r.Workspace = workspace.NewManager(root)
	return r, conn
}

// gitBranchesOf asks one machine about one directory and insists on an answer.
func gitBranchesOf(t *testing.T, r *Responder, conn *testConn, path string) worker.GitBranchesResult {
	t.Helper()
	result := put(t, r, conn, worker.QueryGitBranches, worker.GitBranchesParams{Path: path})
	if result.Error != "" {
		t.Fatalf("branches of %s were refused: %s", path, result.Error)
	}
	var found worker.GitBranchesResult
	if err := result.Into(&found); err != nil {
		t.Fatal(err)
	}
	return found
}

// gitRefusal asks one machine about one directory and insists it said no.
func gitRefusal(t *testing.T, method string, params any, r *Responder, conn *testConn) string {
	t.Helper()
	result := put(t, r, conn, method, params)
	if result.Error == "" {
		t.Fatalf("%s was answered instead of refused: %s", method, string(result.Result))
	}
	return result.Error
}

func TestGitBranchesAnswersAboutACheckoutUnderTheRoots(t *testing.T) {
	root := t.TempDir()
	dir := gitRepo(t, filepath.Join(root, "checkout"))
	r, conn := repoOn(t, root)

	found := gitBranchesOf(t, r, conn, dir)
	if !found.IsGit || found.Current != "main" {
		t.Fatalf("answer = %+v, want the checkout on main", found)
	}
	names := make([]string, 0, len(found.Branches))
	for _, b := range found.Branches {
		names = append(names, b.Name)
		if b.Name == "main" && !b.Current {
			t.Error("main is checked out but not marked current")
		}
	}
	if strings.Join(names, ",") != "dev,main" {
		t.Fatalf("branches = %v, want dev and main", names)
	}
}

// A directory this machine does not work in is not a directory it reads, even
// when it is a repository and even when it is right there.
func TestGitBranchesRefusesADirectoryOutsideTheRoots(t *testing.T) {
	root := t.TempDir()
	outside := gitRepo(t, filepath.Join(t.TempDir(), "elsewhere"))
	r, conn := repoOn(t, root)

	reason := gitRefusal(t, worker.QueryGitBranches,
		worker.GitBranchesParams{Path: outside}, r, conn)
	if !strings.Contains(reason, "this machine works in") {
		t.Fatalf("reason = %q, want it to name the boundary", reason)
	}
}

// A link inside a root that points out of it is the case that makes resolving
// before checking load-bearing: the path as written is inside, the directory it
// names is not.
func TestGitBranchesRefusesASymlinkThatLeavesTheRoots(t *testing.T) {
	root := t.TempDir()
	outside := gitRepo(t, filepath.Join(t.TempDir(), "elsewhere"))
	link := filepath.Join(root, "shortcut")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("cannot make a symlink here: %v", err)
	}
	r, conn := repoOn(t, root)

	gitRefusal(t, worker.QueryGitBranches, worker.GitBranchesParams{Path: link}, r, conn)
}

func TestGitBranchesRefusesADirectoryThatIsNotThere(t *testing.T) {
	root := t.TempDir()
	r, conn := repoOn(t, root)

	gitRefusal(t, worker.QueryGitBranches,
		worker.GitBranchesParams{Path: filepath.Join(root, "nope")}, r, conn)
}

// A directory that is not a repository is answered, not refused: most are not,
// and the person looking at a list of names did not ask which of them is one.
func TestGitBranchesAnswersForADirectoryThatIsNotARepository(t *testing.T) {
	root := t.TempDir()
	r, conn := repoOn(t, root)

	found := gitBranchesOf(t, r, conn, root)
	if found.IsGit {
		t.Fatalf("answer = %+v, want it to say this is not a repository", found)
	}
	if found.Branches == nil {
		t.Fatal("branches came back as absent, which a client reads as a broken answer")
	}
}

// A machine with no git still answers, in its own words.
func TestGitBranchesOnAMachineWithoutGitSaysSo(t *testing.T) {
	root := t.TempDir()
	r, conn := responderOn(t, root)

	gitRefusal(t, worker.QueryGitBranches, worker.GitBranchesParams{Path: root}, r, conn)
}

func TestGitCheckoutMovesACheckoutUnderTheRoots(t *testing.T) {
	root := t.TempDir()
	dir := gitRepo(t, filepath.Join(root, "checkout"))
	r, conn := repoOn(t, root)

	result := put(t, r, conn, worker.QueryGitCheckout, worker.GitCheckoutParams{Path: dir, Branch: "dev"})
	if result.Error != "" {
		t.Fatalf("checkout refused: %s", result.Error)
	}
	var switched worker.GitCheckoutResult
	if err := result.Into(&switched); err != nil {
		t.Fatal(err)
	}
	if switched.Current != "dev" {
		t.Fatalf("current = %q, want dev", switched.Current)
	}
	if got := currentBranchOn(t, dir); got != "dev" {
		t.Fatalf("git says the checkout is on %q, want dev", got)
	}
}

// The write is bounded by the same boundary the read is, and it is checked
// before anything moves.
func TestGitCheckoutRefusesADirectoryOutsideTheRoots(t *testing.T) {
	root := t.TempDir()
	outside := gitRepo(t, filepath.Join(t.TempDir(), "elsewhere"))
	r, conn := repoOn(t, root)

	gitRefusal(t, worker.QueryGitCheckout,
		worker.GitCheckoutParams{Path: outside, Branch: "dev"}, r, conn)
	if got := currentBranchOn(t, outside); got != "main" {
		t.Fatalf("the checkout outside the roots moved to %q", got)
	}
}

// A branch that would be read as a switch never reaches git's option parser.
func TestGitCheckoutRefusesABranchThatIsAnOption(t *testing.T) {
	root := t.TempDir()
	dir := gitRepo(t, filepath.Join(root, "checkout"))
	r, conn := repoOn(t, root)

	gitRefusal(t, worker.QueryGitCheckout,
		worker.GitCheckoutParams{Path: dir, Branch: "--force"}, r, conn)
	if got := currentBranchOn(t, dir); got != "main" {
		t.Fatalf("the checkout moved to %q", got)
	}
}

// A branch nobody has is git's refusal to give, and it arrives as one.
func TestGitCheckoutRefusesABranchThatIsNotThere(t *testing.T) {
	root := t.TempDir()
	dir := gitRepo(t, filepath.Join(root, "checkout"))
	r, conn := repoOn(t, root)

	gitRefusal(t, worker.QueryGitCheckout,
		worker.GitCheckoutParams{Path: dir, Branch: "no-such-branch"}, r, conn)
}

// currentBranchOn reads what git says a checkout is on, from outside this
// daemon: the claim is about the directory, not about the answer.
func currentBranchOn(t *testing.T, dir string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "symbolic-ref", "--short", "HEAD").Output()
	if err != nil {
		t.Fatalf("read the branch of %s: %v", dir, err)
	}
	return strings.TrimSpace(string(out))
}
