package node

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// The question about a session's pull request.
//
// A session that runs here keeps its checkout here, and the pull request for its
// branch is read with this machine's credentials. The Hub asking instead would
// read with its own: a checkout of the same repository on the Hub's disk is not
// this one, and a Hub with no credentials for a private repository would answer
// "no pull request" for a branch that has one — the answer is about a
// repository, but which machine asks decides what it can see.
//
// Everything short of the read itself is a local answer: which repository and
// branch this checkout is on comes from git on this machine, and it is what the
// answer is about. The branch is read rather than taken from the question, so a
// checkout that has since been switched is answered about the branch it is on
// now — the alternative is a panel describing a branch nobody is working on.
func (r *Responder) observePR(ctx context.Context, asked worker.PRObserveParams) (worker.PRObserveResult, error) {
	path, err := r.own(asked.Path)
	if err != nil {
		return worker.PRObserveResult{}, err
	}
	// No checkout, no branch, no origin: each is a reason rather than a refusal.
	// A refusal would reach the Hub as a failed question with no answer to show,
	// and what the person needs to read is which of the three it was.
	git, err := r.workspaceFor("which branch a checkout is on")
	if err != nil {
		return worker.PRObserveResult{Path: path, Reason: err.Error()}, nil
	}
	facts, err := git.InspectGit(ctx, path)
	if err != nil {
		return worker.PRObserveResult{}, err
	}
	switch {
	case !facts.IsGit:
		return worker.PRObserveResult{
			Path:   path,
			Reason: "this directory is not a git checkout, so it has no branch to look up",
		}, nil
	case facts.Repo == "":
		return worker.PRObserveResult{
			Path:   path,
			Branch: facts.Branch,
			Reason: "this checkout has no origin remote naming a repository on GitHub",
		}, nil
	case facts.Branch == "":
		return worker.PRObserveResult{
			Path:   path,
			Repo:   facts.Repo,
			Reason: "this checkout is not on a branch, so there is no branch to look up",
		}, nil
	}

	repo, ok := github.ParseCanonical(facts.Repo)
	if !ok {
		return worker.PRObserveResult{
			Path:   path,
			Branch: facts.Branch,
			Reason: fmt.Sprintf("%s is not a repository this machine can look up", facts.Repo),
		}, nil
	}
	observe := r.Observe
	if observe == nil {
		observe = github.ObserveHere
	}
	res, err := observe(ctx, repo, facts.Branch)
	if err != nil {
		// The read failed, and whatever was known before still stands. The reason
		// travels as an answer so the Hub can put it on the row it already has,
		// rather than as a refusal that says nothing about the branch.
		return worker.PRObserveResult{
			Path:   path,
			Repo:   facts.Repo,
			Branch: facts.Branch,
			Reason: err.Error(),
		}, nil
	}
	out := worker.PRObserveResult{
		Path:     path,
		Repo:     facts.Repo,
		Branch:   facts.Branch,
		Observed: true,
		Source:   res.Source,
	}
	if pr := res.PR; pr != nil {
		out.Title = pr.Title
		out.URL = pr.URL
		out.State = pr.State
		out.Draft = pr.IsDraft
		out.BaseBranch = pr.BaseBranch
		out.HeadOID = pr.HeadOID
		out.CIState = pr.CI.State
		if pr.Number != nil {
			out.Number = *pr.Number
		}
		if summary, err := json.Marshal(pr.CI); err == nil {
			out.CISummary = string(summary)
		}
	}
	return out, nil
}
