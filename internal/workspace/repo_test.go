package workspace

import (
	"context"
	"fmt"
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
		{
			// A slash after the colon is a path on the *remote* machine, which is
			// what an scp remote is for. Only a slash before the colon makes the
			// string a path on this one (see readsAsPath).
			name:      "an scp remote with an absolute path there",
			raw:       "git@git.example.com:/srv/git/repo.git",
			canonical: "git.example.com/srv/git/repo",
			cloneURL:  "git@git.example.com:/srv/git/repo.git",
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
		{
			// The userinfo ends at the last `@`, which is where url.Parse and git
			// put it: a password may contain one, so splitting at the first leaves
			// the tail of the password in the host position and puts it back on the
			// wire as the username.
			name:     "a password with an @ in it",
			raw:      "https://me:sec@ret@github.com/owner/repo.git",
			cloneURL: "https://github.com/owner/repo.git",
		},
		{
			name:     "an ssh password with an @ in it",
			raw:      "ssh://git:sec@ret@github.com/owner/repo.git",
			cloneURL: "ssh://git@github.com/owner/repo.git",
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
			if strings.Contains(got.CloneURL, "ghp_secretvalue") || strings.Contains(got.CloneURL, "hunter2") ||
				strings.Contains(got.CloneURL, "sec@ret") {
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
//
// The last group is the same class reached another way. git decides for itself
// whether a string is a URL or a path — url_is_local_not_ssh(): no colon, or a
// slash before the first colon, is a path — and it resolves a path against the
// directory it was started in, which for this package is the checkout root. An
// `@` before a colon is not the test; these all have one.
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
		{name: "a path that climbs out of the checkout root", raw: "../x@y/z:w"},
		{name: "a relative path inside the checkout root", raw: "x@y/z:w"},
		{name: "a slash before the first colon", raw: "dir/sub@host:path"},
		{name: "a windows path with a drive letter", raw: "C:/x@y/z"},
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

// The answer to "what branches does this have" is also the question "fetch
// this", so the answer has to be a name the machine still accepts when it comes
// back. The canonical name is not one: it carries no transport, and for a
// remote whose host has a port, reading it back turns `host:port/owner/repo`
// into scp syntax and the port into a path.
func TestTheAnswerToBranchesIsSomethingPrepareAccepts(t *testing.T) {
	c := NewCheckouts(filepath.Join(t.TempDir(), "checkouts"))
	c.git = &recordedGit{answer: func([]string) ([]byte, error) {
		return []byte("ref: refs/heads/main\tHEAD\nabc\trefs/heads/main\n"), nil
	}}

	got, err := c.RemoteBranches(context.Background(), "http://127.0.0.1:7779/origin.git")
	if err != nil {
		t.Fatalf("RemoteBranches: %v", err)
	}
	back, err := ResolveRepo(got.CloneURL)
	if err != nil {
		t.Fatalf("asking again with the answer %q: %v", got.CloneURL, err)
	}
	if back.Canonical != got.Repo {
		t.Fatalf("the answer %q reads back as %q, not as the %q it came from",
			got.CloneURL, back.Canonical, got.Repo)
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
		t.Fatalf("Repo = %q, want the canonical name", got.Repo)
	}
	if got.CloneURL != "https://github.com/owner/repo.git" {
		t.Fatalf("CloneURL = %q, want the form a later prepare is asked for", got.CloneURL)
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
// git, and the read path is a door too.
//
// repo.branches and repo.prepare are two questions a console asks one machine,
// and a name has to be gated the same way at both: a gate only the write path
// takes is a gate chosen by which method the console happened to call. The last
// two cases are the ones that say the gate itself is shared rather than written
// down twice. `owner/../repo` is the shorthand with a climb in it, so it is
// ResolveRepo that reads it as one and pathFor that refuses the component it
// becomes; a canonical name with an empty component is a remote whose URL is
// well-formed and whose path is not a path this machine will build. This call
// has no destination of its own, which is exactly why it has to ask for one.
func TestRemoteBranchesRefusesBeforeItRunsAnything(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkouts")
	for _, tc := range []struct {
		name string
		repo string
	}{
		{name: "no repository", repo: ""},
		{name: "a transport instead of a repository", repo: "ext::sh -c whoami"},
		{name: "a path that climbs out of the checkout root", repo: "../x@y/z:w"},
		{name: "a local path", repo: "/srv/git/repo.git"},
		{name: "a file url", repo: "file:///etc"},
		{name: "a shorthand with a climb in it", repo: "../repo"},
		{name: "a canonical name with an empty component", repo: "https://github.com/owner//repo"},
		// Not a path by git's rule and not a second decoder's business either:
		// URL parsing is what turns this into `..`, and pathFor refuses the
		// component that comes out.
		{name: "a percent-encoded climb", repo: "https://github.com/owner/%2e%2e/repo"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := NewCheckouts(root)
			git := &recordedGit{}
			c.git = git
			if _, err := c.RemoteBranches(context.Background(), tc.repo); err == nil {
				t.Fatalf("RemoteBranches(%q) was accepted", tc.repo)
			}
			if len(git.calls) != 0 {
				t.Fatalf("refused after running %v", git.calls)
			}
		})
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

// The destination is derived from the canonical name and nothing else, the clone
// is handed the branch the person chose, and what the clone made is moved into
// the destination rather than written there.
//
// The directory git is given is one this call made a moment earlier, and that is
// the point of it: a clone that fails, or that finds the destination occupied by
// then, can only ever clear its own scratch directory — never a checkout another
// process put there.
func TestEnsureCheckoutClonesIntoThePathItDerived(t *testing.T) {
	root := filepath.Join(t.TempDir(), "checkouts")
	c := NewCheckouts(root)
	git := &recordedGit{answer: func(args []string) ([]byte, error) {
		switch args[0] {
		case "clone":
			// A real clone fills the directory it was handed; the move that follows
			// has to land somewhere, so this one is filled too.
			staging := args[len(args)-1]
			if err := os.MkdirAll(staging, 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(filepath.Join(staging, "README.md"), []byte("hello\n"), 0o644); err != nil {
				return nil, err
			}
			return nil, nil
		case "rev-parse":
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
	cloneArgs := git.calls[0].args
	want := []string{"clone", "--branch", "main", "--", "https://github.com/owner/repo.git"}
	if strings.Join(cloneArgs[:len(cloneArgs)-1], " ") != strings.Join(want, " ") {
		t.Fatalf("ran %v, want %q and a directory of its own", cloneArgs, strings.Join(want, " "))
	}
	staging := cloneArgs[len(cloneArgs)-1]
	if staging == dest {
		t.Fatal("the clone was given the destination itself, which another process may be filling")
	}
	if !samePath(t, filepath.Dir(staging), filepath.Dir(dest)) {
		t.Fatalf("the clone was given %q, want a directory beside %q", staging, dest)
	}
	// And what it made is where the caller is told it is, with nothing left over.
	if info, err := os.Stat(dest); err != nil || !info.IsDir() {
		t.Fatalf("nothing was moved to %q (%v)", dest, err)
	}
	if _, err := os.Stat(filepath.Join(dest, "README.md")); err != nil {
		t.Fatalf("the fetched tree is not at %q: %v", dest, err)
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("the directory the clone was given is still at %q", staging)
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
	// Not even the directory the clone was given, which is this call's own: a
	// scratch directory nothing will ever use is the one thing a failed clone may
	// clear.
	if entries, err := os.ReadDir(filepath.Dir(dest)); err != nil || len(entries) != 0 {
		t.Fatalf("a failed clone left %v behind (%v)", entries, err)
	}

	// Debris from a clone that was killed rather than one that failed: git cleans
	// up after the errors it reports, and this is the case it does not get to
	// report. It is refused, not cleared. What is at a destination is
	// indistinguishable from a checkout another process has just made — a name is
	// as far as this call can see — and the old cleanup deleted the destination
	// recursively, which is how a slow clone in one Kin process lost its finished
	// work to a failed clone in another one sharing the same checkout root. The
	// name stays refused until somebody clears it, which is the cheap half of that
	// trade.
	if err := os.MkdirAll(filepath.Join(dest, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := c.clone(context.Background(), dest, repo, "main"); err == nil {
		t.Fatal("clone succeeded into a directory that already had something in it")
	}
	if _, err := os.Stat(filepath.Join(dest, ".git")); err != nil {
		t.Fatalf("a clone removed a directory it did not create: %v", err)
	}
	if entries, err := os.ReadDir(filepath.Dir(dest)); err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(dest) {
		t.Fatalf("%s holds %v (%v), want only what was there before the call", filepath.Dir(dest), entries, err)
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

// githubOrigin builds the repository a console's shorthand names, and arranges
// for real git to reach it.
//
// `owner/repo` is the one form ResolveRepo accepts with no transport in it, and
// reaching github.com over the network is not something a test can do, so git is
// told — in its own configuration, read by git, applying to the command line —
// that https://github.com/ is a directory on this machine. Everything a test
// does with the result is then real git, over the transport git chose, which is
// what a test of a name's *meaning* needs: the two forms are one repository to
// git, and the test is about which one this machine will hand it.
//
// The clone records the URL it was asked for; what does not survive the rewrite
// is `git remote get-url`, which expands insteadOf rules when it prints — so a
// test that goes on to reuse one of these checkouts (rather than fetching it
// again) reads a path on this machine back, not the name.
//
// It returns the name a person would type.
func githubOrigin(t *testing.T, gitPath string) string {
	t.Helper()
	base := t.TempDir()
	origin := filepath.Join(base, "github.com", "acme", "repo.git")
	bareOriginAt(t, gitPath, origin)
	// A branch a remote can hold and this machine will not accept back: `-x` is
	// a name validateBranchName refuses because a branch becomes an argument to
	// git, and a remote that offers one is what the read path has to filter.
	runGit(t, gitPath, origin, "update-ref", "refs/heads/-x", "HEAD")

	config := filepath.Join(t.TempDir(), "gitconfig")
	rewrite := fmt.Sprintf("[url \"file://%s/github.com/\"]\n\tinsteadOf = https://github.com/\n", base)
	if err := os.WriteFile(config, []byte(rewrite), 0o600); err != nil {
		t.Fatal(err)
	}
	// Both, so that the rewrite is the only configuration the machine's git
	// reads: a test that inherits a developer's own insteadOf rules is a test
	// that can pass on their machine and nowhere else.
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	return "acme/repo"
}

// A name git itself would read as a path is not a repository this machine
// fetches, however much it looks like an scp remote.
//
// git decides that for itself — url_is_local_not_ssh(): no colon, or a slash
// before the first colon, and the string is a path — and a path is resolved
// against the directory git was started in. Here that directory is the checkout
// root (see RemoteBranches), which is a directory sessions work in, so
// `../x@y/z:w` listed and cloned a repository *above* the root while the
// canonical name it reduced to (`y/z/w`) was clean enough that the path gate
// underneath had nothing to refuse. It is the class the guard exists for: the
// plan's reason for leaving out `file://` is that a directory this machine
// already has is picked with fs.list, and this is that directory reached by a
// name that never says so.
func TestARepositoryNameGitWouldReadAsAPathIsRefused(t *testing.T) {
	gitPath := requireGit(t)
	base := t.TempDir()
	root := filepath.Join(base, "checkouts")
	// One level above the checkout root, and shaped so that only git's own rule
	// separates the name from a remote.
	bareOriginAt(t, gitPath, filepath.Join(base, "x@y", "z:w"))
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// The test's own directory is somewhere else entirely: which name git reads
	// as a path cannot depend on where the daemon was started, and a test that
	// only passes from inside the root would not show that. It is also where the
	// second copy of the repository goes — one level up from here, which is where
	// this name points from here — because the two entry points do not start git
	// in the same directory: the read path runs it in the checkout root, and the
	// clone runs it wherever this process is, and a path is resolved against
	// exactly whichever that is.
	cwd := t.TempDir()
	t.Chdir(cwd)
	bareOriginAt(t, gitPath, filepath.Join(cwd, "..", "x@y", "z:w"))

	c := NewCheckouts(root)
	ctx := context.Background()

	// The control. This really is a repository and this really is the name that
	// reaches it — asked the way this package asks, from the checkout root — so
	// the refusals below are this machine's gate and not an empty directory or a
	// spelling mistake.
	runGit(t, gitPath, c.Root(), "ls-remote", "--symref", "--", "../x@y/z:w")

	for _, tc := range []struct {
		name string
		call func() error
	}{
		{name: "listing its branches", call: func() error {
			_, err := c.RemoteBranches(ctx, "../x@y/z:w")
			return err
		}},
		{name: "fetching it", call: func() error {
			_, err := c.EnsureCheckout(ctx, "../x@y/z:w", "main")
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatal("a name git reads as a path was accepted")
			}
			// The reason, not just a refusal: this is the guard that has to be
			// doing it, since without it this name reaches a real repository.
			if !strings.Contains(err.Error(), "is a path on this machine") {
				t.Fatalf("refused for some other reason: %v", err)
			}
		})
	}
	// And nothing was written under the root on the way to being refused: this
	// name reduces to y/z/w, so a clone would have landed there.
	if entries, err := os.ReadDir(c.Root()); err != nil || len(entries) != 0 {
		t.Fatalf("the checkout root holds %v (%v), want nothing", entries, err)
	}
}

// A component of the destination that is a link is a directory somewhere else,
// and a clone is a write that follows it.
//
// The checkout root is one of this machine's roots and sessions run inside it,
// so `<root>/github.com/acme` as a symlink is a thing an agent turn or any local
// process can leave behind. Every prefix check still says the destination is
// under the root while MkdirAll and git write the whole checkout on the far side
// of the link: a plain local foothold becomes "the Hub can make this machine
// write outside its roots". The responder refuses to hand such a path *back*,
// which is after the write.
func TestAFetchDoesNotFollowALinkOutOfTheCheckoutRoot(t *testing.T) {
	gitPath := requireGit(t)
	name := githubOrigin(t, gitPath)
	base := t.TempDir()
	root := filepath.Join(base, "checkouts")
	outside := filepath.Join(base, "elsewhere")
	if err := os.MkdirAll(filepath.Join(root, "github.com"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "github.com", "acme")); err != nil {
		t.Fatal(err)
	}

	c := NewCheckouts(root)
	_, err := c.EnsureCheckout(context.Background(), name, "main")
	if err == nil {
		t.Fatal("a fetch wrote through a link out of the checkout root")
	}
	if !strings.Contains(err.Error(), "outside the checkout root") {
		t.Fatalf("refused for some other reason: %v", err)
	}
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 0 {
		t.Fatalf("the checkout was written outside the root: %v (%v)", entries, err)
	}
}

// The other half of the same hole: a link at the destination itself, pointing at
// a checkout of the same repository that lives outside the root.
//
// Nothing has to be created for this one. os.Stat follows the link, finds a
// directory, the reuse branch asks that directory what it is — and it is this
// repository — so the fetch and the branch switch go there, outside every root
// this machine declares, while the path handed back reads as one inside the root.
func TestAReuseDoesNotFollowALinkOutOfTheCheckoutRoot(t *testing.T) {
	gitPath := requireGit(t)
	name := githubOrigin(t, gitPath)
	base := t.TempDir()
	outsideRoot := filepath.Join(base, "outside-checkouts")
	root := filepath.Join(base, "checkouts")

	// A real checkout of this repository, made the way this package makes one,
	// somewhere else on this machine.
	outside := NewCheckouts(outsideRoot)
	if _, err := outside.EnsureCheckout(context.Background(), name, "main"); err != nil {
		t.Fatalf("the checkout outside the root: %v", err)
	}
	checkedOut := filepath.Join(outsideRoot, "github.com", "acme", "repo")
	link := filepath.Join(root, "github.com", "acme", "repo")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(checkedOut, link); err != nil {
		t.Fatal(err)
	}

	c := NewCheckouts(root)
	_, err := c.EnsureCheckout(context.Background(), name, "alpha")
	if err == nil {
		t.Fatal("a checkout outside the root was adopted through a link")
	}
	if !strings.Contains(err.Error(), "outside the checkout root") {
		t.Fatalf("refused for some other reason: %v", err)
	}
	// And the checkout on the far side was left as it was: the refusal is before
	// the fetch, not after the switch.
	head, err := os.ReadFile(filepath.Join(checkedOut, ".git", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(head), "refs/heads/main") {
		t.Fatalf("the checkout outside the root is at %q, want main", strings.TrimSpace(string(head)))
	}
}

// racingGit is this machine's git, with a chance to act at the moment another
// process would: between the check that the destination is free and the fetch
// that would fill it.
type racingGit struct {
	inner  gitRunner
	before func()
}

func (r racingGit) Run(ctx context.Context, dir string, env map[string]string, stdoutLimit int64, args ...string) ([]byte, error) {
	if len(args) > 0 && args[0] == "clone" {
		r.before()
	}
	return r.inner.Run(ctx, dir, env, stdoutLimit, args...)
}

// A checkout that appeared while this machine was fetching is somebody else's,
// and this call does not delete it.
//
// Two Kin processes can share one checkout root — the Hub and a Node on one
// machine is the default layout — and the per-destination lock only serialises
// within one of them. So the second one's clone can come back to a destination
// the first one has just filled, and the cleanup that follows a failed clone
// then deletes that finished checkout recursively: the first one's console is
// handed a path to a tree that is gone.
func TestAFailedCloneDoesNotRemoveACheckoutItDidNotMake(t *testing.T) {
	gitPath := requireGit(t)
	name := githubOrigin(t, gitPath)
	root := filepath.Join(t.TempDir(), "checkouts")
	dest := filepath.Join(root, "github.com", "acme", "repo")

	c := NewCheckouts(root)
	// The other process: the same root, its own locks, its own git, the same
	// question at the same time.
	other := NewCheckouts(root)
	c.git = racingGit{inner: c.git, before: func() {
		if _, err := other.EnsureCheckout(context.Background(), name, "main"); err != nil {
			t.Errorf("the other process could not fetch its own checkout: %v", err)
		}
	}}

	if _, err := c.EnsureCheckout(context.Background(), name, "main"); err == nil {
		t.Fatal("a clone adopted a checkout another process had just made")
	}
	// The other process's work is there, and it is a working checkout rather than
	// a directory this call gutted on its way out.
	if _, err := os.Stat(filepath.Join(dest, "README.md")); err != nil {
		t.Fatalf("a clone removed a checkout it did not make: %v", err)
	}
	runGit(t, gitPath, dest, "rev-parse", "--verify", "HEAD")
	// And nothing of this call's own is left beside it.
	entries, err := os.ReadDir(filepath.Dir(dest))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(dest) {
		t.Fatalf("%s holds %v, want only the checkout another process made", filepath.Dir(dest), entries)
	}
}

// A console is offered the branches it can ask for, and no others.
//
// A remote is another party: `-x` is a branch it can hold and `ls-remote`
// reports, and it is also a name validateBranchName refuses, because a branch
// becomes an argument to git. Offering it is offering a choice repo.prepare can
// never take, so the read path reads the same rule the write path does — and the
// names it keeps are names that work when they come back.
func TestRemoteBranchesOffersOnlyNamesPrepareAccepts(t *testing.T) {
	gitPath := requireGit(t)
	name := githubOrigin(t, gitPath)
	c := NewCheckouts(filepath.Join(t.TempDir(), "checkouts"))
	ctx := context.Background()

	got, err := c.RemoteBranches(ctx, name)
	if err != nil {
		t.Fatalf("RemoteBranches: %v", err)
	}
	// The remote holds alpha, main and -x.
	if strings.Join(got.Branches, ",") != "alpha,main" {
		t.Fatalf("branches = %q, want alpha,main", got.Branches)
	}
	if got.DefaultBranch != "main" {
		t.Fatalf("default = %q, want main", got.DefaultBranch)
	}
	// The property, rather than the list: every name offered is one the fetch
	// path accepts when it comes back. A fresh root each time, because the second
	// call in one root would be the reuse branch, and reuse asks git to read back
	// the URL it was fetched from — which git prints with the rewrite above
	// applied, so it is the harness that would be under test rather than the
	// branch names.
	for _, branch := range got.Branches {
		fresh := NewCheckouts(filepath.Join(t.TempDir(), "checkouts"))
		if _, err := fresh.EnsureCheckout(ctx, got.CloneURL, branch); err != nil {
			t.Fatalf("prepare refused the branch %q that was offered: %v", branch, err)
		}
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
	return bareOriginAt(t, gitPath, filepath.Join(t.TempDir(), "origin.git"))
}

// bareOriginAt is bareOrigin at a path the test chose, which is what a name that
// only pretends to be a remote has to point at.
func bareOriginAt(t *testing.T, gitPath, bare string) string {
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

	if err := os.MkdirAll(filepath.Dir(bare), 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, gitPath, "", "clone", "--bare", work, bare)
	return bare
}
