package node

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// The question about a session's pull request, asked of the machine that holds
// the checkout.
//
// The Hub cannot answer it for another machine: what a read can see depends on
// whose credentials make it, so a Hub without them answers "no pull request"
// for a branch that has one. These cases are about the two halves of the answer
// staying apart — which branch this machine is on, and whether the pull request
// was actually read — because a caller that reads the second half as "none"
// loses a card that was still true.

// observeIn asks one machine what pull request a directory's branch has.
func observeIn(t *testing.T, r *Responder, conn *testConn, path string) worker.PRObserveResult {
	t.Helper()
	result := put(t, r, conn, worker.QueryPRObserve, worker.PRObserveParams{Path: path})
	if result.Error != "" {
		t.Fatalf("the pull request of %s was refused: %s", path, result.Error)
	}
	var found worker.PRObserveResult
	if err := result.Into(&found); err != nil {
		t.Fatal(err)
	}
	return found
}

// observing installs a reader that answers without a network, and records what
// it was asked.
func observing(t *testing.T, r *Responder, res github.LookupResult, err error) *[]string {
	t.Helper()
	asked := &[]string{}
	r.Observe = func(_ context.Context, repo github.Repo, branch string) (github.LookupResult, error) {
		*asked = append(*asked, repo.Canonical()+" "+branch)
		return res, err
	}
	return asked
}

func number(n int) *int { return &n }

func TestObservePRNamesTheBranchAndReadsItsPullRequest(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	gitCmdIn(t, repo, "remote", "add", "origin", "https://github.com/owner/app.git")
	r, conn := repoOn(t, root)
	asked := observing(t, r, github.LookupResult{
		Source: github.SourceGH,
		PR: &github.PullRequest{
			Number:     number(42),
			URL:        "https://github.com/owner/app/pull/42",
			Title:      "Add the thing",
			State:      "open",
			BaseBranch: "main",
			HeadOID:    "abc123",
			CI:         github.CIStatus{State: "success", Total: 2, Passed: 2},
		},
	}, nil)

	found := observeIn(t, r, conn, repo)
	if !found.Observed {
		t.Fatalf("the answer does not report an observation: %+v (reason %q)", found, found.Reason)
	}
	if found.Repo != "github.com/owner/app" || found.Branch != "main" {
		t.Errorf("answer is about %s %s, want github.com/owner/app main", found.Repo, found.Branch)
	}
	if len(*asked) != 1 || (*asked)[0] != "github.com/owner/app main" {
		t.Errorf("the read was asked for %v, want one read of github.com/owner/app main", *asked)
	}
	if found.Number != 42 || found.Title != "Add the thing" || found.State != "open" {
		t.Errorf("pull request = %+v", found)
	}
	if found.Source != "gh" || found.CIState != "success" {
		t.Errorf("source = %q, ci = %q", found.Source, found.CIState)
	}
	if !strings.Contains(found.CISummary, `"passed":2`) {
		t.Errorf("ci summary = %q, want the counts the Hub stores", found.CISummary)
	}
}

// A branch with no pull request is a successful read that found nothing, and the
// difference from a failed read is the whole reason the protocol carries both.
func TestObservePRABranchWithNoPullRequestIsStillAnObservation(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	gitCmdIn(t, repo, "remote", "add", "origin", "git@github.com:owner/app.git")
	r, conn := repoOn(t, root)
	observing(t, r, github.LookupResult{Source: github.SourceAnonymous}, nil)

	found := observeIn(t, r, conn, repo)
	if !found.Observed || found.Number != 0 {
		t.Fatalf("answer = %+v, want an observation with no pull request", found)
	}
	if found.Reason != "" {
		t.Errorf("reason = %q, want none: the read succeeded", found.Reason)
	}
}

// A read that failed answers with a reason and does not claim an observation:
// whatever the Hub knew before is still the best answer it has.
func TestObservePRAFailedReadKeepsTheBranchAndSaysWhy(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	gitCmdIn(t, repo, "remote", "add", "origin", "https://github.com/owner/app.git")
	r, conn := repoOn(t, root)
	observing(t, r, github.LookupResult{}, errors.New("gh: not logged in; anonymous: rate limited"))

	found := observeIn(t, r, conn, repo)
	if found.Observed {
		t.Fatal("a failed read reported an observation")
	}
	if found.Repo != "github.com/owner/app" || found.Branch != "main" {
		t.Errorf("a failed read lost the branch: %+v", found)
	}
	if !strings.Contains(found.Reason, "rate limited") {
		t.Errorf("reason = %q, want the read's own words", found.Reason)
	}
}

// Every reason short of the read is this machine's own sentence, and is an
// answer rather than a refusal: what the person needs to read is which of the
// three it was.
func TestObservePRSaysWhyItCannotLookOneUp(t *testing.T) {
	root := t.TempDir()
	r, conn := repoOn(t, root)

	plain := filepath.Join(root, "notes")
	if err := os.MkdirAll(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	noOrigin := gitRepo(t, filepath.Join(root, "no-origin"))

	detached := gitRepo(t, filepath.Join(root, "detached"))
	gitCmdIn(t, detached, "remote", "add", "origin", "https://github.com/owner/app.git")
	gitCmdIn(t, detached, "checkout", "--detach", "HEAD")

	notGithub := gitRepo(t, filepath.Join(root, "elsewhere"))
	gitCmdIn(t, notGithub, "remote", "add", "origin", "https://gitlab.com/owner/app.git")

	cases := []struct {
		what   string
		path   string
		reason string
	}{
		{"a directory that is not a checkout", plain, "not a git checkout"},
		{"a checkout with no remote", noOrigin, "no origin remote"},
		{"a detached head", detached, "not on a branch"},
		{"an origin this machine cannot look up", notGithub, "gitlab.com/owner/app"},
	}
	for _, c := range cases {
		t.Run(c.what, func(t *testing.T) {
			observing(t, r, github.LookupResult{PR: &github.PullRequest{Number: number(1)}}, nil)
			found := observeIn(t, r, conn, c.path)
			if found.Observed {
				t.Fatalf("%s was observed anyway: %+v", c.what, found)
			}
			if !strings.Contains(found.Reason, c.reason) {
				t.Errorf("reason = %q, want it to mention %q", found.Reason, c.reason)
			}
		})
	}
}

// The boundary every other question is held to. A pull request read is a network
// read on this machine's behalf, so it is not a way around the roots.
func TestObservePRRefusesADirectoryOutsideTheRoots(t *testing.T) {
	root := t.TempDir()
	outside := gitRepo(t, filepath.Join(t.TempDir(), "elsewhere"))
	r, conn := repoOn(t, root)
	result := put(t, r, conn, worker.QueryPRObserve, worker.PRObserveParams{Path: outside})
	if result.Error == "" {
		t.Fatal("a directory outside the roots was answered")
	}
}
