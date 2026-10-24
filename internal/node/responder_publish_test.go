package node

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/workspace"
)

// Publishing from a machine that holds the checkout.
//
// These are the two questions that make a phone able to put work on a forge:
// one that starts a branch, and one that pushes it and opens its pull request.
// Both are writes, so the boundary cases below are the point of the file — what
// a machine refuses, and what it refuses with.

// publishing stands in for this machine's git and GitHub CLI, and records what
// it was asked to do.
func publishing(t *testing.T, r *Responder, out github.PublishOutcome, err error) *[]github.PublishRequest {
	t.Helper()
	asked := &[]github.PublishRequest{}
	r.Publish = func(_ context.Context, git *workspace.Manager, req github.PublishRequest) (github.PublishOutcome, error) {
		if git == nil {
			t.Error("the machine was asked to publish with no workspace manager")
		}
		*asked = append(*asked, req)
		return out, err
	}
	return asked
}

func publishIn(t *testing.T, r *Responder, conn *testConn, params worker.PRPublishParams) worker.PRPublishResult {
	t.Helper()
	result := put(t, r, conn, worker.QueryPRPublish, params)
	if result.Error != "" {
		t.Fatalf("publishing %s was refused: %s", params.Path, result.Error)
	}
	var found worker.PRPublishResult
	if err := result.Into(&found); err != nil {
		t.Fatal(err)
	}
	return found
}

func TestPRPublishAsksThisMachinesGitAndAnswersWithThePullRequest(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "checkout"))
	r, conn := repoOn(t, root)
	asked := publishing(t, r, github.PublishOutcome{
		Dir:     repo,
		Repo:    github.Repo{Owner: "owner", Name: "app"},
		Branch:  "kin/task/t1/g1",
		HeadOID: "abc123",
		Pushed:  true,
		Number:  7,
		URL:     "https://github.com/owner/app/pull/7",
	}, nil)

	found := publishIn(t, r, conn, worker.PRPublishParams{Path: repo, Title: "Add it", Body: "Body."})
	if len(*asked) != 1 {
		t.Fatalf("the machine asked itself %d times, want once", len(*asked))
	}
	if (*asked)[0].Title != "Add it" || (*asked)[0].Body != "Body." || (*asked)[0].Dir != repo {
		t.Fatalf("asked with %+v", (*asked)[0])
	}
	if found.Repo != "github.com/owner/app" || found.Branch != "kin/task/t1/g1" {
		t.Fatalf("answer = %+v, want the repository and branch", found)
	}
	if found.Number != 7 || found.URL != "https://github.com/owner/app/pull/7" || found.HeadOID != "abc123" {
		t.Fatalf("answer = %+v, want the pull request", found)
	}
	if found.Blocked != "" {
		t.Fatalf("blocked = %q", found.Blocked)
	}
}

// A refusal to publish is an answer, not a broken question: the person reading
// it is looking at a phone, and "you are on main" is something the console acts
// on where a failed question would only be a red line.
func TestPRPublishCarriesARefusalAsAnAnswer(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "checkout"))
	r, conn := repoOn(t, root)
	publishing(t, r, github.PublishOutcome{
		Dir:     repo,
		Repo:    github.Repo{Owner: "owner", Name: "app"},
		Branch:  "main",
		Blocked: github.PublishBlockedDefault,
		Reason:  "this checkout is on main, which is this repository's default branch",
	}, nil)

	found := publishIn(t, r, conn, worker.PRPublishParams{Path: repo, Title: "t", Body: "b"})
	if found.Blocked != github.PublishBlockedDefault {
		t.Fatalf("blocked = %q (%s)", found.Blocked, found.Reason)
	}
	if !strings.Contains(found.Reason, "default branch") {
		t.Fatalf("reason = %q, want the machine's sentence", found.Reason)
	}
	if found.Number != 0 || found.URL != "" {
		t.Fatalf("a pull request was reported for a refused publish: %+v", found)
	}
}

// Nothing outside the roots is published, and that is a refusal rather than an
// answer: the boundary is not a state of the checkout, it is this machine
// saying the question was not its to answer.
func TestPRPublishRefusesAPathOutsideTheRoots(t *testing.T) {
	root := t.TempDir()
	outside := gitRepo(t, filepath.Join(t.TempDir(), "elsewhere"))
	r, conn := repoOn(t, root)
	asked := publishing(t, r, github.PublishOutcome{Pushed: true, Number: 7}, nil)

	reason := gitRefusal(t, worker.QueryPRPublish, worker.PRPublishParams{Path: outside, Title: "t", Body: "b"}, r, conn)
	if !strings.Contains(reason, "not a directory this machine works in") {
		t.Fatalf("refusal = %q, want the boundary named", reason)
	}
	if len(*asked) != 0 {
		t.Fatal("a directory outside the roots reached the publisher")
	}
}

// A failed push is a refusal: the machine could not do the thing, and git's own
// words are the answer. It is a different ending from "you are on main", which
// is a decision the machine made on purpose.
func TestPRPublishRefusesWhenThePushItselfFails(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "checkout"))
	r, conn := repoOn(t, root)
	publishing(t, r, github.PublishOutcome{}, errors.New("git push: remote rejected the update"))

	reason := gitRefusal(t, worker.QueryPRPublish, worker.PRPublishParams{Path: repo, Title: "t", Body: "b"}, r, conn)
	if !strings.Contains(reason, "remote rejected the update") {
		t.Fatalf("refusal = %q, want git's own words", reason)
	}
}

// The wire checks the shape of the words before the machine spends a push on
// them: a title is one line, and these travel as arguments to a program.
func TestPRPublishRefusesWordsItCannotCarry(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "checkout"))
	r, conn := repoOn(t, root)
	asked := publishing(t, r, github.PublishOutcome{Pushed: true, Number: 7}, nil)

	long := strings.Repeat("x", worker.MaxPRBody+1)
	for name, params := range map[string]worker.PRPublishParams{
		"a title with a newline in it": {Path: repo, Title: "two\nlines", Body: "b"},
		"a title of nothing":           {Path: repo, Title: "  ", Body: "b"},
		"a body past the bound":        {Path: repo, Title: "t", Body: long},
	} {
		if reason := gitRefusal(t, worker.QueryPRPublish, params, r, conn); reason == "" {
			t.Fatalf("%s was accepted", name)
		}
	}
	if len(*asked) != 0 {
		t.Fatal("words this machine will not carry reached the publisher")
	}
}

func TestGitBranchCreateStartsABranchAndAnswersWhereItIs(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "checkout"))
	r, conn := repoOn(t, root)

	result := put(t, r, conn, worker.QueryGitBranchCreate, worker.GitBranchCreateParams{
		Path: repo, Branch: "kin/task/t1/g1",
	})
	if result.Error != "" {
		t.Fatalf("creating a branch was refused: %s", result.Error)
	}
	var found worker.GitBranchCreateResult
	if err := result.Into(&found); err != nil {
		t.Fatal(err)
	}
	// Read back from git rather than echoed: what a directory is on is a fact
	// about the directory, and the answer is about to be shown to a person.
	status, err := r.Workspace.ListBranches(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	if found.Current != "kin/task/t1/g1" || status.Current != "kin/task/t1/g1" {
		t.Fatalf("answer %q, checkout %q, want the new branch", found.Current, status.Current)
	}
}

func TestGitBranchCreateRefusesAPathOutsideTheRoots(t *testing.T) {
	root := t.TempDir()
	outside := gitRepo(t, filepath.Join(t.TempDir(), "elsewhere"))
	r, conn := repoOn(t, root)

	reason := gitRefusal(t, worker.QueryGitBranchCreate,
		worker.GitBranchCreateParams{Path: outside, Branch: "kin/task/t1/g1"}, r, conn)
	if !strings.Contains(reason, "not a directory this machine works in") {
		t.Fatalf("refusal = %q, want the boundary named", reason)
	}
	status, err := r.Workspace.ListBranches(context.Background(), outside)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range status.Branches {
		if b.Name == "kin/task/t1/g1" {
			t.Fatal("a branch was created outside the roots")
		}
	}
}

// A machine with no git answers the question with a reason rather than failing
// it, and the boundary is still checked first.
func TestGitBranchCreateWithoutAWorkspaceManager(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "checkout"))
	r, conn := responderOn(t, root)
	r.Workspace = nil

	reason := gitRefusal(t, worker.QueryGitBranchCreate,
		worker.GitBranchCreateParams{Path: repo, Branch: "kin/task/t1/g1"}, r, conn)
	if !strings.Contains(reason, "no git") {
		t.Fatalf("refusal = %q, want it to name the missing git", reason)
	}
}
