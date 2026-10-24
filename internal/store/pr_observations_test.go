package store

import (
	"context"
	"path/filepath"
	"testing"
)

const (
	testPRRepo   = "github.com/owner/repo"
	testPRBranch = "kin/task/01PRTEST000000000000000001/g1"
	testPRTask   = "01PRTEST000000000000000001"
)

func number(n int) *int { return &n }

func TestPRObservationRoundTrip(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	in := PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(42), URL: "https://github.com/owner/repo/pull/42",
		Title: "Add the thing", State: "open", IsDraft: true,
		BaseBranch: "main", HeadOID: "abc123",
		CIState: CIFailure, CISummary: `{"state":"failure"}`,
		Source: "gh",
	}
	if err := s.RecordPRObservation(ctx, in); err != nil {
		t.Fatal(err)
	}

	got, ok, err := s.GetPRObservation(ctx, testPRRepo, testPRBranch)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.Number == nil || *got.Number != 42 {
		t.Fatalf("number = %v, want 42", got.Number)
	}
	if got.Title != in.Title || got.State != "open" || !got.IsDraft {
		t.Fatalf("got %+v", got)
	}
	if got.CIState != CIFailure || got.Source != "gh" {
		t.Fatalf("got %+v", got)
	}
	if got.ObservedAt == nil {
		t.Fatal("observed_at was not set")
	}
	if got.LastError != "" {
		t.Fatalf("last_error = %q, want empty after a success", got.LastError)
	}
}

// The load-bearing property: a failed query must not destroy what the last
// successful one learned. This is what lets the console show "last seen 12
// minutes ago, this attempt failed" instead of losing the pull request.
func TestPRFailureDoesNotEraseASuccessfulObservation(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(42), URL: "https://github.com/owner/repo/pull/42",
		State: "open", CIState: CISuccess, Source: "gh",
	}); err != nil {
		t.Fatal(err)
	}
	before, _, err := s.GetPRObservation(ctx, testPRRepo, testPRBranch)
	if err != nil {
		t.Fatal(err)
	}

	if err := s.RecordPRFailure(ctx, testPRRepo, testPRBranch, testPRTask, "network is down"); err != nil {
		t.Fatal(err)
	}

	after, _, err := s.GetPRObservation(ctx, testPRRepo, testPRBranch)
	if err != nil {
		t.Fatal(err)
	}
	if after.Number == nil || *after.Number != 42 {
		t.Fatalf("number = %v, want the previous 42 to survive", after.Number)
	}
	if after.URL != before.URL || after.State != "open" || after.CIState != CISuccess {
		t.Fatalf("failure changed the success fields: %+v -> %+v", before, after)
	}
	if *after.ObservedAt != *before.ObservedAt {
		t.Fatalf("observed_at moved on a failure: %d -> %d", *before.ObservedAt, *after.ObservedAt)
	}
	if after.LastError != "network is down" {
		t.Fatalf("last_error = %q, want the failure reason", after.LastError)
	}
	if after.AttemptedAt < before.AttemptedAt {
		t.Fatalf("attempted_at went backwards: %d -> %d", before.AttemptedAt, after.AttemptedAt)
	}
}

// Recording a failure for a branch nobody has successfully read still has to
// leave a trace, or the console cannot explain why it knows nothing.
func TestPRFailureOnUnknownBranchCreatesARow(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	if err := s.RecordPRFailure(ctx, testPRRepo, testPRBranch, testPRTask, "no credentials"); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.GetPRObservation(ctx, testPRRepo, testPRBranch)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.ObservedAt != nil {
		t.Fatalf("observed_at = %v, want nil: nothing has ever been observed", got.ObservedAt)
	}
	if got.Number != nil {
		t.Fatalf("number = %v, want nil", got.Number)
	}
	if got.LastError != "no credentials" {
		t.Fatalf("last_error = %q", got.LastError)
	}
}

// A *successful* answer of "there is no pull request" is information, and it is
// allowed to supersede an older number. The distinction is success, not age.
func TestSuccessfulEmptyAnswerSupersedesAnOlderNumber(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(42), State: "open",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		// Number nil: the query ran and found nothing.
	}); err != nil {
		t.Fatal(err)
	}

	got, _, err := s.GetPRObservation(ctx, testPRRepo, testPRBranch)
	if err != nil {
		t.Fatal(err)
	}
	if got.Number != nil {
		t.Fatalf("number = %v, want nil after a successful empty answer", got.Number)
	}
	if got.ObservedAt == nil {
		t.Fatal("observed_at should be set by the successful empty answer")
	}
	if got.CIState != "" {
		t.Fatalf("ci_state = %q, want cleared along with the pull request", got.CIState)
	}
}

// comments_seen is a cursor owned by the feed-back action, not part of an
// observation, so refreshing must not rewind it and replay comments.
func TestObservationWritePreservesCommentsCursor(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(42), State: "open",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.AdvancePRCommentsSeen(ctx, testPRRepo, testPRBranch, 9001); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(42), State: "open", CIState: CIPending,
	}); err != nil {
		t.Fatal(err)
	}

	got, _, err := s.GetPRObservation(ctx, testPRRepo, testPRBranch)
	if err != nil {
		t.Fatal(err)
	}
	if got.CommentsSeen != 9001 {
		t.Fatalf("comments_seen = %d, want 9001 to survive a refresh", got.CommentsSeen)
	}
}

func TestAdvancePRCommentsSeenNeverMovesBackward(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(42), State: "open",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.AdvancePRCommentsSeen(ctx, testPRRepo, testPRBranch, 100); err != nil {
		t.Fatal(err)
	}
	if err := s.AdvancePRCommentsSeen(ctx, testPRRepo, testPRBranch, 50); err != nil {
		t.Fatal(err)
	}

	got, _, err := s.GetPRObservation(ctx, testPRRepo, testPRBranch)
	if err != nil {
		t.Fatal(err)
	}
	if got.CommentsSeen != 100 {
		t.Fatalf("comments_seen = %d, want 100", got.CommentsSeen)
	}
}

// The background watch set is open pull requests only: a branch with no pull
// request cannot change on its own.
func TestListOpenPRObservationsSelectsOnlyOpenPullRequests(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	seed := []PRObservation{
		{Repo: testPRRepo, HeadBranch: "branch-open", TaskID: testPRTask, Number: number(1), State: "open"},
		{Repo: testPRRepo, HeadBranch: "branch-merged", TaskID: testPRTask, Number: number(2), State: "merged"},
		{Repo: testPRRepo, HeadBranch: "branch-none", TaskID: testPRTask},
		{Repo: testPRRepo, HeadBranch: "branch-failed", TaskID: testPRTask, LastError: "x"},
	}
	for _, o := range seed {
		if err := s.RecordPRObservation(ctx, o); err != nil {
			t.Fatal(err)
		}
	}
	// A row that only ever saw a failure has state "" and must not be watched.
	if err := s.RecordPRFailure(ctx, testPRRepo, "branch-failed", testPRTask, "x"); err != nil {
		t.Fatal(err)
	}

	got, err := s.ListOpenPRObservations(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].HeadBranch != "branch-open" {
		t.Fatalf("watch set = %+v, want only branch-open", got)
	}

	limited, err := s.ListOpenPRObservations(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited) != 0 {
		t.Fatalf("limit 0 returned %d rows", len(limited))
	}
}

func TestListPRObservationsByTask(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	for _, branch := range []string{"g1", "g2"} {
		if err := s.RecordPRObservation(ctx, PRObservation{
			Repo: testPRRepo, HeadBranch: branch, TaskID: testPRTask,
			Number: number(1), State: "open",
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: "other", TaskID: "01OTHER0000000000000000001",
		Number: number(2), State: "open",
	}); err != nil {
		t.Fatal(err)
	}

	got, err := s.ListPRObservationsByTask(ctx, testPRTask)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d observations for the task, want 2", len(got))
	}
}

func TestPRObservationRequiresKeys(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	if err := s.RecordPRObservation(ctx, PRObservation{Repo: "x"}); err == nil {
		t.Fatal("expected an error for a missing head_branch and task_id")
	}
	if err := s.RecordPRFailure(ctx, "x", "", "", "why"); err == nil {
		t.Fatal("expected an error for a missing head_branch")
	}
}

// A database that predates this table must gain it on open, without losing
// anything it already held.
func TestUpgradeFromVersion36AddsPRObservations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// Populate something older than this migration, so the upgrade has to
	// preserve it rather than merely recreate an empty schema.
	task := Task{
		ID: "01PRUPGRADE000000000000001", Title: "existing", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "queued", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	// Wind the database back to the version before this table existed.
	if _, err := s.db.Exec(`
		DROP INDEX IF EXISTS idx_pr_observations_open;
		DROP INDEX IF EXISTS idx_pr_observations_task;
		DROP TABLE pr_observations;
		PRAGMA user_version = 36;`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen at version 36: %v", err)
	}
	defer upgraded.Close()

	if got := schemaVersionOf(t, upgraded); got != schemaVersion {
		t.Fatalf("user_version = %d, want %d", got, schemaVersion)
	}
	if !tableExists(t, upgraded, "pr_observations") {
		t.Fatal("pr_observations was not created by the upgrade")
	}
	if _, err := upgraded.GetTask(ctx, task.ID); err != nil {
		t.Fatalf("existing task did not survive the upgrade: %v", err)
	}
	if err := upgraded.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: task.ID,
		Number: number(7), State: "open",
	}); err != nil {
		t.Fatalf("record after upgrade: %v", err)
	}
}
