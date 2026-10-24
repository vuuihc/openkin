package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// A machine's checkout root is where it keeps the repositories it fetches for a
// console that cannot reach them itself.
//
// The console on a phone names a repository; every part of turning that name
// into a directory — which remote to reach, whose credentials to reach it with,
// and where the result lives — happens on the machine, because the machine is
// the only party that can answer any of it. That division is the reason this
// file exists rather than a handler in the Hub: a Hub that could name the
// destination could write anywhere under a root, and a root is permission to run
// an agent, not permission for the Hub to write.

// Repo is one repository: what it is called, and where git should be sent to
// fetch it.
type Repo struct {
	// Canonical is the identity two machines agree on — `host/owner/repo`, with
	// no transport and no credentials (see CanonicalRemote). It is also the path
	// the checkout is kept under, so it is the one string that decides both what
	// this is and where it goes.
	Canonical string
	// CloneURL is what git is given. It keeps the transport the person chose —
	// an ssh remote is reached with the key on this machine, not with a
	// credential helper — but never carries a secret: a token pasted into a URL
	// is stripped here, because this string ends up in git's error messages and
	// those travel back to the Hub and onto a phone (ADR 0022 D7).
	CloneURL string
}

// Branches is every branch one remote offers.
//
// It carries both names for one repository, and the difference matters to a
// caller that has to say something back: Canonical is the identity (and the
// checkout path), while CloneURL is the only one of the two that can be handed
// straight back to EnsureCheckout. Canonical cannot — it has no transport, so
// re-reading it is guessing, and `host:port/owner/repo` guesses wrong.
type Branches struct {
	Repo          string
	CloneURL      string
	DefaultBranch string
	Branches      []string
}

// Checkout is where a repository is on this machine.
type Checkout struct {
	// Path is inside the checkout root, and therefore inside this machine's
	// roots: it is meant to be handed straight back as a task's working
	// directory.
	Path string
	// Branch is what is checked out there now.
	Branch string
	// Cloned reports whether this call is what created it.
	Cloned bool
}

// Checkouts is one machine's checkout root, and the git that works in it.
type Checkouts struct {
	root string
	git  gitRunner

	mu sync.Mutex
	// locks serialises the destinations being created right now. A phone that
	// double-taps gets two questions, and two clones racing into one directory
	// is a directory that ends up belonging to neither.
	locks map[string]*sync.Mutex
}

// NewCheckouts returns the checkout root at root, which must be an absolute
// path this machine's operator named.
func NewCheckouts(root string) *Checkouts {
	return &Checkouts{root: filepath.Clean(root), git: execGit{Path: resolveGit()}}
}

// Root is where this machine keeps what it fetches.
func (c *Checkouts) Root() string { return c.root }

// RemoteBranches lists the branches one remote offers, without cloning it.
//
// It is a question about the remote and not about this machine's copy: a
// repository nobody has fetched yet still has branches, and being able to see
// them is what lets a console offer the second half of a choice before paying
// for the first.
func (c *Checkouts) RemoteBranches(ctx context.Context, repo string) (Branches, error) {
	resolved, err := ResolveRepo(repo)
	if err != nil {
		return Branches{}, err
	}
	if err := c.ready(); err != nil {
		return Branches{}, err
	}
	// One call, in the checkout root rather than wherever the daemon happens to
	// have been started: --symref answers the default branch alongside the refs,
	// where asking for heads and for HEAD separately would be two round trips to
	// the same remote for one question.
	out, err := c.git.Run(ctx, c.root, nil, PathListStdoutLimit, "ls-remote", "--symref", "--", resolved.CloneURL)
	if err != nil {
		return Branches{}, fmt.Errorf("ask %s for its branches: %w", resolved.Canonical, err)
	}
	branches, defaultBranch := parseLsRemote(string(out))
	if len(branches) == 0 {
		return Branches{}, fmt.Errorf("%s has no branches this machine can see", resolved.Canonical)
	}
	return Branches{Repo: resolved.Canonical, CloneURL: resolved.CloneURL, DefaultBranch: defaultBranch, Branches: branches}, nil
}

// EnsureCheckout makes one repository available under this machine's checkout
// root, and says where it is.
//
// It is idempotent: the second call for the same repository and branch fetches
// and finds what it expects, rather than cloning a second copy. What it will not
// do is adopt a directory that is not that repository — a checkout of something
// else at the same path is a collision to report, not a thing to overwrite.
func (c *Checkouts) EnsureCheckout(ctx context.Context, repo, branch string) (Checkout, error) {
	resolved, err := ResolveRepo(repo)
	if err != nil {
		return Checkout{}, err
	}
	branch = strings.TrimSpace(branch)
	if branch != "" {
		// The same rule the rest of this package holds a branch to, for the same
		// reason: a branch is an argument to git, and `-f` is a branch name only
		// to somebody who wants `git checkout` to discard work.
		if err := validateBranchName(branch); err != nil {
			return Checkout{}, fmt.Errorf("branch %q: %w", branch, err)
		}
	}
	if err := c.ready(); err != nil {
		return Checkout{}, err
	}
	dest, err := c.pathFor(resolved.Canonical)
	if err != nil {
		return Checkout{}, err
	}

	unlock := c.lock(dest)
	defer unlock()

	info, statErr := os.Stat(dest)
	switch {
	case statErr == nil && !info.IsDir():
		return Checkout{}, fmt.Errorf("%s is in the way of %s", dest, resolved.Canonical)
	case statErr == nil:
		return c.reuse(ctx, dest, resolved, branch)
	case errors.Is(statErr, os.ErrNotExist):
		return c.clone(ctx, dest, resolved, branch)
	default:
		return Checkout{}, fmt.Errorf("look at %s: %w", dest, statErr)
	}
}

// reuse brings an existing checkout to the requested branch.
func (c *Checkouts) reuse(ctx context.Context, dest string, resolved Repo, branch string) (Checkout, error) {
	// It has to be a checkout of *this* repository. The destination is derived
	// from the canonical name, so a directory here that belongs to something else
	// means somebody put it there, and their work is not this call's to replace.
	if _, err := c.git.Run(ctx, dest, nil, ControlStdoutLimit, "rev-parse", "--git-dir"); err != nil {
		return Checkout{}, fmt.Errorf("%s already exists and is not a git checkout, so it is not %s",
			dest, resolved.Canonical)
	}
	out, err := c.git.Run(ctx, dest, nil, ControlStdoutLimit, "remote", "get-url", "origin")
	if err != nil {
		return Checkout{}, fmt.Errorf("%s already exists and has no origin, so it is not %s",
			dest, resolved.Canonical)
	}
	origin, err := CanonicalRemote(string(out))
	if err != nil || origin != resolved.Canonical {
		return Checkout{}, fmt.Errorf("%s already exists and belongs to %s, not %s",
			dest, strings.TrimSpace(string(out)), resolved.Canonical)
	}
	if _, err := c.git.Run(ctx, dest, nil, ControlStdoutLimit, "fetch", "--prune", "--", "origin"); err != nil {
		return Checkout{}, fmt.Errorf("fetch %s: %w", resolved.Canonical, err)
	}

	current, err := c.currentBranch(ctx, dest)
	if err != nil {
		return Checkout{}, err
	}
	// Already there: the idempotent half. Nothing is switched, so a session
	// running in this directory is not disturbed by a second phone asking for
	// the branch it is already on.
	if branch == "" || branch == current {
		return Checkout{Path: dest, Branch: current}, nil
	}
	// Switching is the one destructive thing this call can do, and the work in a
	// checkout belongs to whoever is running there — a session started from the
	// first phone, most likely. Uncommitted work is refused rather than carried
	// across, which is the same rule Manager.CheckoutBranch holds, for the same
	// reason.
	if dirty, err := c.isDirty(ctx, dest); err != nil {
		return Checkout{}, err
	} else if dirty {
		return Checkout{}, fmt.Errorf("%s has uncommitted work, so this machine will not switch it from %s to %s",
			dest, current, branch)
	}
	// No `--` here, unlike every other git call in this file: `checkout` reads
	// everything after it as a path, so `checkout -- alpha` restores a file
	// called alpha instead of switching to the branch. The branch therefore
	// cannot be separated from the options — it has to already be a name, which
	// is what validateBranchName decided above and why it refuses a leading dash.
	if _, err := c.git.Run(ctx, dest, nil, ControlStdoutLimit, "checkout", branch); err != nil {
		return Checkout{}, fmt.Errorf("switch %s to %s: %w", dest, branch, err)
	}
	switched, err := c.currentBranch(ctx, dest)
	if err != nil {
		return Checkout{}, err
	}
	return Checkout{Path: dest, Branch: switched}, nil
}

// clone fetches a repository this machine does not have yet.
func (c *Checkouts) clone(ctx context.Context, dest string, resolved Repo, branch string) (Checkout, error) {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return Checkout{}, fmt.Errorf("make room for %s: %w", resolved.Canonical, err)
	}
	args := []string{"clone"}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	args = append(args, "--", resolved.CloneURL, dest)
	if _, err := c.git.Run(ctx, "", nil, ControlStdoutLimit, args...); err != nil {
		// Git cleans up after the failures it reports, and this is for the ones
		// it does not get to report. Merging into what is left is not an option
		// — git refuses a destination that is not empty — so the alternative is
		// a repository name that can never be prepared again. The path is inside
		// the checkout root by construction (see pathFor), and this call is only
		// reached when the destination was not there.
		_ = os.RemoveAll(dest)
		return Checkout{}, fmt.Errorf("clone %s: %w", resolved.Canonical, err)
	}
	checkedOut, err := c.currentBranch(ctx, dest)
	if err != nil {
		return Checkout{}, err
	}
	return Checkout{Path: dest, Branch: checkedOut, Cloned: true}, nil
}

// currentBranch is the branch checked out at a path, or empty on a detached
// HEAD — which a clone of a specific commit is, and which is a truthful answer.
func (c *Checkouts) currentBranch(ctx context.Context, dest string) (string, error) {
	out, err := c.git.Run(ctx, dest, nil, ControlStdoutLimit, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", fmt.Errorf("read the branch at %s: %w", dest, err)
	}
	branch := strings.TrimSpace(string(out))
	if branch == "HEAD" {
		return "", nil
	}
	return branch, nil
}

// isDirty reports whether a checkout holds work that switching would disturb.
func (c *Checkouts) isDirty(ctx context.Context, dest string) (bool, error) {
	out, err := c.git.Run(ctx, dest, nil, PathListStdoutLimit, "status", "--porcelain")
	if err != nil {
		return false, fmt.Errorf("read the state of %s: %w", dest, err)
	}
	return len(strings.TrimSpace(string(out))) > 0, nil
}

// pathFor is where one repository is kept, derived from its canonical name and
// nothing else.
//
// Nothing else is the point: the Hub chooses the repository, so the Hub chooses
// this path, and a name that could climb out of the checkout root would turn
// "clone this repository" into "write anywhere the daemon can". Every component
// is therefore a plain name — a canonical remote is `host/owner/repo`, and
// anything that is not that shape is refused here rather than joined.
func (c *Checkouts) pathFor(canonical string) (string, error) {
	parts := strings.Split(canonical, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("%q is not a repository name this machine will keep", canonical)
		}
	}
	dest := filepath.Join(c.root, filepath.Join(parts...))
	// Belt to the braces above: the joined path must still be under the root,
	// and this is the check that stays true if the shape of a canonical name
	// ever changes.
	if dest != c.root && !strings.HasPrefix(dest, c.root+string(filepath.Separator)) {
		return "", fmt.Errorf("%q would be kept outside the checkout root", canonical)
	}
	return dest, nil
}

// ready makes sure this machine has somewhere to put a checkout, and says so in
// its own words when it does not.
func (c *Checkouts) ready() error {
	if strings.TrimSpace(c.root) == "" || c.root == "." {
		return errors.New("this machine has no checkout directory")
	}
	if err := os.MkdirAll(c.root, 0o755); err != nil {
		return fmt.Errorf("this machine cannot use its checkout directory: %w", err)
	}
	return nil
}

// lock serialises work on one destination.
func (c *Checkouts) lock(dest string) func() {
	c.mu.Lock()
	if c.locks == nil {
		c.locks = make(map[string]*sync.Mutex)
	}
	held, ok := c.locks[dest]
	if !ok {
		held = &sync.Mutex{}
		c.locks[dest] = held
	}
	c.mu.Unlock()

	held.Lock()
	return held.Unlock
}

// ResolveRepo reads what a person typed into the two strings the rest of this
// file needs: the identity a checkout is kept under, and the URL git is given.
//
// Two forms are accepted, and both are named in the refusal so that somebody who
// typed neither is told what to type instead. `owner/repo` is shorthand for
// GitHub, which is where a person naming a repository out loud almost always
// means; everything else has to be a real git remote, which is what
// CanonicalRemote already knows how to read — and a remote of a transport this
// machine will actually fetch from, which is what allowedRemote decides.
func ResolveRepo(raw string) (Repo, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Repo{}, errors.New("no repository was named")
	}
	if isGitHubShorthand(raw) {
		cloneURL := "https://github.com/" + strings.TrimSuffix(raw, ".git") + ".git"
		canonical, err := CanonicalRemote(cloneURL)
		if err != nil {
			return Repo{}, err
		}
		return Repo{Canonical: canonical, CloneURL: cloneURL}, nil
	}
	if err := allowedRemote(raw); err != nil {
		return Repo{}, err
	}
	canonical, err := CanonicalRemote(raw)
	if err != nil {
		return Repo{}, fmt.Errorf("%w — name it as owner/repo, or give the full remote URL", err)
	}
	return Repo{Canonical: canonical, CloneURL: credentialFreeCloneURL(raw)}, nil
}

// allowedRemote refuses a name that is a transport rather than a repository.
//
// A git remote is not only a URL: the syntax admits a transport prefix, and
// `ext::sh -c …` is one — a well-formed remote that runs a command. It would be
// reached with the machine's own privileges, chosen by a Hub that does not own
// the machine, which is the whole reason this file exists: the Hub names a
// repository, and what that name *does* on this machine is decided here.
//
// So the transports are enumerated instead of the attacks, because the attacks
// are whatever the local git was built to support and that set is not knowable
// from here. `file://` is left out with them: a directory already on this
// machine is one a console can reach with fs.list and use as a working
// directory, so "prepare" keeps meaning fetch-from-elsewhere.
func allowedRemote(raw string) error {
	if scheme, rest, found := strings.Cut(raw, "://"); found {
		switch strings.ToLower(scheme) {
		case "https", "http", "ssh", "git":
		default:
			return fmt.Errorf("a repository at %q would be fetched over %q, which this machine does not do — name it as owner/repo, or give an https, ssh or git remote",
				raw, scheme)
		}
		if strings.TrimSpace(rest) == "" {
			return fmt.Errorf("%q names a transport and no repository", raw)
		}
		return nil
	}
	// scp-like, which git writes as `user@host:path`. Both halves are required:
	// without an `@` the leading word is not a user but a transport, and a path
	// that opens with a second colon is the same thing spelled `ext::`.
	at := strings.LastIndex(raw, "@")
	colon := strings.Index(raw, ":")
	if at < 0 || colon < 0 || colon < at || colon+1 >= len(raw) || raw[colon+1] == ':' {
		return fmt.Errorf("%q is not a repository this machine can fetch — name it as owner/repo, or give an https, ssh or git remote",
			raw)
	}
	return nil
}

// isGitHubShorthand reports whether a name is `owner/repo` and nothing more.
//
// One slash and no colon: a colon is what makes something a remote
// (`git@host:owner/repo`), and a second slash makes it a path or a host-first
// URL, neither of which is the shorthand. A repository belonging to a group with
// subgroups — `group/sub/repo` — is therefore not shorthand, and is refused with
// the two forms that are accepted rather than guessed at.
func isGitHubShorthand(raw string) bool {
	if strings.Contains(raw, ":") || strings.Contains(raw, "://") {
		return false
	}
	owner, repo, found := strings.Cut(raw, "/")
	return found && owner != "" && repo != "" && !strings.Contains(repo, "/")
}

// credentialFreeCloneURL keeps the transport a person chose, and drops only the
// part of it that is a credential.
//
// A token pasted into a URL would otherwise be handed to git, printed in git's
// own error messages, and carried back to the Hub as the machine's answer to a
// question — so it is removed here rather than trusted not to leak. What is not
// removed is everything else: the path is what the remote's server expects, and
// a `.git` suffix is part of it (a canonical name strips one; an ssh server does
// not accept the shortened form), and `git@` in an ssh remote is a username the
// server needs, not a secret.
//
// Over http the username *is* the credential — there is no other thing a
// username could be there, and a GitHub token goes in that position — so the
// whole userinfo comes off and the machine's own credential helper is what
// authenticates. That is the arrangement the checkout root is for: the machine
// fetches with the credentials it already has.
func credentialFreeCloneURL(raw string) string {
	scheme, rest, found := strings.Cut(raw, "://")
	if !found || rest == "" || scheme == "" {
		return raw
	}
	authority, path, hasPath := strings.Cut(rest, "/")
	if userinfo, host, ok := strings.Cut(authority, "@"); ok {
		keep := userinfo
		switch strings.ToLower(scheme) {
		case "http", "https":
			keep = ""
		default:
			// Not a secret either way, except for a password after the colon.
			if name, _, hasPassword := strings.Cut(userinfo, ":"); hasPassword {
				keep = name
			}
		}
		if keep == "" {
			authority = host
		} else {
			authority = keep + "@" + host
		}
	}
	if !hasPath {
		return scheme + "://" + authority
	}
	return scheme + "://" + authority + "/" + path
}

// parseLsRemote reads `git ls-remote --symref` output.
//
// Two shapes of line matter and the rest are skipped: the symref line names the
// remote's default branch (`ref: refs/heads/main\tHEAD`), and every line whose
// ref starts with `refs/heads/` is a branch. Tags and the bare HEAD line are the
// rest, and a tag is not somewhere a session can start.
func parseLsRemote(out string) ([]string, string) {
	var branches []string
	var defaultBranch string
	for _, line := range strings.Split(out, "\n") {
		value, ref, found := strings.Cut(strings.TrimRight(line, "\r"), "\t")
		if !found {
			continue
		}
		if rest, ok := strings.CutPrefix(value, "ref: refs/heads/"); ok && ref == "HEAD" {
			defaultBranch = rest
			continue
		}
		if name, ok := strings.CutPrefix(ref, "refs/heads/"); ok {
			branches = append(branches, name)
		}
	}
	sort.Strings(branches)
	return branches, defaultBranch
}
