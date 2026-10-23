package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// Cache floors, by which credential answers.
//
// The two are not the same budget. An authenticated read gets thousands of
// requests an hour; an anonymous one gets sixty, shared by everything else on
// the machine's address. Polling a public repository at the authenticated
// cadence after a gh login expires would exhaust the anonymous quota and turn a
// degraded-but-working feature into a failing one — so the anonymous floor has
// to be long enough that a handful of open pull requests stays inside it.
const (
	// authenticatedFloor is how long an answer read through gh is served as is.
	authenticatedFloor = 3 * time.Minute
	// anonymousFloor is the same for a credential-free read.
	anonymousFloor = 20 * time.Minute
	// failureFloor is how long a pair whose read has never succeeded is left
	// alone. It exists because such a pair has no observation time at all and
	// never will: a private repository answers 404 to an anonymous reader no
	// matter how often it is asked. A floor keyed only on the observation would
	// therefore put a fresh query behind every view of it — one request per view,
	// which is what exhausts the shared quota — so the attempt time is the clock
	// that applies.
	failureFloor = 5 * time.Minute
)

// anonymousBudgetPerHour caps how many anonymous lookups the background pass may
// start in an hour.
//
// Sixty requests an hour is the whole anonymous quota, one lookup costs two or
// three, and the budget is shared with every other tool on the machine. A pass
// that spends whatever its row count implies would consume all of it and leave
// nothing for the reads a person is actually waiting on — so it is capped, and
// past the cap the cache serves what it has and the console offers a refresh.
const anonymousBudgetPerHour = 10

// anonymousRateLimitBackoff is how long the anonymous reader is left alone after
// GitHub says the quota is gone.
//
// Without it a rate-limited pass keeps re-issuing a request per row per tick:
// futile, and it is what holds the quota at zero. The window is the quota's own
// order of magnitude rather than a retry curve, because an hourly bucket does
// not refill faster for being asked politely.
const anonymousRateLimitBackoff = 15 * time.Minute

// ghReprobeInterval is how long gh is left alone after it was found missing or
// unusable, before it is looked for again.
//
// It covers two cases with the same answer. An unauthenticated gh does not cost
// a process spawn per refresh, and `gh auth login` in another terminal is picked
// up without restarting the daemon. gh that is not installed yet is noticed the
// same way, which matters when the person who installed it is holding a phone
// and cannot restart the daemon to make Kin see it.
const ghReprobeInterval = 5 * time.Minute

// refreshTimeout bounds one detached refresh. It is longer than the gh client's
// own timeout so the client is the thing that gives up first, with a better
// error than a bare context deadline.
const refreshTimeout = 2 * time.Minute

// Target is the pair this package observes: a branch of a repository, on behalf
// of a task.
type Target struct {
	TaskID string
	Repo   Repo
	Branch string
}

// GHStatus describes whether the preferred credential source is usable, so the
// console can explain an anonymous read instead of silently degrading.
type GHStatus struct {
	Available bool   `json:"available"`
	Detail    string `json:"detail,omitempty"`
}

// Snapshot is everything the console needs to render the pull-request area of a
// task.
type Snapshot struct {
	Observations []store.PRObservation `json:"observations"`
	Repo         string                `json:"repo,omitempty"`
	Branch       string                `json:"branch,omitempty"`
	GH           GHStatus              `json:"gh"`
	// Refreshing says a query is in flight for this branch, so the console can
	// show that the answer below may be about to change. Without it, a first
	// look at an unpublished branch would render "no pull request" while the
	// question was still open — asserting something not yet checked.
	Refreshing bool `json:"refreshing"`
	// Notice explains a degraded read in one sentence, or is empty.
	Notice string `json:"notice,omitempty"`
}

// Service reads pull-request state and caches it.
type Service struct {
	store    *store.Store
	resolver workspace.AnchorResolver
	// anon is the credential-free reader. Held as the interface so tests can
	// substitute a transport and exercise the whole observe path offline.
	anon apiRunner

	// now is injectable so tests do not depend on wall-clock timing.
	now func() time.Time

	mu       sync.Mutex
	ghClient *GHClient
	// ghRetryAfter is when a failed gh resolution may be attempted again.
	ghRetryAfter time.Time
	ghBroken     time.Time
	ghReason     string
	inFlight     map[string]struct{}

	// anonLimitedUntil is when the anonymous reader may be tried again after the
	// quota ran out, and the two fields below are the background pass's hourly
	// anonymous budget.
	anonLimitedUntil time.Time
	anonWindow       time.Time
	anonUsed         int
}

// NewService builds the service with the machine's own credentials.
func NewService(st *store.Store) *Service {
	return &Service{
		store:    st,
		resolver: workspace.NewAnchorResolver(),
		anon:     newHTTPReader(),
		now:      time.Now,
	}
}

// SetClock replaces the time source. Tests only.
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// ---------------------------------------------------------------------------
// Credential selection
// ---------------------------------------------------------------------------

// resolveLocked makes a resolution attempt, if one is due.
//
// A failed resolution is deliberately not permanent. Marking it so would leave
// the console saying "no usable gh CLI found" for the life of the process, and
// the only cure would be restarting the daemon on the machine — precisely the
// trip to the desk that reading pull requests from a phone is meant to avoid.
// The caller holds mu.
func (s *Service) resolveLocked() {
	if s.ghClient != nil {
		return
	}
	if !s.ghRetryAfter.IsZero() && s.now().Before(s.ghRetryAfter) {
		return
	}
	if bin, err := ResolveGH(); err == nil {
		s.ghClient = &GHClient{Bin: bin}
		s.ghReason = ""
		return
	} else {
		s.ghReason = err.Error()
	}
	s.ghRetryAfter = s.now().Add(ghReprobeInterval)
}

// ghReaderFor returns the gh-backed reader, or nil when gh is absent or was
// recently found unusable.
func (s *Service) ghReaderFor() *GHClient {
	if !s.ghUsable() {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ghClient
}

// ghUsable reports whether the gh-backed reader would answer a query made now.
func (s *Service) ghUsable() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.resolveLocked()
	return s.ghClient != nil && (s.ghBroken.IsZero() || !s.now().Before(s.ghBroken))
}

// nextReadIsAnonymous reports whether the next query for a row will fall through
// to the credential-free reader.
//
// The row records which source answered last time, but what the next attempt
// will spend is decided by what is usable now: a machine whose login expired
// reads anonymously whatever the last successful answer came from.
func (s *Service) nextReadIsAnonymous(source string) bool {
	return source == SourceAnonymous || !s.ghUsable()
}

// floorFor is how long a row is served from cache before another query is worth
// making.
func (s *Service) floorFor(source string) time.Duration {
	if s.nextReadIsAnonymous(source) {
		return anonymousFloor
	}
	return authenticatedFloor
}

// noteAnonymousOutcome remembers that the shared quota is spent, so the next few
// attempts are not made only to be refused.
func (s *Service) noteAnonymousOutcome(err error) {
	if !errors.Is(err, ErrRateLimited) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.anonLimitedUntil = s.now().Add(anonymousRateLimitBackoff)
}

// anonymousBackoffRemaining reports how long the anonymous reader is benched for,
// or zero if it may be tried.
func (s *Service) anonymousBackoffRemaining() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.anonLimitedUntil.Sub(s.now())
}

// claimAnonymousBudget reports whether the background pass may spend one
// anonymous lookup now, and records it if so.
func (s *Service) claimAnonymousBudget(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.anonWindow.IsZero() || now.Sub(s.anonWindow) >= time.Hour {
		s.anonWindow = now
		s.anonUsed = 0
	}
	if s.anonUsed >= anonymousBudgetPerHour {
		return false
	}
	s.anonUsed++
	return true
}

// noteGHFailure remembers a credential failure so the next few refreshes skip
// straight to the fallback.
func (s *Service) noteGHFailure(err error) {
	if !errors.Is(err, ErrNotAuthenticated) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ghBroken = s.now().Add(ghReprobeInterval)
	s.ghReason = err.Error()
}

// Status reports whether the preferred source is usable right now.
//
// It resolves gh first. Reporting "not found" before having looked would be the
// same class of mistake this package exists to avoid — asserting something it
// has not checked — and the console would show a working machine as broken
// until the first read happened to correct it.
func (s *Service) Status() GHStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.resolveLocked()
	switch {
	case s.ghClient != nil && (s.ghBroken.IsZero() || !s.now().Before(s.ghBroken)):
		return GHStatus{Available: true}
	default:
		return GHStatus{Available: false, Detail: s.ghReason}
	}
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// query asks the preferred source, then the fallback.
//
// gh is preferred because it is the user's own authenticated identity and sees
// private repositories. The anonymous fallback answers for public repositories
// with no credential at all, which is what keeps this feature working on a
// machine whose gh login has expired — a state that has to be ordinary, because
// it is the state of the machine this was written on.
func (s *Service) query(ctx context.Context, repo Repo, branch string) (LookupResult, error) {
	var ghErr error
	if client := s.ghReaderFor(); client != nil {
		res, err := lookup(ctx, ghReader{client: *client}, repo, branch)
		if err == nil {
			return res, nil
		}
		ghErr = err
		s.noteGHFailure(err)
	}

	// An exhausted quota refills on GitHub's schedule, not on this loop's, so a
	// request made during the backoff is spent only to be refused.
	var anonErr error
	if remaining := s.anonymousBackoffRemaining(); remaining > 0 {
		anonErr = fmt.Errorf("%w: backing off for another %s", ErrRateLimited, remaining.Round(time.Second))
	} else {
		var res LookupResult
		res, anonErr = lookup(ctx, s.anon, repo, branch)
		if anonErr == nil {
			return res, nil
		}
		s.noteAnonymousOutcome(anonErr)
	}
	if ghErr != nil {
		return LookupResult{}, fmt.Errorf("%w: gh: %w; anonymous: %w", errBothFailed, ghErr, anonErr)
	}
	return LookupResult{}, fmt.Errorf("%w: anonymous: %w", errBothFailed, anonErr)
}

// Observe refreshes one target and returns the best state known afterwards.
//
// The returned observation is current even when the error is non-nil: a failed
// attempt leaves the previous successful answer in place, and the caller is
// expected to render that answer alongside the error rather than instead of it.
func (s *Service) Observe(ctx context.Context, t Target) (store.PRObservation, error) {
	key := t.Repo.Canonical()
	result, err := s.query(ctx, t.Repo, t.Branch)
	if err != nil {
		if recErr := s.store.RecordPRFailure(ctx, key, t.Branch, t.TaskID, err.Error()); recErr != nil {
			return store.PRObservation{}, recErr
		}
		cached, _, getErr := s.store.GetPRObservation(ctx, key, t.Branch)
		if getErr != nil {
			return store.PRObservation{}, getErr
		}
		cached.Repo, cached.HeadBranch, cached.TaskID = key, t.Branch, t.TaskID
		return cached, err
	}
	if err := s.record(ctx, t, result); err != nil {
		return store.PRObservation{}, err
	}
	obs, _, err := s.store.GetPRObservation(ctx, key, t.Branch)
	if err != nil {
		return store.PRObservation{}, err
	}
	return obs, nil
}

// record turns one successful answer into a row.
//
// A successful answer with no pull request writes Number as NULL. That is not
// an erasure: it is a newer successful observation superseding an older one, and
// it is the only thing allowed to do so.
func (s *Service) record(ctx context.Context, t Target, res LookupResult) error {
	obs := store.PRObservation{
		Repo:       t.Repo.Canonical(),
		HeadBranch: t.Branch,
		TaskID:     t.TaskID,
		Source:     res.Source,
	}
	if pr := res.PR; pr != nil {
		obs.Number = pr.Number
		obs.URL = pr.URL
		obs.Title = pr.Title
		obs.State = pr.State
		obs.IsDraft = pr.IsDraft
		obs.BaseBranch = pr.BaseBranch
		obs.HeadOID = pr.HeadOID
		obs.CIState = pr.CI.State
		if summary, err := json.Marshal(pr.CI); err == nil {
			obs.CISummary = string(summary)
		}
	}
	return s.store.RecordPRObservation(ctx, obs)
}

// EnsureFresh serves the cache, and when it is stale starts a refresh *behind*
// the request rather than inside it.
//
// Reading pull-request state costs two or three `gh` invocations, and a single
// one measures around three seconds on a normal connection — so doing it inline
// would make opening a panel take the better part of ten seconds. The read path
// is therefore a cache read, and fetching belongs to the reconciler, which is
// what the design asks for: one bounded background pass, not a query per view.
func (s *Service) EnsureFresh(ctx context.Context, t Target) (store.PRObservation, error) {
	cached, ok, err := s.store.GetPRObservation(ctx, t.Repo.Canonical(), t.Branch)
	if err != nil {
		return store.PRObservation{}, err
	}
	if ok && !s.dueForRefresh(cached, s.now()) {
		return cached, nil
	}
	s.refreshAsync(t)
	if !ok {
		// Never observed: return the identity so the caller can render "not
		// known yet" rather than an error.
		return store.PRObservation{Repo: t.Repo.Canonical(), HeadBranch: t.Branch, TaskID: t.TaskID}, nil
	}
	return cached, nil
}

// dueForRefresh reports whether a cached row is old enough to be worth another
// query.
//
// It consults the attempt time as well as the observation time, because those
// are different clocks and one of them can be permanently absent. A pair whose
// every read has failed has no observation at all — that is the standing state
// of a private repository read without a credential, and of a host with no
// route to the forge — and gating only on the observation would start a query
// per view for a question whose answer has not changed and cannot change until
// the user does something. That is one request per view against a quota of sixty
// an hour, shared.
func (s *Service) dueForRefresh(o store.PRObservation, now time.Time) bool {
	floor := s.floorFor(o.Source)
	attemptAge := now.Sub(time.UnixMilli(o.AttemptedAt))
	if o.ObservedAt == nil {
		return attemptAge >= failureFloor
	}
	if now.Sub(time.UnixMilli(*o.ObservedAt)) < floor {
		return false
	}
	// The answer has aged out, but the attempt clock still applies: a refresh
	// that just failed must not be immediately retried by the next view.
	return attemptAge >= floor
}

// refreshAsync starts a background query for one target, unless one is already
// running for it.
//
// The in-flight set is what keeps a page that polls every few seconds from
// stacking queries: the second and later requests join the first rather than
// starting their own.
func (s *Service) refreshAsync(t Target) {
	key := t.Repo.Canonical() + "\x00" + t.Branch

	s.mu.Lock()
	if s.inFlight == nil {
		s.inFlight = map[string]struct{}{}
	}
	if _, running := s.inFlight[key]; running {
		s.mu.Unlock()
		return
	}
	s.inFlight[key] = struct{}{}
	s.mu.Unlock()

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.inFlight, key)
			s.mu.Unlock()
		}()
		// Detached from the request that asked for it: a client navigating away
		// must not cancel a query whose answer the next client will want. The
		// gh client applies its own timeout.
		ctx, cancel := context.WithTimeout(context.Background(), refreshTimeout)
		defer cancel()
		_, _ = s.Observe(ctx, t)
	}()
}

// refreshing reports whether a background query is running for a target.
func (s *Service) refreshing(t Target) bool {
	key := t.Repo.Canonical() + "\x00" + t.Branch
	s.mu.Lock()
	defer s.mu.Unlock()
	_, running := s.inFlight[key]
	return running
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

// TargetForTask resolves the repository and branch a task's current workspace
// generation is on.
//
// The repository is derived from the generation's source root, which is the
// checkout the worktree was cut from and therefore the one whose origin remote
// names the repository.
func (s *Service) TargetForTask(ctx context.Context, taskID string) (Target, bool, error) {
	gen, err := s.store.GetCurrentWorkspace(ctx, taskID)
	if errors.Is(err, store.ErrNotFound) {
		return Target{}, false, nil
	}
	if err != nil {
		// A task with no workspace is ordinary; a database that cannot be read
		// is not, and rendering the two the same way would show an empty panel
		// for a broken daemon.
		return Target{}, false, fmt.Errorf("current workspace for %s: %w", taskID, err)
	}
	if gen.WorkspaceBranch == "" {
		return Target{}, false, nil
	}
	dir := gen.SourceRoot
	if dir == "" {
		dir = gen.ExecutionCwd
	}
	repo, ok, err := RepoForDir(ctx, s.resolver, dir)
	if err != nil || !ok {
		return Target{}, false, err
	}
	return Target{TaskID: taskID, Repo: repo, Branch: gen.WorkspaceBranch}, true, nil
}

// SnapshotForTask returns the cached observations for a task, refreshing the
// current branch when asked to or when the cache is stale.
//
// A task that is not on a GitHub repository, or has no workspace yet, gets an
// empty snapshot rather than an error: having no pull request is the normal
// state of a session that has not been published.
func (s *Service) SnapshotForTask(ctx context.Context, taskID string, force bool) (Snapshot, error) {
	snap := Snapshot{GH: s.Status()}

	target, ok, err := s.TargetForTask(ctx, taskID)
	if err != nil {
		return snap, err
	}
	if !ok {
		observations, err := s.store.ListPRObservationsByTask(ctx, taskID)
		if err != nil {
			return snap, err
		}
		snap.Observations = observations
		return snap, nil
	}
	snap.Repo = target.Repo.Canonical()
	snap.Branch = target.Branch

	if force {
		// The explicit refresh waits: the user asked for an answer and is
		// watching for it, and returning the stale one instead would look like
		// the button did nothing.
		if _, err := s.Observe(ctx, target); err != nil {
			snap.Notice = err.Error()
		}
	} else {
		cached, err := s.EnsureFresh(ctx, target)
		if err != nil {
			return snap, err
		}
		// A previous attempt's failure is worth surfacing even though the read
		// itself succeeded: the row below may be older than it looks.
		if cached.LastError != "" {
			snap.Notice = cached.LastError
		}
		snap.Refreshing = s.refreshing(target)
	}

	observations, err := s.store.ListPRObservationsByTask(ctx, taskID)
	if err != nil {
		return snap, err
	}
	snap.Observations = observations
	if !snap.GH.Available && len(observations) > 0 && observations[0].Source == SourceAnonymous {
		snap.Notice = joinNotice(snap.Notice, anonymousNotice)
	}
	return snap, nil
}

const anonymousNotice = "reading public data without credentials; " +
	"sign in with the GitHub CLI to see private repositories"

func joinNotice(a, b string) string {
	switch {
	case a == "":
		return b
	case b == "":
		return a
	default:
		return a + "; " + b
	}
}

// ---------------------------------------------------------------------------
// Background pass
// ---------------------------------------------------------------------------

// Reconcile refreshes up to limit open pull requests, oldest attempt first, and
// reports how many it refreshed.
//
// This is the only background polling this package does. A branch with no pull
// request has nothing that changes on its own — only the user can create one —
// so polling those in the background would spend rate limit re-learning a fact
// that cannot have moved. Open pull requests are few, and their checks change
// while nobody is looking, which is exactly what a background pass is for.
//
// Anonymous rows are additionally bounded by a shared hourly budget. The floor
// alone is not enough: twenty minutes times a batch of twenty-five is already
// more requests an hour than the anonymous quota contains, and the pass would
// discover that by spending the whole thing.
func (s *Service) Reconcile(ctx context.Context, limit int) (int, error) {
	open, err := s.store.ListOpenPRObservations(ctx, limit)
	if err != nil {
		return 0, err
	}
	now := s.now()
	var refreshed int
	var firstErr error
	for _, obs := range open {
		if ctx.Err() != nil {
			return refreshed, ctx.Err()
		}
		anonymous := s.nextReadIsAnonymous(obs.Source)
		if anonymous && s.anonymousBackoffRemaining() > 0 {
			continue
		}
		if obs.Fresh(now, s.floorFor(obs.Source)) {
			continue
		}
		repo, ok := ParseCanonical(obs.Repo)
		if !ok {
			continue
		}
		// Claimed last, once the row is known to be worth a query. A claim spent
		// on a row that is then skipped is a claim unavailable to a row that
		// needed it, and the budget is small enough that ten wasted claims idle
		// the pass for the rest of the hour.
		if anonymous && !s.claimAnonymousBudget(now) {
			continue
		}
		if _, err := s.Observe(ctx, Target{TaskID: obs.TaskID, Repo: repo, Branch: obs.HeadBranch}); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		refreshed++
	}
	return refreshed, firstErr
}
