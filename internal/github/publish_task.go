package github

import (
	"context"
	"fmt"
	"strings"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
)

// Writing down a publish that a machine made.
//
// The Hub does not push anything: it asks the machine that holds the checkout —
// with that machine's git, its credentials, its gh — and this is the half that
// happens afterwards, on the Hub. It is the same accounting an observation gets,
// for the same reason: the panel is drawn from rows, and a publish that wrote no
// row would leave the person looking at a panel that does not know about the
// pull request they just opened.
//
// Nothing here is reachable from a read. The read routes answer from the cache
// and never ask anybody anything, which is the rule the whole panel is built on.

// PublishReport is what a publish did, in the shape the console reads.
//
// It is an answer for every ending, including "no": a publish that did not
// happen is an outcome of a question the person asked, not a failure of the
// request, and the console draws it in the same sheet that asked.
type PublishReport struct {
	TaskID string `json:"task_id"`
	// Repo and Branch are what the machine published, which is the checkout's
	// answer rather than this Hub's memory of where the session started.
	Repo   string `json:"repo,omitempty"`
	Branch string `json:"branch,omitempty"`
	// Pushed reports that the branch is on the remote, which can be true with no
	// pull request: see Reason.
	Pushed bool   `json:"pushed,omitempty"`
	Number int    `json:"number,omitempty"`
	URL    string `json:"url,omitempty"`
	// Blocked names why nothing was pushed, in the machine's vocabulary. The
	// console acts on "default_branch" — it is the one with a way out — and reads
	// the rest as Reason.
	Blocked string `json:"blocked,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// RecordPublish writes down what a machine said about publishing one task's
// checkout, and answers with what it wrote.
//
// title is the asker's, kept because a pull request this Hub has just learned
// about is one it can describe without spending a read on it.
func (s *Service) RecordPublish(ctx context.Context, taskID, title string, answer worker.PRPublishResult) (PublishReport, error) {
	report := PublishReport{
		TaskID:  taskID,
		Repo:    answer.Repo,
		Branch:  answer.Branch,
		Pushed:  answer.Pushed,
		Number:  answer.Number,
		URL:     answer.URL,
		Blocked: answer.Blocked,
		Reason:  answer.Reason,
	}
	if report.Blocked != "" {
		// Nothing was pushed, so nothing is written: a refusal that overwrote the
		// row would erase the last true thing the panel knows.
		return report, nil
	}
	if !report.Pushed {
		// A machine that answers without publishing and without saying why is one
		// this Hub cannot render, and reading it as success would put a card on the
		// panel for a pull request nobody opened.
		return report, fmt.Errorf("the machine answered without publishing and without saying why")
	}

	// What the machine said, checked rather than trusted, for the reason an
	// observation is: the answer is a wire value, and a row keyed on it unchecked
	// would file another repository's pull request under this task.
	repo, ok := ParseCanonical(answer.Repo)
	if !ok || strings.TrimSpace(answer.Branch) == "" {
		return report, fmt.Errorf("the machine published something this Hub cannot name: %q on %q",
			answer.Repo, answer.Branch)
	}

	// The row is written from what the machine said rather than read back: the
	// machine opened the pull request, so this Hub knows its number and its commit
	// without spending another question on it. The source is "gh" — that is what
	// pushed.
	//
	// A push that gh could not finish writes no observation at all, and that is
	// the point rather than an omission: a number of zero is the ordinary way this
	// arrives, and an observation is upserted whole, so writing one here would
	// erase the pull request this task's branch already has — which the reconcile
	// loop would never repair, because it watches the rows that have a number. The
	// branch is on the remote either way, so the task row below is still corrected;
	// the panel keeps the last true thing it knows about that branch, and the
	// person is told the rest by the report.
	if answer.Number > 0 {
		number := answer.Number
		res := LookupResult{Source: SourceGH, PR: &PullRequest{
			Number:  &number,
			URL:     answer.URL,
			Title:   title,
			State:   "open",
			HeadOID: answer.HeadOID,
		}}
		if err := s.record(ctx, Target{TaskID: taskID, Repo: repo, Branch: answer.Branch}, res, s.now()); err != nil {
			return report, err
		}
	}
	// The task row is corrected even when gh could not finish: the branch is on
	// the remote now, and that is where this session's work is. Best effort, and
	// written rather than compared first, because a publish is the moment the
	// answer is worth one write — the row is what the panel draws before anybody
	// asks the machine anything.
	recorded, moved := repo.Canonical(), answer.Branch
	_ = s.store.UpdateTask(ctx, taskID, store.TaskPatch{
		WorkspaceRepo:   &recorded,
		WorkspaceBranch: &moved,
	})
	return report, nil
}
