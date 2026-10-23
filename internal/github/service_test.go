package github

import (
	"context"
	"errors"
	"fmt"
	"os"
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

// The read path must never wait on the network: a `gh` lookup costs seconds, and
// a panel that blocks on it is unusable. The first look returns immediately with
// "not known yet" and the query runs behind the request.
func TestEnsureFreshDoesNotBlockOnTheNetwork(t *testing.T) {
	release := make(chan struct{})
	reader := &fakeRunner{
		name: SourceAnonymous,
		onCall: func(string) {
			<-release
		},
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	svc, _ := newTestService(t, reader)
	target := testTarget()

	start := time.Now()
	obs, err := svc.EnsureFresh(context.Background(), target)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("EnsureFresh: %v", err)
	}
	if elapsed > time.Second {
		t.Fatalf("EnsureFresh blocked for %s", elapsed)
	}
	if obs.ObservedAt != nil {
		t.Fatal("returned an observation that cannot exist yet")
	}
	if !svc.refreshing(target) {
		t.Fatal("no refresh was started for a branch that has never been read")
	}

	// Let the background query finish and confirm it actually wrote.
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for svc.refreshing(target) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if svc.refreshing(target) {
		t.Fatal("background refresh never finished")
	}
	obs, err = svc.EnsureFresh(context.Background(), target)
	if err != nil {
		t.Fatalf("second EnsureFresh: %v", err)
	}
	if obs.ObservedAt == nil {
		t.Fatal("the background refresh recorded nothing")
	}
	if obs.Number != nil {
		t.Fatalf("number = %v, want nil for an empty answer", obs.Number)
	}
	if obs.Source != SourceAnonymous {
		t.Fatalf("source = %q", obs.Source)
	}
}

// Repeated views while a query is in flight must join it, not start another.
func TestConcurrentViewsShareOneRefresh(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	reader := &fakeRunner{
		name: SourceAnonymous,
		onCall: func(string) {
			mu.Lock()
			calls++
			mu.Unlock()
			<-release
		},
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	svc, _ := newTestService(t, reader)
	target := testTarget()

	for i := 0; i < 5; i++ {
		if _, err := svc.EnsureFresh(context.Background(), target); err != nil {
			t.Fatalf("EnsureFresh %d: %v", i, err)
		}
	}
	close(release)

	mu.Lock()
	got := calls
	mu.Unlock()
	if got != 1 {
		t.Fatalf("five views started %d queries, want 1", got)
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

// The blocker this suite previously missed: a branch whose read always fails has
// no observation time and never will, so a floor keyed on the observation alone
// starts a query per view. That is one anonymous request per view against a
// quota of sixty an hour, shared with everything else on the machine's address.
func TestEnsureFreshDoesNotRequeriesAPermanentlyFailingBranch(t *testing.T) {
	reader := &fakeRunner{
		name: SourceAnonymous,
		errs: map[string]error{
			"/repos/owner/repo/pulls": errors.New("404: not found or not visible"),
		},
	}
	svc, _ := newTestService(t, reader)
	clock := newTestClock()
	svc.SetClock(clock.Now)
	ctx := context.Background()
	target := testTarget()

	// The first look has nothing cached, so it may query.
	if _, err := svc.EnsureFresh(ctx, target); err != nil {
		t.Fatalf("EnsureFresh: %v", err)
	}
	waitForRefresh(t, svc, target)
	afterFirst := len(reader.calls)
	if afterFirst == 0 {
		t.Fatal("the first look made no query at all")
	}
	// Precondition: the row exists and has never been observed, which is the
	// state a floor keyed on the observation cannot see.
	cached, ok, err := svc.store.GetPRObservation(ctx, target.Repo.Canonical(), target.Branch)
	if err != nil || !ok {
		t.Fatalf("expected a row after a failed attempt: ok=%v err=%v", ok, err)
	}
	if cached.ObservedAt != nil {
		t.Fatal("a failed attempt wrote an observation timestamp")
	}

	// Every view inside the failure floor must be served from the cache.
	//
	// The assertion is on `refreshing`, which refreshAsync sets synchronously
	// under the mutex before returning, rather than on the reader's call count,
	// which is written by the background goroutine and would be a race.
	for i := 0; i < 20; i++ {
		clock.Advance(10 * time.Second)
		if _, err := svc.EnsureFresh(ctx, target); err != nil {
			t.Fatalf("EnsureFresh %d: %v", i, err)
		}
		if svc.refreshing(target) {
			t.Fatalf("view %d started a query for a permanently failing branch", i)
		}
	}
	if got := len(reader.calls); got != afterFirst {
		t.Fatalf("%d extra queries from 20 views of a permanently failing branch, want 0", got-afterFirst)
	}

	// Past the failure floor it is worth asking again: the reason may have been
	// fixed.
	clock.Advance(failureFloor)
	if _, err := svc.EnsureFresh(ctx, target); err != nil {
		t.Fatalf("EnsureFresh past the floor: %v", err)
	}
	waitForRefresh(t, svc, target)
	if got := len(reader.calls); got <= afterFirst {
		t.Fatalf("no query after the failure floor elapsed (%d calls)", got)
	}
}

// An anonymous answer costs a shared quota, so it is held longer than one read
// through the user's own credentials.
func TestEnsureFreshHonoursTheAnonymousFloor(t *testing.T) {
	reader := &fakeRunner{
		name:      SourceAnonymous,
		responses: map[string][]byte{"/repos/owner/repo/pulls": []byte(`[]`)},
	}
	svc, _ := newTestService(t, reader)
	clock := newTestClock()
	svc.SetClock(clock.Now)
	ctx := context.Background()
	target := testTarget()

	if _, err := svc.EnsureFresh(ctx, target); err != nil {
		t.Fatalf("EnsureFresh: %v", err)
	}
	waitForRefresh(t, svc, target)
	baseline := len(reader.calls)
	if baseline == 0 {
		t.Fatal("no query was made")
	}

	// Six steps at the authenticated cadence, staying inside the anonymous
	// floor. Were the authenticated floor being applied, each would be a query.
	// Asserted on `refreshing` rather than the reader's call count, which the
	// background goroutine writes.
	for i := 0; i < 6; i++ {
		clock.Advance(authenticatedFloor)
		if _, err := svc.EnsureFresh(ctx, target); err != nil {
			t.Fatalf("EnsureFresh %d: %v", i, err)
		}
		if svc.refreshing(target) {
			t.Fatalf("step %d re-queried inside the anonymous floor", i)
		}
	}
	if got := len(reader.calls); got != baseline {
		t.Fatalf("%d extra queries inside the anonymous floor, want 0", got-baseline)
	}

	// Once the floor really has elapsed, the next look refreshes.
	clock.Advance(anonymousFloor)
	if _, err := svc.EnsureFresh(ctx, target); err != nil {
		t.Fatalf("EnsureFresh past the floor: %v", err)
	}
	waitForRefresh(t, svc, target)
	if got := len(reader.calls); got <= baseline {
		t.Fatal("the anonymous floor never expired")
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
	ctx := context.Background()

	// Far more stale anonymous rows than the budget allows.
	stale := now.Add(-2 * anonymousFloor).UnixMilli()
	for i := 0; i < 25; i++ {
		if err := st.RecordPRObservation(ctx, store.PRObservation{
			Repo: "github.com/owner/repo", HeadBranch: fmt.Sprintf("b-%d", i), TaskID: "t",
			Number: number(i + 1), State: "open", Source: SourceAnonymous, ObservedAt: &stale,
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
	stale := clock.Now().Add(-2 * anonymousFloor).UnixMilli()
	if err := st.RecordPRObservation(ctx, store.PRObservation{
		Repo: "github.com/owner/repo", HeadBranch: "stale-00", TaskID: "t",
		Number: number(99), State: "open", Source: SourceAnonymous, ObservedAt: &stale,
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

// waitForRefresh blocks until any background query for a target has finished, so
// assertions about query counts are not racing the goroutine.
func waitForRefresh(t *testing.T, svc *Service, target Target) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for svc.refreshing(target) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if svc.refreshing(target) {
		t.Fatal("background refresh never finished")
	}
}

func number(n int) *int { return &n }
