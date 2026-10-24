package workspace

import (
	"context"
	"fmt"
	"strings"
)

// GitFacts is what one machine can say about the git a directory is in.
//
// It exists because of a division of labour: once a session runs on another
// machine, its workspace is a checkout there, and the Hub holding a checkout of
// the same repository at the same address is not the same thing. Which
// repository and which branch a session's work is on is a fact about that
// filesystem, and only that machine can read it.
type GitFacts struct {
	// Path is the directory that was read, resolved absolute.
	Path string
	// IsGit is false for a directory that is not a checkout. Most directories are
	// not, and that is an answer rather than a failure — it is the answer to
	// "is this a checkout at all".
	IsGit bool
	// Repo is the canonical origin remote (see CanonicalRemote): host/owner/name,
	// no transport, no credentials. Empty for a checkout with no origin.
	Repo string
	// Branch is what is checked out, empty when detached or unknown.
	Branch string
	// Detached reports a HEAD that is not on a branch.
	Detached bool
	// Dirty reports uncommitted work, tracked or untracked.
	Dirty bool
	// DefaultBranch is the branch origin's HEAD names, as this checkout recorded
	// it. Empty when it cannot be told offline — see defaultBranch.
	DefaultBranch string
	// Upstream is the tracking branch of Branch (`origin/main`), empty when the
	// branch tracks nothing.
	Upstream string
	// HeadOID is the commit HEAD points at.
	HeadOID string
	// Reason says why the answer is what it is, in this machine's words. It is
	// set only when git itself could not be read — no binary, not a checkout —
	// and not for the ordinary gaps above, which the fields already state.
	Reason string
}

// InspectGit reports the git one of this machine's directories is in.
//
// Every read is local and offline: git answers from what the checkout already
// recorded, and nothing here reaches a remote, so asking a phone's question
// costs the machine a few milliseconds of its own disk rather than a network
// round trip that could hang behind a credential prompt.
//
// The remote is reported canonicalized for the same reason anchors are (ADR 0022
// D7): this string travels to the Hub's database and from there to a phone, and
// a token pasted into a remote URL must not travel with it.
func (m *Manager) InspectGit(ctx context.Context, cwd string) (GitFacts, error) {
	if m == nil {
		return GitFacts{}, fmt.Errorf("workspace manager is nil")
	}
	abs, err := resolveAbsDir(cwd)
	if err != nil {
		return GitFacts{}, err
	}
	facts := GitFacts{Path: abs}
	if m.gitPath == "" || m.git == nil {
		facts.Reason = "git binary not found"
		return facts, nil
	}
	if _, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "rev-parse", "--git-dir"); err != nil {
		facts.Reason = "not a git repository"
		return facts, nil
	}
	facts.IsGit = true

	// Same read ListBranches makes, and the same meaning: an empty symbolic-ref
	// is a detached HEAD, which is a state and not a missing branch.
	if symOut, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
		facts.Branch = strings.TrimSpace(string(symOut))
	} else {
		facts.Detached = true
	}
	if headOut, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "rev-parse", "HEAD"); err == nil {
		facts.HeadOID = strings.TrimSpace(string(headOut))
	}
	// Untracked files count as dirty: "may I push this workspace as it stands" is
	// the question this feeds, and a file the session created but never added is
	// work that would be left behind.
	if statusOut, err := m.git.Run(ctx, abs, nil, PathListStdoutLimit,
		"status", "--porcelain=v1", "-z", "--untracked-files=normal"); err == nil {
		facts.Dirty = len(statusOut) > 0
	}
	if upOut, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit,
		"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); err == nil {
		facts.Upstream = strings.TrimSpace(string(upOut))
	}
	if remoteOut, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "remote", "get-url", "origin"); err == nil {
		// A remote this package cannot parse is not an error here: an anchor
		// cannot be derived from it either, and the answer to "which repository
		// is this" is then honestly empty rather than a guess.
		if canonical, cerr := CanonicalRemote(string(remoteOut)); cerr == nil {
			facts.Repo = canonical
		}
	}
	facts.DefaultBranch = m.defaultBranch(ctx, abs)
	return facts, nil
}

// defaultBranch reads the branch origin's HEAD names.
//
// A clone records it once, as the symbolic ref refs/remotes/origin/HEAD, so this
// costs nothing and reaches no network — which is the whole reason to read it
// that way. A checkout that never fetched, or one whose remote was added by
// hand, has no such ref, and then the answer is empty: `main` guessed from the
// local branch list is a guess, and the caller that needs a default branch
// (publish, which refuses to push one) has to decide what an unknown one means
// rather than be handed a plausible wrong answer.
func (m *Manager) defaultBranch(ctx context.Context, dir string) string {
	out, err := m.git.Run(ctx, dir, nil, ControlStdoutLimit,
		"symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
	if err != nil {
		return ""
	}
	// `origin/main` — the remote's name is this package's own convention
	// everywhere else (originRemote, CanonicalRemote), so the same one is
	// stripped here rather than whichever name happens to prefix it.
	name := strings.TrimSpace(string(out))
	name = strings.TrimPrefix(name, "origin/")
	if name == "" || name == "HEAD" {
		return ""
	}
	return name
}
