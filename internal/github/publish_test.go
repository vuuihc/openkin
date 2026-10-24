package github

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/workspace"
)

// publishFixture is a checkout that could be published: a commit, a branch named
// the way a task's branch is named, and an origin that reads as a GitHub
// repository while pushing to a bare repository on this disk.
//
// The rewrite is what makes an honest test possible: `url.<bare>.pushInsteadOf`
// keeps the remote spelled `https://github.com/owner/app.git` — the only spelling
// this package will publish — while the push itself lands somewhere a test can
// look at. It is pushInsteadOf and not insteadOf on purpose: insteadOf rewrites
// what `git remote get-url origin` answers too, and the checkout would then have
// no GitHub origin and nothing to publish at all. Nothing else here is faked: it
// is the real git, the real branch, the real push.
type publishFixture struct {
	dir       string
	origin    string
	manager   *workspace.Manager
	canonical string
}

func newPublishFixture(t *testing.T) *publishFixture {
	t.Helper()
	requireGitBinary(t)
	f := &publishFixture{dir: t.TempDir(), origin: t.TempDir(), canonical: "github.com/owner/app"}
	gitIn(t, f.origin, "init", "--bare", "--initial-branch=main", ".")
	gitIn(t, f.dir, "init", "--initial-branch=main", ".")
	gitIn(t, f.dir, "config", "user.email", "kin@test.local")
	gitIn(t, f.dir, "config", "user.name", "Kin Test")
	for _, kv := range [][2]string{{"gc.auto", "0"}, {"maintenance.auto", "false"}} {
		gitIn(t, f.dir, "config", kv[0], kv[1])
	}
	writeFileIn(t, f.dir, "README", "hi\n")
	gitIn(t, f.dir, "add", "README")
	gitIn(t, f.dir, "commit", "-m", "init")
	gitIn(t, f.dir, "remote", "add", "origin", "https://github.com/owner/app.git")
	gitIn(t, f.dir, "config", "url."+f.origin+".pushInsteadOf", "https://github.com/owner/app.git")
	f.manager = workspace.NewManager(t.TempDir())
	// The checkout starts on a branch that is not the default one: publishing
	// from the default branch is refused, and that refusal has its own test.
	if err := f.manager.CreateBranch(context.Background(), f.dir, "kin/task/t1/g1"); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *publishFixture) remoteHas(t *testing.T, branch string) string {
	t.Helper()
	out, err := gitCapture(f.origin, "rev-parse", "refs/heads/"+branch)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

func (f *publishFixture) head(t *testing.T) string {
	t.Helper()
	out, err := gitCapture(f.dir, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(out)
}

func TestPublishPushesTheBranchAndAnswersWithThePullRequest(t *testing.T) {
	f := newPublishFixture(t)
	argsFile := filepath.Join(t.TempDir(), "args")
	gh := fakeGH(t, "#!/bin/sh\nprintf '%s\\n' \"$@\" > "+argsFile+"\nprintf 'https://github.com/owner/app/pull/7\\n'\n")

	out, err := publishWith(context.Background(), f.manager, gh, PublishRequest{
		Dir:   f.dir,
		Title: "Add the thing",
		Body:  "It does the thing.",
	})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if out.Blocked != "" {
		t.Fatalf("blocked: %s (%s)", out.Blocked, out.Reason)
	}
	if !out.Pushed {
		t.Fatal("the branch was not reported as pushed")
	}
	if got := f.remoteHas(t, "kin/task/t1/g1"); got != f.head(t) {
		t.Fatalf("origin has %q, want %q", got, f.head(t))
	}
	if out.Number != 7 || out.URL != "https://github.com/owner/app/pull/7" {
		t.Fatalf("pull request = %d %q", out.Number, out.URL)
	}
	if out.Repo.Canonical() != f.canonical || out.Branch != "kin/task/t1/g1" {
		t.Fatalf("outcome names %s %s", out.Repo.Canonical(), out.Branch)
	}
	if out.HeadOID != f.head(t) {
		t.Fatalf("head = %q, want %q", out.HeadOID, f.head(t))
	}

	// The repository and the branch are named on the command line rather than
	// left to a working directory gh was not given.
	args, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"pr", "create", "--repo", "owner/app", "--head", "kin/task/t1/g1", "--title", "Add the thing", "--body", "It does the thing."}
	if got := strings.Fields(string(args)); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("gh args = %v, want %v", got, want)
	}
}

func TestPublishRefusesTheDefaultBranchAndPushesNothing(t *testing.T) {
	f := newPublishFixture(t)
	// A clone records which branch origin's HEAD names; this is that record.
	gitIn(t, f.dir, "update-ref", "refs/remotes/origin/main", f.head(t))
	gitIn(t, f.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	gitIn(t, f.dir, "checkout", "-q", "main")

	out, err := publishWith(context.Background(), f.manager, fakeGH(t, "#!/bin/sh\nexit 0\n"), PublishRequest{
		Dir: f.dir, Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocked != PublishBlockedDefault {
		t.Fatalf("blocked = %q (%s), want the default branch", out.Blocked, out.Reason)
	}
	if out.Pushed || f.remoteHas(t, "main") != "" {
		t.Fatal("the default branch was pushed")
	}
}

// A checkout whose remote was added by hand has no origin/HEAD to read, and
// `main` is still a name that must not travel by button.
func TestPublishRefusesMainWhenTheDefaultBranchIsUnknown(t *testing.T) {
	f := newPublishFixture(t)
	gitIn(t, f.dir, "checkout", "-q", "main")
	out, err := publishWith(context.Background(), f.manager, fakeGH(t, "#!/bin/sh\nexit 0\n"), PublishRequest{
		Dir: f.dir, Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocked != PublishBlockedDefault {
		t.Fatalf("blocked = %q (%s), want the default branch", out.Blocked, out.Reason)
	}
	if f.remoteHas(t, "main") != "" {
		t.Fatal("main was pushed")
	}
}

// A checkout whose remote was added by hand records no origin/HEAD, and `main` is
// only one of the names a repository's default branch goes by. The forge is asked,
// once, and the branch it names is refused too.
func TestPublishRefusesTheDefaultBranchTheForgeNames(t *testing.T) {
	f := newPublishFixture(t)
	// This repository's trunk is `trunk`, and nothing in the checkout says so:
	// no origin/HEAD, no remote-tracking branch, nothing to read offline.
	gitIn(t, f.dir, "branch", "-m", "trunk")
	gh := fakeGH(t, "#!/bin/sh\nprintf '{\"default_branch\":\"trunk\",\"private\":true}\\n'\n")

	out, err := publishWith(context.Background(), f.manager, gh, PublishRequest{
		Dir: f.dir, Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocked != PublishBlockedDefault {
		t.Fatalf("blocked = %q (%s), want the default branch the forge named", out.Blocked, out.Reason)
	}
	if !strings.Contains(out.Reason, "trunk") {
		t.Fatalf("reason = %q, want the branch named", out.Reason)
	}
	if f.remoteHas(t, "trunk") != "" {
		t.Fatal("the forge's default branch was pushed")
	}
}

// A machine whose gh cannot answer for the repository is still refused on the two
// names every repository with a trunk has, because the direction to err in is
// refusing a push that might have been wanted.
func TestPublishFallsBackToTheTwoNamesWhenTheForgeWillNotSay(t *testing.T) {
	f := newPublishFixture(t)
	gitIn(t, f.dir, "checkout", "-q", "main")
	// gh failing is the ordinary way this happens: no credentials for a private
	// repository, or no network.
	gh := fakeGH(t, "#!/bin/sh\necho 'gh: Not Found (HTTP 404)' >&2\nexit 1\n")

	out, err := publishWith(context.Background(), f.manager, gh, PublishRequest{
		Dir: f.dir, Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocked != PublishBlockedDefault {
		t.Fatalf("blocked = %q (%s), want main refused anyway", out.Blocked, out.Reason)
	}
	if f.remoteHas(t, "main") != "" {
		t.Fatal("main was pushed")
	}
}

// The console offers a way out of exactly one refusal — start this task's branch,
// then publish that — and a checkout that is both on the default branch and dirty
// would be refused again the moment it was on the branch. So uncommitted work is
// what the person is told about first, and the branch is only ever offered on a
// checkout where the offer can be kept.
func TestPublishNamesUncommittedWorkBeforeTheDefaultBranch(t *testing.T) {
	f := newPublishFixture(t)
	gitIn(t, f.dir, "checkout", "-q", "main")
	writeFileIn(t, f.dir, "notes.md", "uncommitted\n")

	out, err := publishWith(context.Background(), f.manager, fakeGH(t, "#!/bin/sh\nexit 0\n"), PublishRequest{
		Dir: f.dir, Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocked != PublishBlockedDirty {
		t.Fatalf("blocked = %q (%s), want the uncommitted work", out.Blocked, out.Reason)
	}
	if !strings.Contains(out.Reason, "notes.md") {
		t.Fatalf("reason does not name the file: %q", out.Reason)
	}
}

func TestPublishRefusesUncommittedWorkByName(t *testing.T) {
	f := newPublishFixture(t)
	writeFileIn(t, f.dir, "notes.md", "uncommitted\n")

	out, err := publishWith(context.Background(), f.manager, fakeGH(t, "#!/bin/sh\nexit 0\n"), PublishRequest{
		Dir: f.dir, Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocked != PublishBlockedDirty {
		t.Fatalf("blocked = %q (%s), want uncommitted work", out.Blocked, out.Reason)
	}
	if !strings.Contains(out.Reason, "notes.md") {
		t.Fatalf("reason does not name the file: %q", out.Reason)
	}
	if out.Pushed || f.remoteHas(t, "kin/task/t1/g1") != "" {
		t.Fatal("a dirty checkout was published")
	}
}

func TestPublishRefusesACheckoutWithNoGitHubOrigin(t *testing.T) {
	f := newPublishFixture(t)
	gitIn(t, f.dir, "remote", "set-url", "origin", f.origin)

	out, err := publishWith(context.Background(), f.manager, fakeGH(t, "#!/bin/sh\nexit 0\n"), PublishRequest{
		Dir: f.dir, Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocked != PublishBlockedNoRemote {
		t.Fatalf("blocked = %q (%s), want no GitHub remote", out.Blocked, out.Reason)
	}
}

func TestPublishRefusesADetachedHead(t *testing.T) {
	f := newPublishFixture(t)
	gitIn(t, f.dir, "checkout", "-q", "--detach")

	out, err := publishWith(context.Background(), f.manager, fakeGH(t, "#!/bin/sh\nexit 0\n"), PublishRequest{
		Dir: f.dir, Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocked != PublishBlockedDetached {
		t.Fatalf("blocked = %q (%s), want a detached head", out.Blocked, out.Reason)
	}
}

func TestPublishRefusesADirectoryThatIsNotACheckout(t *testing.T) {
	requireGitBinary(t)
	m := workspace.NewManager(t.TempDir())
	out, err := publishWith(context.Background(), m, fakeGH(t, "#!/bin/sh\nexit 0\n"), PublishRequest{
		Dir: t.TempDir(), Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocked != PublishBlockedNotACheckout {
		t.Fatalf("blocked = %q (%s), want not a checkout", out.Blocked, out.Reason)
	}
}

// The branch is up and the pull request is not. Both halves are reported, and
// GitHub's own words are relayed rather than summarized: the commonest way this
// happens is a pull request that already exists.
func TestPublishReportsAPushThatGHCouldNotFinish(t *testing.T) {
	f := newPublishFixture(t)
	gh := fakeGH(t, "#!/bin/sh\necho 'a pull request for branch \"kin/task/t1/g1\" into branch \"main\" already exists' >&2\nexit 1\n")

	out, err := publishWith(context.Background(), f.manager, gh, PublishRequest{
		Dir: f.dir, Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatalf("a gh failure after a push was reported as a refusal: %v", err)
	}
	if !out.Pushed {
		t.Fatal("the push that happened was not reported")
	}
	if out.Number != 0 || out.URL != "" {
		t.Fatalf("a pull request was invented: %d %q", out.Number, out.URL)
	}
	if !strings.Contains(out.Reason, "already exists") {
		t.Fatalf("gh's own words did not survive: %q", out.Reason)
	}
	if got := f.remoteHas(t, "kin/task/t1/g1"); got != f.head(t) {
		t.Fatalf("origin has %q, want the branch that was pushed", got)
	}
}

func TestPublishRefusesWhenThereIsNoGHToFinishWith(t *testing.T) {
	f := newPublishFixture(t)
	// A nil client is the production path, which resolves this machine's own gh.
	t.Setenv(ghPathEnv, filepath.Join(t.TempDir(), "no-such-gh"))

	out, err := publishWith(context.Background(), f.manager, nil, PublishRequest{
		Dir: f.dir, Title: "t", Body: "b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocked != PublishBlockedNoGH {
		t.Fatalf("blocked = %q (%s), want no gh", out.Blocked, out.Reason)
	}
	if out.Pushed || f.remoteHas(t, "kin/task/t1/g1") != "" {
		t.Fatal("a machine that cannot finish a publish pushed anyway")
	}
}

// --- helpers ---------------------------------------------------------------

func requireGitBinary(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
}

// gitCapture runs git in dir. The fixtures here are real repositories, so the
// tests are about what git does rather than about what this package hopes it
// does.
func gitCapture(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	if out, err := gitCapture(dir, args...); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func writeFileIn(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
