package node

import (
	"context"
	"strings"

	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/workspace"
)

// The two questions a machine answers about putting work on a forge.
//
// They are the only writes in the table that reach outside this machine, and
// they are separate questions because they are separate decisions: starting a
// branch is a person saying "not on this branch", and publishing is a person
// saying "this branch, now". Folding them together would make the second one
// happen to anyone who only meant the first.
//
// Both check the boundary first (own), and neither decides anything the person
// did not: a publish refuses on the default branch and on uncommitted work, and
// says which, rather than choosing for them.

// BranchCreateFunc starts a branch in one of this machine's checkouts.
// workspace.Manager.CreateBranch is the one a real machine uses.
type BranchCreateFunc func(ctx context.Context, git *workspace.Manager, dir, branch string) error

// PublishFunc publishes one of this machine's checkouts. github.PublishHere is
// the one a real machine uses; see Responder.Publish.
type PublishFunc func(ctx context.Context, git *workspace.Manager, req github.PublishRequest) (github.PublishOutcome, error)

// branchCreate starts a branch on this machine.
//
// It goes through the same manager a switch does, so the two share every rule
// about what a branch name may be and what a checkout may be in. What differs
// is the dirty tree, and that difference is deliberate — see CreateBranch.
func (r *Responder) branchCreate(ctx context.Context, asked worker.GitBranchCreateParams) (worker.GitBranchCreateResult, error) {
	path, err := r.own(asked.Path)
	if err != nil {
		return worker.GitBranchCreateResult{}, err
	}
	git, err := r.workspaceFor("what branch a directory is on")
	if err != nil {
		return worker.GitBranchCreateResult{}, err
	}
	branch := strings.TrimSpace(asked.Branch)
	create := r.CreateBranch
	if create == nil {
		create = func(ctx context.Context, git *workspace.Manager, dir, branch string) error {
			return git.CreateBranch(ctx, dir, branch)
		}
	}
	if err := create(ctx, git, path, branch); err != nil {
		return worker.GitBranchCreateResult{}, err
	}
	// Read back rather than echo, for the reason a switch does it: the branch a
	// directory is on is a fact about the directory, and the person who tapped
	// the button is about to see it named.
	status, err := git.ListBranches(ctx, path)
	if err != nil {
		return worker.GitBranchCreateResult{Cwd: path, Current: branch}, nil
	}
	current := status.Current
	if current == "" {
		current = branch
	}
	return worker.GitBranchCreateResult{Cwd: status.Cwd, Current: current}, nil
}

// publishPR pushes one of this machine's branches and opens its pull request.
//
// A refusal to publish — the default branch, uncommitted work, no origin — comes
// back as an answer with a code, not as a failed question, because the console
// has to be able to act on one of them and because the rest are sentences a
// person reads rather than errors a program retries. A failure that is nobody's
// decision — git refusing the push, gh dying — is a refusal, and it arrives in
// the words of the program that said no.
func (r *Responder) publishPR(ctx context.Context, asked worker.PRPublishParams) (worker.PRPublishResult, error) {
	path, err := r.own(asked.Path)
	if err != nil {
		return worker.PRPublishResult{}, err
	}
	if _, err := r.workspaceFor("which branch a checkout is on"); err != nil {
		return worker.PRPublishResult{}, err
	}
	publish := r.Publish
	if publish == nil {
		publish = github.PublishHere
	}
	out, err := publish(ctx, r.Workspace, github.PublishRequest{
		Dir:   path,
		Title: strings.TrimSpace(asked.Title),
		Body:  asked.Body,
	})
	if err != nil {
		return worker.PRPublishResult{}, err
	}
	result := worker.PRPublishResult{
		Path:    out.Dir,
		Branch:  out.Branch,
		Number:  out.Number,
		URL:     out.URL,
		HeadOID: out.HeadOID,
		Blocked: out.Blocked,
		Reason:  out.Reason,
		Pushed:  out.Pushed,
	}
	if out.Repo.Owner != "" {
		result.Repo = out.Repo.Canonical()
	}
	if result.Path == "" {
		result.Path = path
	}
	if result.Blocked != "" && strings.TrimSpace(result.Reason) == "" {
		// An answer that says "no" and nothing else is one a console cannot
		// render. Every path in this package sets a reason, but the answer is a
		// wire value, and the Hub on the other end is somebody else's.
		result.Reason = "this machine did not say why it would not publish this checkout"
	}
	return result, nil
}
