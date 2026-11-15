package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// initBareOrigin makes a bare repository to push into: the smallest thing that
// can answer "is this branch on the remote now, and at which commit".
func initBareOrigin(t *testing.T, dir string) {
	t.Helper()
	gitCmd(t, dir, "init", "--bare", "--initial-branch=main", ".")
	t.Cleanup(func() { removeGitDirForTest(dir) })
}

// originOf wires a checkout to a bare repository. A local path is not a remote
// this package can canonicalize, which is the point: these tests are about what
// happens to refs, not about which forge it is.
func originOf(t *testing.T, dir, origin string) {
	t.Helper()
	gitCmd(t, dir, "remote", "add", "origin", origin)
}

// gitOut is one git read whose answer the test needs. mTestGit is the package's
// own runner (checkpoint_test.go); this only turns a failure into a t.Fatal.
func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := mTestGit(dir, args...)
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

// remoteRef is what the bare origin has for a branch, empty when it has none.
func remoteRef(t *testing.T, origin, branch string) string {
	t.Helper()
	out, err := mTestGit(origin, "rev-parse", "refs/heads/"+branch)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func currentBranchOf(t *testing.T, dir string) string {
	t.Helper()
	return gitOut(t, dir, "rev-parse", "--abbrev-ref", "HEAD")
}

func TestCreateBranchStartsWhereHeadIsAndSwitchesToIt(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	before := gitOut(t, dir, "rev-parse", "HEAD")

	m := NewManager(t.TempDir())
	if err := m.CreateBranch(context.Background(), dir, "kin/task/t1/g1"); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}

	status, err := m.ListBranches(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if status.Current != "kin/task/t1/g1" {
		t.Fatalf("current = %q, want the new branch", status.Current)
	}
	// The commit that was there before is on the new branch: the branch starts
	// from HEAD, which is what makes publishing work in progress possible.
	if got := gitOut(t, dir, "rev-parse", "HEAD"); got != before {
		t.Fatalf("HEAD = %q, want the commit it started at %q", got, before)
	}
}

// The reason this is not CheckoutBranch: the work a session has not committed
// yet is exactly what a person is publishing, so a new branch that refused a
// dirty tree would leave it behind on the old one.
func TestCreateBranchCarriesUncommittedWork(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	if err := os.WriteFile(filepath.Join(dir, "README"), []byte("hi\nand more\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	m := NewManager(t.TempDir())
	if err := m.CreateBranch(context.Background(), dir, "kin/task/t1/g1"); err != nil {
		t.Fatalf("CreateBranch refused a dirty checkout: %v", err)
	}
	out := gitOut(t, dir, "status", "--porcelain=v1")
	if !strings.Contains(out, "README") {
		t.Fatalf("the uncommitted change did not come along: %q", out)
	}
}

func TestCreateBranchRefusesANameThatIsTaken(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	gitCmd(t, dir, "branch", "feature/a")
	m := NewManager(t.TempDir())

	err := m.CreateBranch(context.Background(), dir, "feature/a")
	if err == nil {
		t.Fatal("CreateBranch moved an existing branch instead of refusing")
	}
	if !strings.Contains(err.Error(), "exists") {
		t.Fatalf("err = %v, want it to say the branch is already there", err)
	}
	status, serr := m.ListBranches(context.Background(), dir)
	if serr != nil {
		t.Fatal(serr)
	}
	if status.Current == "feature/a" {
		t.Fatal("the checkout was switched to a branch it did not create")
	}
}

func TestCreateBranchRejectsANameThatIsNotOne(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	m := NewManager(t.TempDir())

	for _, name := range []string{"", "-b", "refs/heads/x", "a..b", "a:b", "a\\b"} {
		if err := m.CreateBranch(context.Background(), dir, name); err == nil {
			t.Fatalf("CreateBranch accepted %q", name)
		}
	}
	if got := gitOut(t, dir, "for-each-ref", "--format=%(refname:short)", "refs/heads"); got != "main" && got != "master" {
		t.Fatalf("branches = %q, want only the one it started with", got)
	}
}

func TestCreateBranchRefusesADirectoryThatIsNotACheckout(t *testing.T) {
	requireGit(t)
	m := NewManager(t.TempDir())
	if err := m.CreateBranch(context.Background(), t.TempDir(), "kin/task/t1/g1"); err == nil {
		t.Fatal("CreateBranch created a branch outside a repository")
	}
}

func TestPushBranchPutsTheBranchOnOriginAndTracksIt(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	origin := t.TempDir()
	initBareOrigin(t, origin)
	originOf(t, dir, origin)

	m := NewManager(t.TempDir())
	ctx := context.Background()
	if err := m.CreateBranch(ctx, dir, "kin/task/t1/g1"); err != nil {
		t.Fatal(err)
	}
	if err := m.PushBranch(ctx, dir, "kin/task/t1/g1"); err != nil {
		t.Fatalf("PushBranch: %v", err)
	}

	head := gitOut(t, dir, "rev-parse", "HEAD")
	if got := remoteRef(t, origin, "kin/task/t1/g1"); got != head {
		t.Fatalf("origin has %q, want %q", got, head)
	}
	// Tracking is set so that a later turn's `git status` can say how far ahead
	// the branch is, which is the first thing a person looks at after publishing.
	facts, err := m.InspectGit(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if facts.Upstream != "origin/kin/task/t1/g1" {
		t.Fatalf("upstream = %q, want the branch to track origin", facts.Upstream)
	}
}

// A push that git refuses is reported as a failure, and nothing on the remote
// moves. This is what stands between a publish button and a rewritten history:
// there is no --force anywhere on this path.
func TestPushBranchReportsARefusalAndLeavesTheRemoteAlone(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	commitFile(t, dir, "README", "hi\n")
	origin := t.TempDir()
	initBareOrigin(t, origin)
	originOf(t, dir, origin)

	m := NewManager(t.TempDir())
	ctx := context.Background()
	// The remote already has this branch at a commit this checkout does not
	// contain: a fast-forward is impossible and only --force would land.
	if err := m.PushBranch(ctx, dir, currentBranchOf(t, dir)); err != nil {
		t.Fatal(err)
	}
	other := t.TempDir()
	gitCmd(t, other, "clone", origin, ".")
	gitCmd(t, other, "config", "user.email", "kin@test.local")
	gitCmd(t, other, "config", "user.name", "Kin Test")
	commitFile(t, other, "OTHER", "theirs\n")
	gitCmd(t, other, "push", "origin", "HEAD:refs/heads/"+currentBranchOf(t, dir))

	remoteBefore := remoteRef(t, origin, currentBranchOf(t, dir))
	if err := m.PushBranch(ctx, dir, currentBranchOf(t, dir)); err == nil {
		t.Fatal("PushBranch reported success for a push git refused")
	}
	if got := remoteRef(t, origin, currentBranchOf(t, dir)); got != remoteBefore {
		t.Fatalf("origin moved from %q to %q", remoteBefore, got)
	}
}
