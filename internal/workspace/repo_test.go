package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// recordedGit is a gitRunner that answers from a script and remembers what it
// was asked, so a test can assert on the command a call decided to run.
type recordedGit struct {
	calls  []gitCall
	answer func(args []string) ([]byte, error)
}

type gitCall struct {
	dir  string
	args []string
}

func (r *recordedGit) Run(_ context.Context, dir string, _ map[string]string, _ int64, args ...string) ([]byte, error) {
	r.calls = append(r.calls, gitCall{dir: dir, args: append([]string(nil), args...)})
	if r.answer == nil {
		return nil, nil
	}
	return r.answer(args)
}

// What a person types is one of two things, and everything downstream depends on
// reading it the same way twice: the identity is the directory the checkout is
// kept under, so two names for one repository have to become one string.
func TestResolveRepoReadsTheTwoFormsAPersonTypes(t *testing.T) {
	for _, tc := range []struct {
		name      string
		raw       string
		canonical string
		cloneURL  string
	}{
		{
			name:      "shorthand",
			raw:       "owner/repo",
			canonical: "github.com/owner/repo",
			cloneURL:  "https://github.com/owner/repo.git",
		},
		{
			name:      "shorthand with the suffix people paste",
			raw:       "owner/repo.git",
			canonical: "github.com/owner/repo",
			cloneURL:  "https://github.com/owner/repo.git",
		},
		{
			name:      "an https remote",
			raw:       "https://github.com/owner/repo.git",
			canonical: "github.com/owner/repo",
			cloneURL:  "https://github.com/owner/repo.git",
		},
		{
			name:      "an scp remote keeps its transport",
			raw:       "git@github.com:owner/repo.git",
			canonical: "github.com/owner/repo",
			cloneURL:  "git@github.com:owner/repo.git",
		},
		{
			name:      "an ssh remote keeps its username",
			raw:       "ssh://git@github.com/owner/repo.git",
			canonical: "github.com/owner/repo",
			cloneURL:  "ssh://git@github.com/owner/repo.git",
		},
		{
			name:      "another host is another repository",
			raw:       "https://git.example.com/team/repo.git",
			canonical: "git.example.com/team/repo",
			cloneURL:  "https://git.example.com/team/repo.git",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveRepo(tc.raw)
			if err != nil {
				t.Fatalf("ResolveRepo(%q): %v", tc.raw, err)
			}
			if got.Canonical != tc.canonical {
				t.Fatalf("ResolveRepo(%q).Canonical = %q, want %q", tc.raw, got.Canonical, tc.canonical)
			}
			if got.CloneURL != tc.cloneURL {
				t.Fatalf("ResolveRepo(%q).CloneURL = %q, want %q", tc.raw, got.CloneURL, tc.cloneURL)
			}
		})
	}
}

// A URL can carry a token, and every string this package hands to git comes back
// in git's own error messages — which travel to the Hub and onto a phone. So the
// credential comes off, and nothing else does: the path is what the remote's
// server expects, and `git@` on an ssh remote is a username it needs.
func TestResolveRepoDropsTheCredentialAndNothingElse(t *testing.T) {
	for _, tc := range []struct {
		name     string
		raw      string
		cloneURL string
	}{
		{
			name:     "a token as the username",
			raw:      "https://ghp_secretvalue@github.com/owner/repo.git",
			cloneURL: "https://github.com/owner/repo.git",
		},
		{
			name:     "a token as the password",
			raw:      "https://someone:ghp_secretvalue@github.com/owner/repo.git",
			cloneURL: "https://github.com/owner/repo.git",
		},
		{
			name:     "a token on another host, keeping its port",
			raw:      "https://ghp_secretvalue@git.example.com:8443/team/repo.git",
			cloneURL: "https://git.example.com:8443/team/repo.git",
		},
		{
			name:     "an ssh username is not a credential",
			raw:      "ssh://git@github.com/owner/repo.git",
			cloneURL: "ssh://git@github.com/owner/repo.git",
		},
		{
			name:     "an ssh password is",
			raw:      "ssh://git:hunter2@github.com/owner/repo.git",
			cloneURL: "ssh://git@github.com/owner/repo.git",
		},
		{
			name:     "an scp remote has nowhere to put one",
			raw:      "git@github.com:owner/repo.git",
			cloneURL: "git@github.com:owner/repo.git",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveRepo(tc.raw)
			if err != nil {
				t.Fatalf("ResolveRepo(%q): %v", tc.raw, err)
			}
			if got.CloneURL != tc.cloneURL {
				t.Fatalf("ResolveRepo(%q).CloneURL = %q, want %q", tc.raw, got.CloneURL, tc.cloneURL)
			}
			if strings.Contains(got.CloneURL, "ghp_secretvalue") || strings.Contains(got.CloneURL, "hunter2") {
				t.Fatalf("ResolveRepo(%q).CloneURL = %q kept a credential", tc.raw, got.CloneURL)
			}
			if strings.Contains(got.Canonical, "ghp_secretvalue") || strings.Contains(got.Canonical, "@") {
				t.Fatalf("ResolveRepo(%q).Canonical = %q kept a credential", tc.raw, got.Canonical)
			}
		})
	}
}

// A git remote is not only an address: the syntax admits a transport prefix, and
// `ext::sh -c …` is a well-formed remote that runs a command. It would run with
// this machine's privileges, named by a Hub that does not own this machine, so
// the transports are enumerated here rather than the attacks.
func TestResolveRepoRefusesATransportWhereARepositoryWasNamed(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
	}{
		{name: "an ext transport that runs a command", raw: "ext::sh -c whoami"},
		{name: "an ext transport hiding behind a user", raw: "ext::git@example.com"},
		{name: "a file url", raw: "file:///etc"},
		{name: "a local path", raw: "/srv/git/repo.git"},
		{name: "a bare word", raw: "repo"},
		{name: "a nested group is not the shorthand", raw: "group/sub/repo"},
		{name: "nothing at all", raw: "   "},
		{name: "a name that is an option", raw: "--upload-pack=/bin/sh"},
		{name: "a name with a newline", raw: "owner/repo\n--upload-pack=/bin/sh"},
		{name: "a transport with no repository", raw: "https://github.com"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ResolveRepo(tc.raw); err == nil {
				t.Fatalf("ResolveRepo(%q) accepted a name that is not a repository", tc.raw)
			}
		})
	}
}

// The checkout root is permission to write, and the Hub chooses the repository
// name, so the Hub chooses this path. A canonical name that can climb is a name
// that turns "clone this repository" into "write anywhere the daemon can".
func TestCheckoutPathStaysInsideTheRoot(t *testing.T) {
	c := NewCheckouts(filepath.Join(t.TempDir(), "checkouts"))

	inside, err := c.pathFor("github.com/owner/repo")
	if err != nil {
		t.Fatalf("pathFor: %v", err)
	}
	if want := filepath.Join(c.Root(), "github.com", "owner", "repo"); inside != want {
		t.Fatalf("pathFor = %q, want %q", inside, want)
	}

	for _, canonical := range []string{
		"github.com/../../etc/passwd",
		"../outside",
		"..",
		".",
		"github.com/./repo",
		"github.com//repo",
		"/etc/passwd",
	} {
		got, err := c.pathFor(canonical)
		if err == nil {
			t.Fatalf("pathFor(%q) = %q, want a refusal", canonical, got)
		}
		if got != "" {
			t.Fatalf("pathFor(%q) returned a path alongside its refusal: %q", canonical, got)
		}
	}
}

// `git ls-remote --symref` answers the default branch and the refs in one call,
// and the rest of its output is not a branch.
func TestParseLsRemoteReadsBranchesAndTheDefault(t *testing.T) {
	out := strings.Join([]string{
		"ref: refs/heads/main\tHEAD",
		"7aa0be4d0000000000000000000000000000000000\tHEAD",
		"7aa0be4d0000000000000000000000000000000000\trefs/heads/main",
		"1111111111111111111111111111111111111111\trefs/heads/alpha",
		"2222222222222222222222222222222222222222\trefs/heads/zeta",
		"3333333333333333333333333333333333333333\trefs/tags/v1",
		"",
	}, "\n")

	branches, defaultBranch := parseLsRemote(out)
	if defaultBranch != "main" {
		t.Fatalf("default branch = %q, want main", defaultBranch)
	}
	if got := strings.Join(branches, ","); got != "alpha,main,zeta" {
		t.Fatalf("branches = %q, want alpha,main,zeta (sorted, tags and HEAD excluded)", got)
	}

	// A remote with no HEAD symref — a bare repository with a detached HEAD, or
	// one this machine has no credential to read fully — still has branches, and
	// an unknown default is a truthful empty answer rather than a failure.
	branches, defaultBranch = parseLsRemote("4444444444444444444444444444444444444444\trefs/heads/only\n")
	if defaultBranch != "" {
		t.Fatalf("default branch = %q, want empty when the remote names none", defaultBranch)
	}
	if len(branches) != 1 || branches[0] != "only" {
		t.Fatalf("branches = %v, want [only]", branches)
	}
}

// Asking what branches a remote has is one round trip, in the machine's own
// checkout root rather than wherever the daemon was started.
func TestRemoteBranchesAsksTheRemoteOnce(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkouts")
	c := NewCheckouts(root)
	git := &recordedGit{answer: func([]string) ([]byte, error) {
		return []byte("ref: refs/heads/main\tHEAD\nabc\trefs/heads/main\n"), nil
	}}
	c.git = git

	got, err := c.RemoteBranches(context.Background(), "owner/repo")
	if err != nil {
		t.Fatalf("RemoteBranches: %v", err)
	}
	if got.Repo != "github.com/owner/repo" {
		t.Fatalf("Repo = %q, want the canonical name a later prepare is asked for", got.Repo)
	}
	if got.DefaultBranch != "main" || len(got.Branches) != 1 {
		t.Fatalf("RemoteBranches = %+v", got)
	}
	if len(git.calls) != 1 {
		t.Fatalf("made %d git calls, want 1: %+v", len(git.calls), git.calls)
	}
	call := git.calls[0]
	if call.dir != root {
		t.Fatalf("ran in %q, want the checkout root %q", call.dir, root)
	}
	want := []string{"ls-remote", "--symref", "--", "https://github.com/owner/repo.git"}
	if strings.Join(call.args, " ") != strings.Join(want, " ") {
		t.Fatalf("ran %v, want %v", call.args, want)
	}

	// A remote this machine can reach but that answers with no branches is a
	// refusal, not an empty picker.
	git.answer = func([]string) ([]byte, error) { return nil, nil }
	if _, err := c.RemoteBranches(context.Background(), "owner/repo"); err == nil {
		t.Fatal("RemoteBranches accepted a remote with no branches")
	}
}

// Everything that can be decided before touching git is decided before touching
// git, so a refused question costs the machine nothing.
func TestEnsureCheckoutRefusesBeforeItRunsAnything(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkouts")
	for _, tc := range []struct {
		name   string
		repo   string
		branch string
	}{
		{name: "no repository", repo: ""},
		{name: "a transport instead of a repository", repo: "ext::sh -c whoami"},
		{name: "a branch that is an option", repo: "owner/repo", branch: "-f"},
		{name: "a branch that climbs", repo: "owner/repo", branch: "../../main"},
		{name: "a branch with a newline", repo: "owner/repo", branch: "main\n-f"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := NewCheckouts(root)
			git := &recordedGit{}
			c.git = git
			if _, err := c.EnsureCheckout(context.Background(), tc.repo, tc.branch); err == nil {
				t.Fatalf("EnsureCheckout(%q, %q) was accepted", tc.repo, tc.branch)
			}
			if len(git.calls) != 0 {
				t.Fatalf("refused after running %v", git.calls)
			}
		})
	}
}

// The destination is derived from the canonical name and nothing else, and the
// clone is handed the branch the person chose.
func TestEnsureCheckoutClonesIntoThePathItDerived(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkouts")
	c := NewCheckouts(root)
	git := &recordedGit{answer: func(args []string) ([]byte, error) {
		if args[0] == "rev-parse" {
			return []byte("main\n"), nil
		}
		return nil, nil
	}}
	c.git = git

	got, err := c.EnsureCheckout(context.Background(), "owner/repo", "main")
	if err != nil {
		t.Fatalf("EnsureCheckout: %v", err)
	}
	dest := filepath.Join(root, "github.com", "owner", "repo")
	if got.Path != dest {
		t.Fatalf("Path = %q, want %q", got.Path, dest)
	}
	if !got.Cloned || got.Branch != "main" {
		t.Fatalf("Checkout = %+v, want a clone on main", got)
	}
	if len(git.calls) != 2 {
		t.Fatalf("made %d git calls, want a clone and a read of the branch: %+v", len(git.calls), git.calls)
	}
	want := "clone --branch main -- https://github.com/owner/repo.git " + dest
	if args := git.calls[0].args; strings.Join(args, " ") != want {
		t.Fatalf("ran %v, want %q", args, want)
	}
}

// A directory that is already there is only reused if it is that repository, and
// switching it is refused when somebody is working in it.
func TestEnsureCheckoutAdoptsOnlyItsOwnRepository(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	repo, dest, c := localOrigin(t, gitPath)

	// First time: it clones.
	first, err := c.clone(context.Background(), dest, repo, "main")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	if !first.Cloned || first.Branch != "main" {
		t.Fatalf("first = %+v, want a clone on main", first)
	}

	// Second time: it finds what it made and fetches, rather than cloning again.
	second, err := c.reuse(context.Background(), dest, repo, "main")
	if err != nil {
		t.Fatalf("reuse: %v", err)
	}
	if second.Cloned || second.Branch != "main" || second.Path != dest {
		t.Fatalf("second = %+v, want the checkout that was already there", second)
	}

	// A different branch is switched to, because the directory is this machine's
	// own copy of this repository.
	switched, err := c.reuse(context.Background(), dest, repo, "alpha")
	if err != nil {
		t.Fatalf("reuse onto another branch: %v", err)
	}
	if switched.Branch != "alpha" {
		t.Fatalf("Branch = %q, want alpha", switched.Branch)
	}

	// Uncommitted work is not carried across a switch: the session working in
	// there belongs to whoever started it.
	if err := os.WriteFile(filepath.Join(dest, "wip.txt"), []byte("in progress\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := c.reuse(context.Background(), dest, repo, "main"); err == nil {
		t.Fatal("reuse switched a checkout with uncommitted work")
	}

	// A directory at that path belonging to another repository is a collision to
	// report, not something to overwrite.
	runGit(t, gitPath, dest, "remote", "set-url", "origin", "https://github.com/someone/else.git")
	if _, err := c.reuse(context.Background(), dest, repo, "main"); err == nil {
		t.Fatal("reuse adopted a checkout belonging to another repository")
	}

	// And a directory that is not a checkout at all is refused rather than
	// replaced.
	stranger := filepath.Join(c.Root(), "github.com", "owner", "stranger")
	if err := os.MkdirAll(stranger, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := c.reuse(context.Background(), stranger, repo, "main"); err == nil {
		t.Fatal("reuse adopted a directory that is not a checkout")
	}

	// A file where the checkout goes is refused too, before anything runs.
	blocked := filepath.Join(c.Root(), "github.com", "owner", "blocked")
	if err := os.MkdirAll(filepath.Dir(blocked), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blocked, []byte("not a checkout\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := c.EnsureCheckout(context.Background(), "owner/blocked", "main"); err == nil {
		t.Fatal("EnsureCheckout accepted a file in the way of the checkout")
	}
}

// A clone that asked for a branch the remote does not have leaves nothing
// behind: a half-made directory would make the next attempt read as a collision
// with itself.
func TestFailedCloneLeavesNothingBehind(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	repo, dest, c := localOrigin(t, gitPath)

	if _, err := c.clone(context.Background(), dest, repo, "no-such-branch"); err == nil {
		t.Fatal("clone succeeded for a branch the remote does not have")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("a failed clone left %s behind (%v)", dest, err)
	}

	// Debris from a clone that was killed rather than one that failed: git
	// cleans up after the errors it reports, and this is the case it does not
	// get to report. Merging into it is not possible — git refuses a
	// destination that is not empty — so the alternative to clearing it is a
	// repository name that can never be prepared again.
	if err := os.MkdirAll(filepath.Join(dest, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := c.clone(context.Background(), dest, repo, "main"); err == nil {
		t.Fatal("clone succeeded into a directory that already had something in it")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("a half-made checkout was left at %s", dest)
	}

	// And the name is usable afterwards, which is the property that matters.
	if _, err := c.clone(context.Background(), dest, repo, "main"); err != nil {
		t.Fatalf("clone after clearing the debris: %v", err)
	}

	// The machine has no checkout directory, and says so, rather than writing
	// into whatever directory the daemon was started in. The working directory
	// is moved so that a path built from an empty root would land somewhere
	// visible instead of beside the checkout.
	t.Chdir(t.TempDir())
	off := NewCheckouts("")
	_, err = off.EnsureCheckout(context.Background(), "owner/repo", "main")
	if err == nil {
		t.Fatal("a machine with no checkout directory accepted a prepare")
	}
	if !strings.Contains(err.Error(), "checkout directory") {
		t.Fatalf("refusal = %q, want it to say the machine has no checkout directory", err)
	}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("a machine with no checkout directory wrote %v", entries)
	}
}

// localOrigin is a bare repository on this machine, named the way this package
// names a repository, so a clone and a fetch can be exercised for real without
// leaving the machine.
func localOrigin(t *testing.T, gitPath string) (Repo, string, *Checkouts) {
	t.Helper()
	url := "file://localhost" + bareOrigin(t, gitPath)
	canonical, err := CanonicalRemote(url)
	if err != nil {
		t.Fatalf("CanonicalRemote(%q): %v", url, err)
	}
	repo := Repo{Canonical: canonical, CloneURL: url}
	c := NewCheckouts(filepath.Join(t.TempDir(), "checkouts"))

	dest, err := c.pathFor(canonical)
	if err != nil {
		t.Fatalf("pathFor(%q): %v", canonical, err)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		t.Fatal(err)
	}
	return repo, dest, c
}

// bareOrigin builds a bare repository with two branches, for a clone that never
// leaves the machine.
func bareOrigin(t *testing.T, gitPath string) string {
	t.Helper()
	work := t.TempDir()
	runGit(t, gitPath, work, "init", "-b", "main")
	runGit(t, gitPath, work, "config", "user.email", "owner@example.com")
	runGit(t, gitPath, work, "config", "user.name", "Owner")
	if err := os.WriteFile(filepath.Join(work, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, gitPath, work, "add", "README.md")
	runGit(t, gitPath, work, "commit", "-m", "first")
	runGit(t, gitPath, work, "branch", "alpha")

	bare := filepath.Join(t.TempDir(), "origin.git")
	runGit(t, gitPath, "", "clone", "--bare", work, bare)
	return bare
}
