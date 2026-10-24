package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

// newTestService builds a Service whose only reader is the supplied fake, with
// gh forced unavailable so the anonymous path is the one exercised.
func newTestService(t *testing.T, reader apiRunner) (*Service, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	svc := NewService(st)
	svc.anon = reader
	// No gh, and no attempt to find one: a test must not run the real binary or
	// depend on whether this machine happens to have one.
	svc.ghRetryAfter = svc.now().Add(24 * time.Hour)
	svc.ghReason = "disabled for test"
	return svc, st
}

// testClock is a settable clock anchored at real time.
//
// The anchor matters: the store timestamps rows from the wall clock, so a clock
// fixed at some arbitrary instant in the past would make every stored row look
// like it came from the future and every floor test pass for the wrong reason.
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func newTestClock() *testClock { return &testClock{now: time.Now()} }

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func testTarget() Target {
	return Target{
		TaskID: "01PRSERVICE000000000000001",
		Repo:   Repo{Owner: "owner", Name: "repo"},
		Branch: "kin/task/1/g1",
	}
}

// seedWatchedTask creates the task a seeded observation hangs on. The background
// pass watches rows whose task still exists — a deleted task's rows are not
// polled — so a row meant to be watched needs a task behind it. Without one these
// tests would pass by watching nothing, which is not what they are about.
func seedWatchedTask(t *testing.T, st *store.Store, taskID string) {
	t.Helper()
	if err := st.InsertTask(context.Background(), store.Task{
		ID: taskID, Title: "pr fixture", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
}

// The read path is a cache read and nothing else.
//
// That is what lets the console ask this question on every open without spending
// rate limit, and it is why the panel has to be honest about the age of what it
// shows: nothing on this path is live. Freshness comes from two other places —
// the background pass, and the explicit refresh, which is the one action that
// queries.
//
// A branch whose every attempt has failed is the case that used to cost a query
// per view: such a row has no observation time to age out, so any freshness rule
// applied here would ask again and again for an answer that cannot change until
// the user does something. Here it is structural: there is no query to make.
// The two floors are the whole of the background pass's pacing, and no other
// test pins them: Reconcile's tests only use rows far outside either window, so
// the numbers themselves — and the fact that a login is meant to buy a shorter
// one — could be changed to anything without a red test.
func TestFloorForDistinguishesTheTwoCredentialSources(t *testing.T) {
	reader := &fakeRunner{name: SourceAnonymous}
	svc, _ := newTestService(t, reader)

	if got := svc.floorFor(SourceAnonymous); got != anonymousFloor {
		t.Fatalf("anonymous floor = %v, want %v", got, anonymousFloor)
	}
	// A row labelled gh while gh is unusable keeps the anonymous cadence: what
	// the next attempt spends is decided by what is usable now, not by what
	// happened to answer last time.
	if got := svc.floorFor(SourceGH); got != anonymousFloor {
		t.Fatalf("floor with no usable gh = %v, want the anonymous one (%v)", got, anonymousFloor)
	}

	svc.mu.Lock()
	svc.ghRetryAfter = time.Time{}
	svc.ghClient = &GHClient{Bin: GHBinary{Path: "/nonexistent/gh"}}
	svc.mu.Unlock()

	if got := svc.floorFor(SourceGH); got != authenticatedFloor {
		t.Fatalf("authenticated floor = %v, want %v", got, authenticatedFloor)
	}
	if got := svc.floorFor(SourceAnonymous); got != anonymousFloor {
		t.Fatalf("an anonymous row keeps the anonymous floor, got %v", got)
	}
	if authenticatedFloor >= anonymousFloor {
		t.Fatalf("floors are %v and %v; the authenticated one has to be the shorter, "+
			"or having a login buys nothing", authenticatedFloor, anonymousFloor)
	}
}

func TestSnapshotReadPathNeverQueries(t *testing.T) {
	reader := &fakeRunner{
		name:      SourceAnonymous,
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	// Every query announces itself, because the regression this test guards
	// against is asynchronous: the old read path started a goroutine and
	// returned, so counting calls at this instant would have passed for a
	// detached query that had simply not fired yet. A channel is also the only
	// way to observe the fake's call list without racing it.
	//
	// The wait below is a window, and a window has an edge: a query that took
	// longer than 250ms to reach the runner would slip past it. Nothing
	// in-process is that slow — `apiGet` on the fake returns immediately — and
	// what this is here to catch is a reinstated background query, not a real
	// network call.
	started := make(chan string, 8)
	reader.onCall = func(path string) {
		select {
		case started <- path:
		default:
		}
	}
	svc, st := newTestService(t, reader)
	ctx := context.Background()
	const taskID = "01PRREADPATH00000000000001"
	branch := seedTaskWithWorkspace(t, st, taskID)

	// The branch has been looked at and the attempt failed: the worst case for a
	// rule that decides whether to ask again.
	if err := st.RecordPRFailure(ctx, "github.com/owner/repo", branch, taskID,
		"404: not found or not visible", time.Now()); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 5; i++ {
		snap, err := svc.SnapshotForTask(ctx, taskID, false)
		if err != nil {
			t.Fatalf("snapshot %d: %v", i, err)
		}
		if snap.Repo != "github.com/owner/repo" || snap.Branch != branch {
			t.Fatalf("snapshot %d named %q/%q, want the task's repository and branch",
				i, snap.Repo, snap.Branch)
		}
		if len(snap.Observations) != 1 || snap.Observations[0].LastError == "" {
			t.Fatalf("snapshot %d = %+v, want the failed attempt on its row", i, snap.Observations)
		}
	}
	// One observation point rather than two: the fake's call list is appended to
	// without a lock, so reading its length here would be the same race this
	// test's channel exists to avoid, and a second way of asking the question
	// can disagree with the first.
	select {
	case path := <-started:
		t.Fatalf("the read path started a query for %s", path)
	case <-time.After(250 * time.Millisecond):
	}

	// The explicit refresh is the other half of the contract: it queries, and it
	// waits, because the user asked for an answer and is watching for it.
	snap, err := svc.SnapshotForTask(ctx, taskID, true)
	if err != nil {
		t.Fatalf("forced snapshot: %v", err)
	}
	select {
	case <-started:
		// The signal is the assertion; the path it carried was checked above.
	case <-time.After(time.Second):
		t.Fatal("the forced refresh made no query")
	}
	if len(snap.Observations) != 1 || snap.Observations[0].ObservedAt == nil {
		t.Fatalf("observations = %+v, want the answer this refresh fetched", snap.Observations)
	}
	if got := snap.Observations[0].LastError; got != "" {
		t.Fatalf("last_error = %q, want it cleared by a successful attempt", got)
	}
}

// The invariant the whole schema exists for, exercised through the service: a
// failing query leaves the previous successful answer standing.
func TestFailedRefreshKeepsTheLastGoodAnswer(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	reader := &fakeRunner{
		name: SourceAnonymous,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls": []byte(`[{"number":42,"html_url":"https://github.com/owner/repo/pull/42",
				"title":"T","state":"open","base":{"ref":"main"},"head":{"sha":"abc"}}]`),
			"/repos/owner/repo/commits/abc/check-runs": []byte(`{"check_runs":[]}`),
			"/repos/owner/repo/commits/abc/status":     []byte(`{"state":"success","statuses":[]}`),
		},
	}
	svc, st := newTestService(t, reader)
	svc.SetClock(func() time.Time { return now })
	ctx := context.Background()
	target := testTarget()

	if _, err := svc.Observe(ctx, target); err != nil {
		t.Fatalf("first observe: %v", err)
	}
	good, _, err := st.GetPRObservation(ctx, target.Repo.Canonical(), target.Branch)
	if err != nil || good.Number == nil || *good.Number != 42 {
		t.Fatalf("setup did not store a pull request: %+v err=%v", good, err)
	}

	// Now the network fails on the next attempt.
	reader.errs = map[string]error{
		"/repos/owner/repo/pulls": errors.New("network is down"),
	}
	after, err := svc.Observe(ctx, target)
	if err == nil {
		t.Fatal("expected the failed attempt to report an error")
	}
	if after.Number == nil || *after.Number != 42 {
		t.Fatalf("number = %v, want the previous 42 to survive a failure", after.Number)
	}
	if after.URL != good.URL || after.State != "open" {
		t.Fatalf("failure changed the good answer: %+v", after)
	}
	if !strings.Contains(after.LastError, "network is down") {
		t.Fatalf("last_error = %q", after.LastError)
	}
}

// One reader failing over to the other must record which one answered, because
// an anonymous read cannot see private repositories.
func TestFallsBackWhenGHIsUnavailable(t *testing.T) {
	reader := &fakeRunner{
		name:      SourceAnonymous,
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	svc, _ := newTestService(t, reader)
	obs, err := svc.Observe(context.Background(), testTarget())
	if err != nil {
		t.Fatalf("Observe: %v", err)
	}
	if obs.Source != SourceAnonymous {
		t.Fatalf("source = %q, want %q", obs.Source, SourceAnonymous)
	}
	if svc.Status().Available {
		t.Fatal("Status reported gh as available when it is disabled")
	}
}

// A 404 must be recorded as a failure, never as "there is no pull request".
func TestNotFoundIsRecordedAsAFailureNotAnEmptyAnswer(t *testing.T) {
	reader := &fakeRunner{
		name: SourceAnonymous,
		errs: map[string]error{
			"/repos/owner/repo/pulls": errors.New("404: not found or not visible"),
		},
	}
	svc, st := newTestService(t, reader)
	target := testTarget()

	obs, err := svc.Observe(context.Background(), target)
	if err == nil {
		t.Fatal("expected an error")
	}
	if obs.Number != nil {
		t.Fatalf("number = %v, want nil", obs.Number)
	}
	if obs.ObservedAt != nil {
		t.Fatal("a failed lookup must not count as an observation")
	}
	if obs.LastError == "" {
		t.Fatal("the failure was not recorded")
	}

	stored, _, err := st.GetPRObservation(context.Background(), target.Repo.Canonical(), target.Branch)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.ObservedAt != nil {
		t.Fatal("a failed lookup wrote an observation timestamp")
	}
}

// The background pass only walks open pull requests, and respects a longer floor
// when the last answer came from the anonymous reader, whose quota is shared.
func TestReconcileSkipsFreshAndNonOpenRows(t *testing.T) {
	reader := &fakeRunner{
		name:      SourceAnonymous,
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	svc, st := newTestService(t, reader)
	now := time.Unix(1_700_000_000, 0)
	svc.SetClock(func() time.Time { return now })
	ctx := context.Background()
	seedWatchedTask(t, st, "t1")
	seedWatchedTask(t, st, "t2")

	// An open pull request read moments ago from the anonymous source.
	recent := now.UnixMilli()
	if err := st.RecordPRObservation(ctx, store.PRObservation{
		Repo: "github.com/owner/repo", HeadBranch: "b-open", TaskID: "t1",
		Number: number(1), State: "open", Source: SourceAnonymous, ObservedAt: &recent,
	}); err != nil {
		t.Fatal(err)
	}
	// A merged one, whatever its age, is not watched.
	if err := st.RecordPRObservation(ctx, store.PRObservation{
		Repo: "github.com/owner/repo", HeadBranch: "b-merged", TaskID: "t2",
		Number: number(2), State: "merged", Source: SourceAnonymous,
	}); err != nil {
		t.Fatal(err)
	}

	n, err := svc.Reconcile(ctx, 10)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if n != 0 {
		t.Fatalf("refreshed %d rows, want 0", n)
	}
	if len(reader.calls) != 0 {
		t.Fatalf("made %d queries, want none: %v", len(reader.calls), reader.calls)
	}
}

// A row whose last attempt just failed is not retried by the next tick.
//
// The observation clock stops advancing when the reads start failing — a
// repository that went private, a login that expired, a quota that ran out — so
// a floor keyed only on the observation would put a fresh query behind every
// tick: twenty-five rows a minute, fifteen hundred anonymous lookups an hour
// against a quota of sixty.
func TestReconcileLeavesARecentlyAttemptedRowAlone(t *testing.T) {
	reader := &fakeRunner{
		name:      SourceAnonymous,
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	svc, st := newTestService(t, reader)
	clock := newTestClock()
	svc.SetClock(clock.Now)
	seedWatchedTask(t, st, "t")
	ctx := context.Background()

	// Read successfully long ago, and attempted moments ago. That pair is what a
	// failing read leaves behind: RecordPRFailure moves the attempt time and
	// deliberately leaves the last good answer where it was.
	old := clock.Now().Add(-2 * anonymousFloor).UnixMilli()
	if err := st.RecordPRObservation(ctx, store.PRObservation{
		Repo: "github.com/owner/repo", HeadBranch: "b-failing", TaskID: "t",
		Number: number(7), State: "open", Source: SourceAnonymous,
		ObservedAt: &old, AttemptedAt: clock.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Reconcile(ctx, 10); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if len(reader.calls) != 0 {
		t.Fatalf("made %d queries for a row attempted just now: %v", len(reader.calls), reader.calls)
	}

	// Once the attempt has aged past the floor it is worth another try.
	clock.Advance(anonymousFloor)
	if _, err := svc.Reconcile(ctx, 10); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if len(reader.calls) == 0 {
		t.Fatal("a row whose last attempt has aged out was never retried")
	}
}

// The anonymous budget is charged where the anonymous request happens, not where
// the caller expected it to happen.
//
// The two differ exactly when gh is usable and then fails: an expired login, a
// rate limit, a repository that went private. The preflight reads the row's
// recorded source, decides the read will be authenticated, and claims nothing —
// and then the read falls through to the anonymous path anyway. Charging on the
// way in is how a pass spends a sixty-request hour without ever deciding to.
func TestReconcileChargesAnAnonymousFallback(t *testing.T) {
	reader := &fakeRunner{
		name:      SourceAnonymous,
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	svc, st := newTestService(t, reader)
	clock := newTestClock()
	svc.SetClock(clock.Now)
	// gh resolves, so the preflight believes the next read is authenticated and
	// claims nothing. Every read of it then fails, because the binary is not
	// there, and each one falls through to the anonymous reader.
	svc.ghClient = &GHClient{Bin: GHBinary{Path: "/nonexistent/gh"}}
	seedWatchedTask(t, st, "t")
	ctx := context.Background()

	stale := clock.Now().Add(-2 * authenticatedFloor).UnixMilli()
	for i := 0; i < anonymousBudgetPerHour+5; i++ {
		if err := st.RecordPRObservation(ctx, store.PRObservation{
			Repo: "github.com/owner/repo", HeadBranch: fmt.Sprintf("b-%02d", i), TaskID: "t",
			Number: number(i + 1), State: "open", Source: SourceGH,
			ObservedAt: &stale, AttemptedAt: stale,
		}); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := svc.Reconcile(ctx, 25); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if len(reader.calls) > anonymousBudgetPerHour {
		t.Fatalf("the anonymous fallback made %d requests, want at most %d: "+
			"the budget was not charged where the request was made",
			len(reader.calls), anonymousBudgetPerHour)
	}
}

// A tap is not charged to the budget that exists to stop the pass spending
// unwatched. Exhausting the hour must not make the refresh button stop working —
// that would be the feature refusing the one action a user can take.
func TestAForcedQueryIsNotChargedToTheBackgroundBudget(t *testing.T) {
	reader := &fakeRunner{
		name:      SourceAnonymous,
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	svc, st := newTestService(t, reader)
	clock := newTestClock()
	svc.SetClock(clock.Now)
	seedWatchedTask(t, st, "t")
	ctx := context.Background()

	stale := clock.Now().Add(-2 * anonymousFloor).UnixMilli()
	for i := 0; i < anonymousBudgetPerHour+5; i++ {
		if err := st.RecordPRObservation(ctx, store.PRObservation{
			Repo: "github.com/owner/repo", HeadBranch: fmt.Sprintf("b-%02d", i), TaskID: "t",
			Number: number(i + 1), State: "open", Source: SourceAnonymous,
			ObservedAt: &stale, AttemptedAt: stale,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.Reconcile(ctx, 25); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	spent := len(reader.calls)

	if _, err := svc.Observe(ctx, Target{
		TaskID: "t", Repo: Repo{Owner: "owner", Name: "repo"}, Branch: "b-00",
	}); err != nil {
		t.Fatalf("Observe after the budget was spent: %v", err)
	}
	if len(reader.calls) != spent+1 {
		t.Fatalf("a forced query made %d requests after the budget was spent, want 1",
			len(reader.calls)-spent)
	}
}

// Past the cap the pass defers to the cache rather than spending the whole
// shared quota on rows nobody is waiting for.
func TestReconcileCapsAnonymousRefreshesPerHour(t *testing.T) {
	reader := &fakeRunner{
		name: SourceAnonymous,
		responses: map[string][]byte{
			"/repos/owner/repo/pulls": []byte(`[]`),
		},
	}
	svc, st := newTestService(t, reader)
	now := time.Unix(1_700_000_000, 0)
	svc.SetClock(func() time.Time { return now })
	seedWatchedTask(t, st, "t")
	ctx := context.Background()

	// Far more stale anonymous rows than the budget allows.
	//
	// Both clocks are set to the same stale instant on purpose: the store stamps
	// an unstamped AttemptedAt from the wall clock, and this test's clock is not
	// the wall clock, so leaving it unset would make the row neither due nor
	// skipped for a reason the test never meant to exercise.
	stale := now.Add(-2 * anonymousFloor).UnixMilli()
	for i := 0; i < 25; i++ {
		if err := st.RecordPRObservation(ctx, store.PRObservation{
			Repo: "github.com/owner/repo", HeadBranch: fmt.Sprintf("b-%d", i), TaskID: "t",
			Number: number(i + 1), State: "open", Source: SourceAnonymous,
			ObservedAt: &stale, AttemptedAt: stale,
		}); err != nil {
			t.Fatal(err)
		}
	}

	n, _ := svc.Reconcile(ctx, 25)
	if n > anonymousBudgetPerHour {
		t.Fatalf("refreshed %d anonymous rows, want at most %d", n, anonymousBudgetPerHour)
	}

	// And the budget is per hour: a fresh window allows more.
	now = now.Add(time.Hour)
	before := len(reader.calls)
	if _, err := svc.Reconcile(ctx, 25); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if len(reader.calls) == before {
		t.Fatal("the budget did not reset after an hour")
	}
}

// A rate-limited read is not retried immediately: the quota refills on GitHub's
// schedule, so a request made during the backoff is spent only to be refused —
// and it is what holds the quota at zero.
func TestRateLimitedAnonymousReadsBackOff(t *testing.T) {
	reader := &fakeRunner{
		name: SourceAnonymous,
		errs: map[string]error{
			"/repos/owner/repo/pulls": fmt.Errorf("%w: GET /repos/owner/repo/pulls", ErrRateLimited),
		},
	}
	svc, _ := newTestService(t, reader)
	now := time.Unix(1_700_000_000, 0)
	svc.SetClock(func() time.Time { return now })
	ctx := context.Background()

	if _, err := svc.Observe(ctx, testTarget()); err == nil {
		t.Fatal("expected the rate-limited attempt to report an error")
	}
	after := len(reader.calls)
	if after == 0 {
		t.Fatal("the first attempt made no request")
	}

	for i := 0; i < 5; i++ {
		now = now.Add(time.Minute)
		if _, err := svc.Observe(ctx, testTarget()); err == nil {
			t.Fatal("expected an error while backing off")
		}
	}
	if got := len(reader.calls); got != after {
		t.Fatalf("%d requests were made during the backoff, want 0", got-after)
	}

	now = now.Add(anonymousRateLimitBackoff)
	if _, err := svc.Observe(ctx, testTarget()); err == nil {
		t.Fatal("expected an error")
	}
	if got := len(reader.calls); got <= after {
		t.Fatal("the backoff never expired")
	}
}

// Installing gh while the daemon runs must not require restarting the daemon on
// the machine: the person who installed it may be holding a phone, and being
// told to go and restart something is the trip this feature exists to avoid.
func TestGHResolutionRetriesAfterAFailure(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "gh")
	t.Setenv(ghPathEnv, bin)

	svc, _ := newTestService(t, &fakeRunner{name: SourceAnonymous})
	svc.ghRetryAfter = time.Time{}
	clock := newTestClock()
	svc.SetClock(clock.Now)

	// Not installed yet.
	if got := svc.Status(); got.Available {
		t.Fatalf("Status reported gh available at %s, which does not exist", bin)
	} else if got.Detail == "" {
		t.Fatal("Status reported gh unavailable without saying why")
	}

	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := svc.Status(); got.Available {
		t.Fatal("Status looked again immediately, so every read is a filesystem scan")
	}

	clock.Advance(ghReprobeInterval)
	if got := svc.Status(); !got.Available {
		t.Fatalf("still reporting gh unavailable after the reprobe interval: %s", got.Detail)
	}
}

// A store failure and an absent workspace are different answers, and rendering
// them the same way shows an empty panel for a broken daemon.
func TestTargetForTaskDistinguishesAbsenceFromFailure(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()

	target, ok, err := svc.TargetForTask(ctx, "no-such-task")
	if err != nil {
		t.Fatalf("a task with no workspace must not be an error: %v", err)
	}
	if ok {
		t.Fatalf("got a target for a task that does not exist: %+v", target)
	}

	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.TargetForTask(ctx, "no-such-task"); err == nil {
		t.Fatal("a closed database was reported as 'this task has no workspace'")
	}
}

// A claim spent on a row that is then skipped is a claim unavailable to a row
// that needed it. The budget is ten an hour, so ten wasted claims idle the
// background pass for the rest of the hour and open-pull-request check state
// goes stale while nothing is actually wrong.
func TestReconcileDoesNotSpendBudgetOnRowsItSkips(t *testing.T) {
	reader := &fakeRunner{
		name:      SourceAnonymous,
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	svc, st := newTestService(t, reader)
	clock := newTestClock()
	svc.SetClock(clock.Now)
	seedWatchedTask(t, st, "t")
	ctx := context.Background()

	// More open rows than the budget, all still fresh. They are examined and
	// skipped, and must cost nothing.
	now := clock.Now().UnixMilli()
	for i := 0; i < anonymousBudgetPerHour+2; i++ {
		if err := st.RecordPRObservation(ctx, store.PRObservation{
			Repo: "github.com/owner/repo", HeadBranch: fmt.Sprintf("fresh-%02d", i), TaskID: "t",
			Number: number(i + 1), State: "open", Source: SourceAnonymous, ObservedAt: &now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.Reconcile(ctx, 25); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	// A stale row arriving afterwards must still get its turn in this window.
	// Stale by both clocks, since a row whose last attempt just failed is
	// deliberately left alone (see due) — that is a different test.
	stale := clock.Now().Add(-2 * anonymousFloor).UnixMilli()
	if err := st.RecordPRObservation(ctx, store.PRObservation{
		Repo: "github.com/owner/repo", HeadBranch: "stale-00", TaskID: "t",
		Number: number(99), State: "open", Source: SourceAnonymous,
		ObservedAt: &stale, AttemptedAt: stale,
	}); err != nil {
		t.Fatal(err)
	}
	n, err := svc.Reconcile(ctx, 25)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if n != 1 {
		t.Fatalf("refreshed %d rows, want the 1 stale row — skipped rows consumed the budget", n)
	}
}

// heldRunner answers pull-request reads from a script, holding the first one open
// until the test releases it. That is how a test puts two callers on the same
// question at the same moment. Everything that is not the pull-request list —
// check runs, commit statuses — answers empty: these tests are about which
// answer reaches the row, not about what the answer contains.
type heldRunner struct {
	mu      sync.Mutex
	pulls   []string // one body per pull-request read, in order
	reads   int      // how many pull-request reads have been served
	entered chan struct{}
	release chan struct{}
}

func (r *heldRunner) Name() string { return SourceAnonymous }

func (r *heldRunner) apiGet(ctx context.Context, path string, query [][2]string) ([]byte, error) {
	if !strings.HasSuffix(path, "/pulls") {
		return []byte(`{}`), nil
	}
	r.mu.Lock()
	index := r.reads
	r.reads++
	r.mu.Unlock()

	if index == 0 && r.entered != nil {
		close(r.entered)
		select {
		case <-r.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if index < len(r.pulls) {
		return []byte(r.pulls[index]), nil
	}
	return []byte(`[]`), nil
}

func (r *heldRunner) pullReads() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reads
}

// The phone and the desktop opening the same task is one question about one
// branch, and it should cost one lookup: a lookup is a request against a quota
// that is not per screen.
func TestTwoCallersAskingTheSameQuestionMakeOneLookup(t *testing.T) {
	reader := &heldRunner{
		pulls:   []string{`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`},
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	svc, _ := newTestService(t, reader)
	ctx := context.Background()
	target := testTarget()

	first := make(chan error, 1)
	go func() {
		_, err := svc.Observe(ctx, target)
		first <- err
	}()
	<-reader.entered

	// The second caller asks while the first question is still open. The release
	// is on a timer so that this call returns either way: waiting for the shared
	// answer, or having asked the question a second time and been answered.
	time.AfterFunc(100*time.Millisecond, func() { close(reader.release) })
	if _, err := svc.Observe(ctx, target); err != nil {
		t.Fatalf("second caller: %v", err)
	}
	if err := <-first; err != nil {
		t.Fatalf("first caller: %v", err)
	}

	if got := reader.pullReads(); got != 1 {
		t.Fatalf("made %d lookups for one question, want 1", got)
	}
}

// A tap and the background pass reading one branch at the same time are
// deliberately not the same question — the tap may spend the anonymous budget and
// the pass's read of a row last answered through gh may not — so both are asked,
// and the row keeps the answer to the question asked last rather than the answer
// that happened to arrive last.
func TestASlowOlderAnswerDoesNotOverwriteANewerOne(t *testing.T) {
	reader := &heldRunner{
		pulls: []string{
			`[{"number":7,"state":"open","head":{"sha":"abc"},"base":{"ref":"main"}}]`,
			`[{"number":9,"state":"closed","head":{"sha":"def"},"base":{"ref":"main"}}]`,
		},
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	svc, st := newTestService(t, reader)
	clock := newTestClock()
	svc.SetClock(clock.Now)
	ctx := context.Background()
	target := testTarget()

	// Asked first, answered last: the shape of a tap, which claims no budget.
	older := make(chan store.PRObservation, 1)
	go func() {
		obs, _ := svc.observe(ctx, target, false)
		older <- obs
	}()
	<-reader.entered

	// Asked second, answered first: the shape of the background pass.
	clock.Advance(2 * time.Second)
	newer, err := svc.observe(ctx, target, true)
	if err != nil {
		t.Fatalf("newer question: %v", err)
	}
	if newer.Number == nil || *newer.Number != 9 {
		t.Fatalf("newer question answered %v, want pull request 9", newer.Number)
	}

	close(reader.release)
	stale := <-older
	if stale.Number == nil || *stale.Number != 9 {
		t.Fatalf("the older caller was handed %v, want the row's newer answer", stale.Number)
	}

	row, _, err := st.GetPRObservation(ctx, "github.com/owner/repo", target.Branch)
	if err != nil {
		t.Fatal(err)
	}
	if row.Number == nil || *row.Number != 9 || row.State != "closed" {
		t.Fatalf("row = %+v, want the newer question's answer", row)
	}
	if want := clock.Now().UnixMilli(); row.ObservedAt == nil || *row.ObservedAt != want {
		t.Fatalf("observed_at = %v, want the time the question was asked (%d)", row.ObservedAt, want)
	}
}

func number(n int) *int { return &n }

// A nil slice marshals to `null`, and the console types this field as an array.
// The drift is invisible until something calls a method on it, which is the
// worst time to find out.
func TestSnapshotSerialisesObservationsAsAnArray(t *testing.T) {
	svc, _ := newTestService(t, &fakeRunner{name: SourceAnonymous})
	snap, err := svc.SnapshotForTask(context.Background(), "no-such-task", false)
	if err != nil {
		t.Fatalf("SnapshotForTask: %v", err)
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"observations":null`) {
		t.Fatalf("observations serialised as null: %s", raw)
	}
	if !strings.Contains(string(raw), `"observations":[]`) {
		t.Fatalf("observations is not an empty array: %s", raw)
	}
}

// The notice describes the card the console leads with. Gating it on gh's
// availability instead would silently drop it whenever the CLI is present but
// the answer still came from the anonymous reader.
func TestAnonymousNoticeFollowsTheLeadRowNotGHAvailability(t *testing.T) {
	svc, _ := newTestService(t, &fakeRunner{name: SourceAnonymous})
	observed := time.Now().UnixMilli()

	anon := store.PRObservation{
		Repo: "github.com/owner/repo", HeadBranch: "kin/task/1/g1", TaskID: "t1",
		Source: SourceAnonymous, ObservedAt: &observed,
	}
	snap := Snapshot{GH: GHStatus{Available: true}, Branch: "kin/task/1/g1",
		Observations: []store.PRObservation{anon}}
	svc.applyAnonymousNotice(&snap)
	if snap.Notice != anonymousNotice {
		t.Fatalf("notice = %q, want the anonymous explanation", snap.Notice)
	}

	// A different branch's anonymous row says nothing about this branch's
	// answer, so it must not be reported as if it did.
	gh := anon
	gh.HeadBranch = "kin/task/1/g2"
	gh.Source = SourceGH
	snap = Snapshot{GH: GHStatus{Available: true}, Branch: "kin/task/1/g2",
		Observations: []store.PRObservation{gh, anon}}
	svc.applyAnonymousNotice(&snap)
	if snap.Notice != "" {
		t.Fatalf("notice = %q, want none for a gh-sourced lead row", snap.Notice)
	}

	// With nothing read at all there is nothing to explain.
	snap = Snapshot{GH: GHStatus{Available: true}, Observations: []store.PRObservation{}}
	svc.applyAnonymousNotice(&snap)
	if snap.Notice != "" {
		t.Fatalf("notice = %q, want none with no observations", snap.Notice)
	}
}

// A failed attempt belongs to a row, and the row is where the console prints it
// — next to the pull-request number it failed to refresh. Copying the same
// sentence into the snapshot notice printed it twice on a phone: once as a grey
// banner, once as the red line under the card.
func TestSnapshotKeepsAFailedAttemptOnItsRowNotInTheNotice(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	branch := seedTaskWithWorkspace(t, st, "t1")

	now := time.Now().UnixMilli()
	if err := st.RecordPRObservation(ctx, store.PRObservation{
		Repo: "github.com/owner/repo", HeadBranch: branch, TaskID: "t1",
		Number: number(7), State: "open", Source: SourceGH, ObservedAt: &now,
	}); err != nil {
		t.Fatal(err)
	}
	// Then the branch query failed. A failure is recorded on its own path
	// precisely so that it cannot erase the number it failed to refresh.
	if err := st.RecordPRFailure(ctx, "github.com/owner/repo", branch, "t1",
		"gh: not found or not visible", time.Now()); err != nil {
		t.Fatal(err)
	}

	snap, err := svc.SnapshotForTask(ctx, "t1", false)
	if err != nil {
		t.Fatalf("SnapshotForTask: %v", err)
	}
	if snap.Notice != "" {
		t.Fatalf("notice = %q, want the failure to stay on its row", snap.Notice)
	}
	if len(snap.Observations) != 1 {
		t.Fatalf("got %d observations, want 1", len(snap.Observations))
	}
	lead := snap.Observations[0]
	if lead.LastError != "gh: not found or not visible" || lead.Number == nil || *lead.Number != 7 {
		t.Fatalf("row = %+v, want the failure alongside the number it failed to refresh", lead)
	}
}

// seedTaskWithWorkspace gives a task a current workspace generation on a
// checkout whose origin names github.com/owner/repo, so TargetForTask resolves,
// and returns the generation's branch.
func seedTaskWithWorkspace(t *testing.T, st *store.Store, taskID string) string {
	t.Helper()
	ctx := context.Background()
	// RepoForDir reads the remote with real git, the same way the daemon does.
	dir := initRepoWithOrigin(t, "git@github.com:owner/repo.git")
	if err := st.InsertTask(ctx, store.Task{
		ID: taskID, Title: "pr", Agent: "kin", Cwd: dir, Prompt: "pr",
		Status: "running", CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	branch := fmt.Sprintf("kin/task/%s/g1", taskID)
	if err := st.InsertWorkspace(ctx, store.WorkspaceGeneration{
		ID: taskID + "-w1", TaskID: taskID, Generation: 1, State: "ready",
		SourceRoot: dir, Scope: ".", WorkspaceBranch: branch,
		TargetBranch: "main",
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetCurrentWorkspace(ctx, taskID, taskID+"-w1"); err != nil {
		t.Fatal(err)
	}
	return branch
}

// initRepoWithOrigin makes a directory git will recognise as a checkout of the
// given remote.
func initRepoWithOrigin(t *testing.T, origin string) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "--quiet"},
		{"remote", "add", "origin", origin},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("git %s: %v (%s)", strings.Join(args, " "), err, out)
		}
	}
	return dir
}
