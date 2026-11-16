package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
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

	if err := s.RecordPRFailure(ctx, testPRRepo, testPRBranch, testPRTask, "network is down", time.Time{}); err != nil {
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

	if err := s.RecordPRFailure(ctx, testPRRepo, testPRBranch, testPRTask, "no credentials", time.Time{}); err != nil {
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

// Two questions can be in flight for one branch at once — the background pass
// reading a row while someone taps refresh — and the answer that arrives last is
// not necessarily the answer to the question asked last. The row follows the
// question, so a slow read cannot walk the console backwards from merged to open.
func TestAnOlderAnswerDoesNotOverwriteANewerOne(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	base := time.Now().Add(-time.Minute)

	// Asked second, answered first.
	later := base.Add(2 * time.Second).UnixMilli()
	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(9), URL: "https://github.com/owner/repo/pull/9", State: "closed",
		ObservedAt: &later, AttemptedAt: later,
	}); err != nil {
		t.Fatal(err)
	}

	// Asked first, answered last, and it saw the pull request still open.
	earlier := base.UnixMilli()
	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(7), URL: "https://github.com/owner/repo/pull/7", State: "open",
		ObservedAt: &earlier, AttemptedAt: earlier,
	}); err != nil {
		t.Fatal(err)
	}

	got, _, err := s.GetPRObservation(ctx, testPRRepo, testPRBranch)
	if err != nil {
		t.Fatal(err)
	}
	if got.Number == nil || *got.Number != 9 || got.State != "closed" {
		t.Fatalf("row = %+v, want the newer question's answer to stand", got)
	}
	if got.ObservedAt == nil || *got.ObservedAt != later {
		t.Fatalf("observed_at = %v, want %d", got.ObservedAt, later)
	}
}

// The two clocks on a row are independent, and the write that carries the newer
// observation may still be older than the attempt already recorded. AttemptedAt
// only moves forward, and a success only clears the error when it is also the
// newest attempt — otherwise the row would claim the last attempt succeeded when
// the last attempt is the one that failed.
func TestASuccessOlderThanTheRecordedAttemptDoesNotClearItsError(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	base := time.Now().Add(-time.Minute)

	first := base.Add(time.Second).UnixMilli()
	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(1), State: "open", ObservedAt: &first, AttemptedAt: first,
	}); err != nil {
		t.Fatal(err)
	}

	// A question asked after that one fails.
	failed := base.Add(3 * time.Second)
	if err := s.RecordPRFailure(ctx, testPRRepo, testPRBranch, testPRTask, "network is down", failed); err != nil {
		t.Fatal(err)
	}

	// A question asked between the two is answered last: newer than the recorded
	// observation, older than the recorded attempt.
	between := base.Add(2 * time.Second).UnixMilli()
	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(2), State: "open", ObservedAt: &between, AttemptedAt: between,
	}); err != nil {
		t.Fatal(err)
	}

	got, _, err := s.GetPRObservation(ctx, testPRRepo, testPRBranch)
	if err != nil {
		t.Fatal(err)
	}
	if got.Number == nil || *got.Number != 2 {
		t.Fatalf("number = %v, want the middle question's answer", got.Number)
	}
	if got.ObservedAt == nil || *got.ObservedAt != between {
		t.Fatalf("observed_at = %v, want %d", got.ObservedAt, between)
	}
	if got.AttemptedAt != failed.UnixMilli() {
		t.Fatalf("attempted_at = %d, want the newest attempt at %d", got.AttemptedAt, failed.UnixMilli())
	}
	if got.LastError != "network is down" {
		t.Fatalf("last_error = %q, want the newer attempt's failure to stand", got.LastError)
	}
}

// A failure answering an older question has nothing newer to say, so it is
// dropped rather than written over the attempt that came after it.
func TestAnOlderFailureDoesNotOverwriteANewerAttempt(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	base := time.Now().Add(-time.Minute)

	newer := base.Add(2 * time.Second).UnixMilli()
	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: testPRBranch, TaskID: testPRTask,
		Number: number(4), State: "open", ObservedAt: &newer, AttemptedAt: newer,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordPRFailure(ctx, testPRRepo, testPRBranch, testPRTask, "stale failure", base); err != nil {
		t.Fatal(err)
	}

	got, _, err := s.GetPRObservation(ctx, testPRRepo, testPRBranch)
	if err != nil {
		t.Fatal(err)
	}
	if got.LastError != "" {
		t.Fatalf("last_error = %q, want the older failure to be dropped", got.LastError)
	}
	if got.AttemptedAt != newer {
		t.Fatalf("attempted_at = %d, want %d", got.AttemptedAt, newer)
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
	seedTaskForPRs(t, s, testPRTask)

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
	if err := s.RecordPRFailure(ctx, testPRRepo, "branch-failed", testPRTask, "x", time.Time{}); err != nil {
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

// A row whose task is gone is not watched. Nothing lists it on any screen, so
// nothing can ever delete it: polling it would spend a query per tick, forever,
// on a branch nobody can reach. Deleting a task deletes its rows, but a database
// written before that did not, and those are the rows this is for.
func TestOpenWatchSetIgnoresRowsWhoseTaskIsGone(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: "orphan", TaskID: "01GONETASK0000000000000001",
		Number: number(3), State: "open",
	}); err != nil {
		t.Fatal(err)
	}
	seedTaskForPRs(t, s, testPRTask)
	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: "watched", TaskID: testPRTask,
		Number: number(4), State: "open",
	}); err != nil {
		t.Fatal(err)
	}

	got, err := s.ListOpenPRObservations(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].HeadBranch != "watched" {
		t.Fatalf("watch set = %+v, want only the row whose task still exists", got)
	}
}

// seedTaskForPRs creates the task a seeded observation belongs to. The watch set
// holds only rows whose task still exists, so a fixture that wants a watched row
// has to hang it on a task.
func seedTaskForPRs(t *testing.T, s *Store, taskID string) {
	t.Helper()
	if err := s.InsertTask(context.Background(), Task{
		ID: taskID, Title: "pr fixture", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
}

// A row is watched only while it is the pair its task is on.
//
// For a task this daemon reads itself that is always true: the row's branch *is*
// the question, so refreshing it always writes back to it. For a task on another
// machine it is not — the question there is "what is this checkout on now", so a
// row for a branch the checkout has left can never be written to again by
// anything: its clocks freeze, it stays due forever, and it holds a slot in the
// batch. Twenty-five of those and no pull request anywhere is refreshed in the
// background again.
func TestOpenWatchSetSkipsARemoteRowTheCheckoutHasLeft(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	seedRemoteTaskForPRs(t, s, testPRTask, "node-1", "feature/new")

	seed := []PRObservation{
		{Repo: testPRRepo, HeadBranch: "feature/old", TaskID: testPRTask, Number: number(1), State: "open"},
		{Repo: testPRRepo, HeadBranch: "feature/new", TaskID: testPRTask, Number: number(2), State: "open"},
	}
	for _, o := range seed {
		if err := s.RecordPRObservation(ctx, o); err != nil {
			t.Fatal(err)
		}
	}

	got, err := s.ListOpenPRObservations(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].HeadBranch != "feature/new" {
		t.Fatalf("watch set = %+v, want only the branch the checkout is on", got)
	}
}

// Nothing recorded is not a disagreement. A session that started while its
// machine was away has no pair on the row, and the observation is the only thing
// that knows the branch — watching it is how the row gets refreshed at all.
func TestOpenWatchSetKeepsARemoteRowWithNothingRecorded(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	seedRemoteTaskForPRs(t, s, testPRTask, "node-1", "")

	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: "feature/scratch", TaskID: testPRTask,
		Number: number(1), State: "open",
	}); err != nil {
		t.Fatal(err)
	}

	got, err := s.ListOpenPRObservations(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].HeadBranch != "feature/scratch" {
		t.Fatalf("watch set = %+v, want the row nothing disagrees with", got)
	}
}

// A task this daemon reads itself is watched whatever its row says. Its rows are
// the question it asks, so a pair on the task that disagrees — written by any
// other path — is not a reason to stop refreshing a pull request it can read.
func TestOpenWatchSetKeepsALocalRowWhoseTaskRecordsAnotherBranch(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if err := s.InsertTask(ctx, Task{
		ID: testPRTask, Title: "pr fixture", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: NowMilli(),
		WorkspaceRepo: testPRRepo, WorkspaceBranch: "something/else",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordPRObservation(ctx, PRObservation{
		Repo: testPRRepo, HeadBranch: "feature/scratch", TaskID: testPRTask,
		Number: number(1), State: "open",
	}); err != nil {
		t.Fatal(err)
	}

	got, err := s.ListOpenPRObservations(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].HeadBranch != "feature/scratch" {
		t.Fatalf("watch set = %+v, want this daemon's own row", got)
	}
}

// seedRemoteTaskForPRs is seedTaskForPRs for a task that runs on another machine,
// with the pair that machine reported.
func seedRemoteTaskForPRs(t *testing.T, s *Store, taskID, device, branch string) {
	t.Helper()
	if err := s.InsertTask(context.Background(), Task{
		ID: taskID, Title: "pr fixture", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: NowMilli(),
		ExecutingDeviceID: device, WorkspaceRepo: testPRRepo, WorkspaceBranch: branch,
	}); err != nil {
		t.Fatal(err)
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
	if err := s.RecordPRFailure(ctx, "x", "", "", "why", time.Time{}); err == nil {
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
