package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// What one machine can say about the git a directory is in.
//
// The Hub asks this of the machine holding a remote session's files, so the two
// things that matter most are that every answer is read offline (a phone waiting
// on a credential prompt is the failure this avoids) and that nothing which
// leaves the machine carries a credential (ADR 0022 D7).

// checkoutOn creates a repository whose default branch is named, and returns it.
//
// The name is set explicitly rather than left to git's init default, which is
// `master` or `main` depending on the version and the machine's config — a test
// that reads either is a test that passes for a reason it did not choose.
func checkoutOn(t *testing.T, dir, branch string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	gitCmd(t, dir, "branch", "-M", branch)
	return dir
}

func inspect(t *testing.T, dir string) GitFacts {
	t.Helper()
	requireGit(t)
	facts, err := NewManager(t.TempDir()).InspectGit(context.Background(), dir)
	if err != nil {
		t.Fatalf("InspectGit(%s): %v", dir, err)
	}
	return facts
}

func TestInspectGitNamesTheRepositoryAndBranch(t *testing.T) {
	dir := checkoutOn(t, filepath.Join(t.TempDir(), "app"), "main")
	gitCmd(t, dir, "remote", "add", "origin", "https://github.com/owner/app.git")

	facts := inspect(t, dir)
	if !facts.IsGit {
		t.Fatalf("a checkout was read as not one: %+v", facts)
	}
	if facts.Repo != "github.com/owner/app" {
		t.Errorf("repo = %q, want the canonical remote", facts.Repo)
	}
	if facts.Branch != "main" || facts.Detached {
		t.Errorf("branch = %q detached = %v, want main on a branch", facts.Branch, facts.Detached)
	}
	if len(facts.HeadOID) != 40 {
		t.Errorf("head = %q, want the commit HEAD is on", facts.HeadOID)
	}
	if facts.Dirty {
		t.Error("a checkout just committed reads as dirty")
	}
	if facts.Reason != "" {
		t.Errorf("reason = %q, want none for a checkout that answered", facts.Reason)
	}
}

func TestInspectGitReportsUncommittedWork(t *testing.T) {
	dir := checkoutOn(t, filepath.Join(t.TempDir(), "app"), "main")

	if err := os.WriteFile(filepath.Join(dir, "untracked.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if facts := inspect(t, dir); !facts.Dirty {
		t.Error("a file the session created but never added does not read as uncommitted work")
	}
}

// A remote URL is copied between machines through the Hub's database, so a token
// pasted into one must be stripped before it gets there. Both spellings a person
// actually types are covered, because only one of them goes through URL parsing.
func TestInspectGitStripsCredentialsFromTheRemote(t *testing.T) {
	for _, remote := range []string{
		"https://x-access-token:ghp_example@github.com/owner/app.git",
		"git@github.com:owner/app.git",
	} {
		dir := checkoutOn(t, filepath.Join(t.TempDir(), "app"), "main")
		gitCmd(t, dir, "remote", "add", "origin", remote)

		facts := inspect(t, dir)
		if facts.Repo != "github.com/owner/app" {
			t.Errorf("remote %s: repo = %q, want the canonical identity", remote, facts.Repo)
		}
		if strings.Contains(facts.Repo, "ghp_") || strings.Contains(facts.Repo, "token") {
			t.Errorf("remote %s: repo = %q carries a credential", remote, facts.Repo)
		}
	}
}

// The default branch and the upstream are read from what the checkout already
// recorded, which is what makes this question answerable on a machine with no
// network. The refs below are the ones a clone writes.
func TestInspectGitReadsTheDefaultBranchAndUpstreamOffline(t *testing.T) {
	dir := checkoutOn(t, filepath.Join(t.TempDir(), "app"), "main")
	gitCmd(t, dir, "remote", "add", "origin", "https://github.com/owner/app.git")
	gitCmd(t, dir, "update-ref", "refs/remotes/origin/main", "HEAD")
	gitCmd(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	gitCmd(t, dir, "branch", "--set-upstream-to=origin/main", "main")

	facts := inspect(t, dir)
	if facts.DefaultBranch != "main" {
		t.Errorf("default branch = %q, want main", facts.DefaultBranch)
	}
	if facts.Upstream != "origin/main" {
		t.Errorf("upstream = %q, want origin/main", facts.Upstream)
	}
}

// A checkout that never recorded where the remote's HEAD is has no default
// branch, and the honest answer is none: publish refuses to push a default
// branch, and a `main` guessed from the local list is exactly the wrong guess.
func TestInspectGitLeavesAnUnrecordedDefaultBranchEmpty(t *testing.T) {
	dir := checkoutOn(t, filepath.Join(t.TempDir(), "app"), "main")
	gitCmd(t, dir, "remote", "add", "origin", "https://github.com/owner/app.git")

	facts := inspect(t, dir)
	if facts.DefaultBranch != "" {
		t.Errorf("default branch = %q, want empty rather than a guess", facts.DefaultBranch)
	}
	if facts.Upstream != "" {
		t.Errorf("upstream = %q, want empty for a branch that tracks nothing", facts.Upstream)
	}
}

func TestInspectGitReportsADetachedHead(t *testing.T) {
	dir := checkoutOn(t, filepath.Join(t.TempDir(), "app"), "main")
	gitCmd(t, dir, "checkout", "--detach", "HEAD")

	facts := inspect(t, dir)
	if !facts.Detached || facts.Branch != "" {
		t.Errorf("answer = %+v, want a detached HEAD with no branch name", facts)
	}
	if facts.HeadOID == "" {
		t.Error("a detached HEAD still has a commit, and publish needs to know which")
	}
}

// A directory that is not a checkout is answered, not refused: "is this a
// checkout" is the question, and the caller is a phone that has to draw
// something either way.
func TestInspectGitSaysWhyADirectoryIsNotACheckout(t *testing.T) {
	facts := inspect(t, t.TempDir())
	if facts.IsGit {
		t.Fatalf("a plain directory reads as a checkout: %+v", facts)
	}
	if !strings.Contains(facts.Reason, "not a git repository") {
		t.Errorf("reason = %q, want the machine's own words", facts.Reason)
	}
	if facts.Repo != "" || facts.Branch != "" {
		t.Errorf("answer = %+v, want no repository and no branch", facts)
	}
}
