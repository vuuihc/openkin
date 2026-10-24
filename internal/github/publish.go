package github

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/vuuihc/openkin/internal/workspace"
)

// The reasons a publish stops before it changes anything.
//
// They are a vocabulary rather than a sentence because one of them is a way out
// rather than an end: a console can see PublishBlockedDefault and offer to start
// a branch, which is a thing it cannot do with prose. The rest are read by a
// person and could be any words at all.
const (
	// PublishBlockedNotACheckout: the directory is not a repository.
	PublishBlockedNotACheckout = "not_a_checkout"
	// PublishBlockedNoRemote: no origin remote naming a repository on GitHub.
	PublishBlockedNoRemote = "no_github_remote"
	// PublishBlockedDetached: a HEAD that is not on a branch.
	PublishBlockedDetached = "detached_head"
	// PublishBlockedDefault: the branch is the one origin's HEAD names. Pushing
	// it is how a repository's main branch gets pushed by a button.
	PublishBlockedDefault = "default_branch"
	// PublishBlockedDirty: uncommitted work, which a push would leave behind.
	PublishBlockedDirty = "uncommitted_changes"
	// PublishBlockedNoGH: no GitHub CLI to open the pull request with.
	PublishBlockedNoGH = "no_gh"
)

// PublishRequest is one person's decision to put this work on the remote.
//
// Title and Body are theirs, drafted from the session by whoever asked. This
// side checks their size, not their content: what a pull request should say is
// not a thing a guard can have an opinion about.
type PublishRequest struct {
	Dir   string
	Title string
	Body  string
}

// PublishOutcome is what became of it.
//
// The order of the fields is the order it happens in: which checkout and branch
// this is about, then whether the branch is on the remote, then which pull
// request exists. Blocked and Reason are the other ending — nothing was pushed.
type PublishOutcome struct {
	// Dir is the checkout that was published, as the machine resolved it.
	Dir string
	// Repo is empty when the checkout has no origin this package can read.
	Repo Repo
	// Branch is the branch the checkout was on, empty for a detached HEAD.
	Branch string
	// HeadOID is the commit that was pushed.
	HeadOID string
	// Pushed reports that the branch is on the remote now. It can be true with
	// no pull request: the push happened and gh did not finish, and Reason says
	// what gh said about it. That is a state a person has to be told about
	// accurately — the work is up, the pull request is not.
	Pushed bool
	// Number and URL are the pull request, zero and empty when there is none.
	Number int
	URL    string
	// Blocked names why nothing was pushed at all, in the vocabulary above.
	// Reason is that in this machine's words.
	Blocked string
	Reason  string
}

// PublishHere publishes the work in one of this machine's checkouts: it pushes
// the branch, and opens the pull request for it.
//
// It is the only thing in this package that writes anywhere, and the only thing
// in Kin that writes to a forge. The credential stays where it already is — this
// uses the machine's own git and gh — so what a Hub on another machine learns is
// which branch and which pull request, never a token.
//
// It refuses rather than guesses, and it refuses *before* the first thing that
// cannot be undone. Everything above the push is a read: which repository, which
// branch, whether the tree is clean, whether there is a gh to finish with. Only
// a checkout that passed all of them is pushed, because a publish that
// half-happened is worse than one that did not — the remote holds something
// nobody agreed to, and the person is looking at a phone.
func PublishHere(ctx context.Context, git *workspace.Manager, req PublishRequest) (PublishOutcome, error) {
	return publishWith(ctx, git, nil, req)
}

// ghRunner is the one method a publish needs from the GitHub CLI, so that a test
// can answer in its place without a gh on the machine.
type ghRunner interface {
	Run(ctx context.Context, args ...string) ([]byte, error)
}

// publishWith is PublishHere with the gh client supplied. A nil client means
// "use this machine's own", which is the production path.
func publishWith(ctx context.Context, git *workspace.Manager, gh ghRunner, req PublishRequest) (PublishOutcome, error) {
	out := PublishOutcome{Dir: req.Dir}
	if git == nil {
		return out, errors.New("this machine has no git, so it cannot publish a branch")
	}
	facts, err := git.InspectGit(ctx, req.Dir)
	if err != nil {
		return out, err
	}
	out.Dir = facts.Path
	if !facts.IsGit {
		out.Blocked = PublishBlockedNotACheckout
		// Read and not interpreted: a directory that is not a checkout and a
		// machine with no git are the same answer to the person ("there is no
		// branch here to publish"), and the reason says which one it was.
		out.Reason = reasonOr(facts.Reason,
			"this directory is not a git checkout, so there is no branch to publish")
		return out, nil
	}
	// Which repository, then which branch, then whether the tree is clean: each
	// answer makes the next question the right one to ask.
	repo, ok := ParseCanonical(facts.Repo)
	if !ok {
		out.Blocked = PublishBlockedNoRemote
		out.Reason = fmt.Sprintf(
			"this checkout has no origin remote naming a repository on %s, so there is nowhere to push it", host)
		return out, nil
	}
	out.Repo = repo
	out.Branch = facts.Branch
	out.HeadOID = facts.HeadOID
	if facts.Detached || strings.TrimSpace(facts.Branch) == "" {
		out.Blocked = PublishBlockedDetached
		out.Reason = "this checkout is not on a branch, so there is no branch to publish"
		return out, nil
	}
	if name := branchThisMachineWillNotPush(facts); name != "" {
		out.Blocked = PublishBlockedDefault
		out.Reason = fmt.Sprintf(
			"this checkout is on %s, which is this repository's default branch, and Kin does not push that one on its own",
			name)
		return out, nil
	}
	changes, err := git.ListLiveChanges(ctx, workspace.SharedMetadata(facts.Path))
	if err != nil {
		return out, fmt.Errorf("read whether %s has uncommitted work: %w", facts.Path, err)
	}
	if len(changes) > 0 {
		out.Blocked = PublishBlockedDirty
		out.Reason = uncommittedSentence(changes)
		return out, nil
	}
	if gh == nil {
		client, err := ResolveGH()
		if err != nil {
			out.Blocked = PublishBlockedNoGH
			out.Reason = fmt.Sprintf("this machine has no GitHub CLI to open a pull request with: %v", err)
			return out, nil
		}
		gh = GHClient{Bin: client}
	}

	// Past this line nothing is a read. The push is not forced and never will
	// be: a branch the remote has moved past is git's refusal to give, and it
	// arrives here as an error with git's own words.
	if err := git.PushBranch(ctx, facts.Path, facts.Branch); err != nil {
		return out, err
	}
	out.Pushed = true

	url, err := createPullRequest(ctx, gh, repo, facts.Branch, req)
	if err != nil {
		// The branch is up and the pull request is not. Whoever reads this needs
		// both halves: gh's words are relayed as they are, because a pull request
		// that already exists arrives exactly this way and a person who did not
		// expect that should read it from GitHub rather than from a summary here.
		out.Reason = err.Error()
		return out, nil
	}
	out.URL = url
	out.Number = pullNumber(url)
	if out.Number == 0 {
		out.Reason = fmt.Sprintf("gh opened a pull request at %s without saying which number it is", url)
	}
	return out, nil
}

// branchThisMachineWillNotPush is the branch a publish refuses to push: the one
// origin's HEAD names.
//
// A checkout that recorded no origin/HEAD — one whose remote was added by hand,
// which is the ordinary way a local repository gets one — is not evidence that
// the repository has no default branch, so `main` and `master` are treated as
// though they were it. That refuses a push that might have been wanted, which is
// the direction this has to err in: pushing a repository's main branch by
// accident is the one outcome here that asking again cannot undo.
func branchThisMachineWillNotPush(facts workspace.GitFacts) string {
	if facts.DefaultBranch != "" {
		if facts.Branch == facts.DefaultBranch {
			return facts.DefaultBranch
		}
		return ""
	}
	for _, name := range []string{"main", "master"} {
		if facts.Branch == name {
			return name
		}
	}
	return ""
}

// uncommittedSentence says what a push would leave behind, by name.
//
// The names matter more than the count: "3 files" sends a person looking, and
// the console's changes tab is already showing them the same list. The cap is
// there because this sentence travels to a phone, and a session that touched
// four hundred files is answered with the first of them and the size of the
// rest.
func uncommittedSentence(changes []workspace.Change) string {
	const most = 5
	names := make([]string, 0, most)
	for _, c := range changes {
		if len(names) == most {
			break
		}
		name := c.Path
		if name == "" {
			name = c.OldPath
		}
		names = append(names, name)
	}
	list := strings.Join(names, ", ")
	if extra := len(changes) - len(names); extra > 0 {
		list = fmt.Sprintf("%s, and %d more", list, extra)
	}
	return fmt.Sprintf(
		"this checkout has uncommitted work (%s), so a push would publish a branch without it: commit it first, then publish",
		list)
}

// prURLRe finds the pull request gh printed. gh has no machine-readable output
// for `pr create`, so its one line of stdout is the answer.
var prURLRe = regexp.MustCompile(`https?://[^\s]*/pull/(\d+)`)

func createPullRequest(ctx context.Context, gh ghRunner, repo Repo, branch string, req PublishRequest) (string, error) {
	// --repo and --head rather than the current directory: gh is run without a
	// working directory of its own, and a publish that guessed which repository
	// it was in would be a publish that could open the pull request somewhere
	// else. The base branch is left to gh, which reads the repository's own.
	out, err := gh.Run(ctx, "pr", "create",
		"--repo", repo.String(),
		"--head", branch,
		"--title", req.Title,
		"--body", req.Body,
	)
	if err != nil {
		return "", err
	}
	if url := prURLRe.FindString(string(out)); url != "" {
		return url, nil
	}
	said := firstLine(out)
	if said == "" {
		said = "(nothing)"
	}
	return "", fmt.Errorf("gh created a pull request but did not say where: %s", said)
}

func pullNumber(url string) int {
	m := prURLRe.FindStringSubmatch(url)
	if m == nil {
		return 0
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0
	}
	return n
}

// reasonOr is the machine's own sentence, or a plain one when it gave none.
func reasonOr(reason, fallback string) string {
	if strings.TrimSpace(reason) == "" {
		return fallback
	}
	return reason
}
