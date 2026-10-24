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
	// Notice explains a degraded read in one sentence, or is empty. It is about
	// the read, never about a row: a failed attempt is reported by that row's
	// own last_error, next to the data it explains, and copying it here printed
	// the same sentence twice.
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

	// anonLimitedUntil is when the anonymous reader may be tried again after the
	// quota ran out, and the two fields below are the background pass's hourly
	// anonymous budget.
	anonLimitedUntil time.Time
	anonWindow       time.Time
	anonUsed         int

	// inflight holds the questions being asked right now, so that a second
	// caller asking the same one waits for it instead of paying for it again.
	// Guarded by mu; never held across a query.
	inflight map[observeKey]*inflight
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

// errBudgetSpent means the anonymous hour is used up, so the attempt was not
// made. It is deliberately distinct from a failed lookup: nothing was asked, so
// there is no failure to record on the row and nothing for a user to read.
var errBudgetSpent = errors.New("anonymous budget for this hour is spent")

// query asks the preferred source, then the fallback.
//
// gh is preferred because it is the user's own authenticated identity and sees
// private repositories. The anonymous fallback answers for public repositories
// with no credential at all, which is what keeps this feature working on a
// machine whose gh login has expired — a state that has to be ordinary, because
// it is the state of the machine this was written on.
//
// The budget is claimed where the anonymous request is actually made, not where
// the caller predicted it would be. The two are not the same decision: a row
// whose last answer came through gh falls back to anonymous the moment gh stops
// working — an expired login, a rate limit, a repository that went private — and
// a claim made on the way in, against the row's recorded source, would let every
// such fallback through uncharged. That is how a pass spends a sixty-request
// hour without ever deciding to.
func (s *Service) query(ctx context.Context, repo Repo, branch string, maySpendAnonymous bool) (LookupResult, error) {
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
	} else if maySpendAnonymous && !s.claimAnonymousBudget(s.now()) {
		anonErr = errBudgetSpent
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
//
// This is the path a user's tap takes, so it is not charged against the
// background pass's anonymous budget: that budget exists to stop the pass
// spending without anyone watching, and a tap is someone watching.
func (s *Service) Observe(ctx context.Context, t Target) (store.PRObservation, error) {
	return s.observe(ctx, t, false)
}

// observeKey identifies a question rather than a row: the same branch asked about
// by a caller who may spend the anonymous budget is a different question from the
// same branch asked about by one who may not.
type observeKey struct {
	repo, branch string
	maySpend     bool
}

// inflight is a question being asked right now. The caller who asks it publishes
// the answer by closing done, and everyone waiting on that channel reads the two
// fields below after it closes.
type inflight struct {
	done        chan struct{}
	observation store.PRObservation
	err         error
}

// observe is Observe with the background pass's budget attached.
//
// Callers asking the question that is already in flight wait for that answer
// instead of asking it again. Two clients opening the same task at the same
// moment is one question about one branch, and it should cost one lookup: the
// phone and the desktop are both looking at the same pull request, and a lookup
// is a request against a quota that is not per screen. Sharing the answer also
// shares its askedAt, so the pair cannot write the row out of order — and the two
// questions that legitimately differ here, a tap and the background pass, are the
// pair the store's write ordering exists to keep straight.
func (s *Service) observe(ctx context.Context, t Target, maySpendAnonymous bool) (store.PRObservation, error) {
	key := observeKey{repo: t.Repo.Canonical(), branch: t.Branch, maySpend: maySpendAnonymous}
	call, leader := s.claimObserve(key)
	if !leader {
		// The wait is on this caller's context: a client that has gone away does
		// not have to sit out a lookup it is no longer waiting for.
		select {
		case <-call.done:
			return call.observation, call.err
		case <-ctx.Done():
			return store.PRObservation{}, ctx.Err()
		}
	}

	// The entry goes when this caller's answer is published, and it goes even if
	// the query panics: waiters read the answer after done closes, so closing has
	// to be last, and a question that is over must not stay in the map.
	defer func() {
		s.mu.Lock()
		delete(s.inflight, key)
		s.mu.Unlock()
		close(call.done)
	}()

	askedAt := s.now()
	call.observation, call.err = s.observeNow(ctx, t, maySpendAnonymous, askedAt)
	return call.observation, call.err
}

// claimObserve joins the in-flight question for key, or registers this caller's
// own and reports that it is the one who has to ask it.
func (s *Service) claimObserve(key observeKey) (*inflight, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if call, ok := s.inflight[key]; ok {
		return call, false
	}
	call := &inflight{done: make(chan struct{})}
	if s.inflight == nil {
		s.inflight = map[observeKey]*inflight{}
	}
	s.inflight[key] = call
	return call, true
}

// observeNow does what observe promises, with the time of the question passed in
// so that every row this attempt writes carries it.
func (s *Service) observeNow(ctx context.Context, t Target, maySpendAnonymous bool, askedAt time.Time) (store.PRObservation, error) {
	key := t.Repo.Canonical()
	result, err := s.query(ctx, t.Repo, t.Branch, maySpendAnonymous)
	if err != nil {
		// A skipped attempt is not a failure. Recording one would write a
		// sentence onto the row that says the query failed when the truth is
		// that it was never made, and the next read would show it to the user.
		if !errors.Is(err, errBudgetSpent) {
			if recErr := s.store.RecordPRFailure(ctx, key, t.Branch, t.TaskID, err.Error(), askedAt); recErr != nil {
				return store.PRObservation{}, recErr
			}
		}
		cached, _, getErr := s.store.GetPRObservation(ctx, key, t.Branch)
		if getErr != nil {
			return store.PRObservation{}, getErr
		}
		cached.Repo, cached.HeadBranch, cached.TaskID = key, t.Branch, t.TaskID
		return cached, err
	}
	if err := s.record(ctx, t, result, askedAt); err != nil {
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
//
// askedAt dates the question, and the store refuses the write if a newer question
// has already been answered for this branch.
func (s *Service) record(ctx context.Context, t Target, res LookupResult, askedAt time.Time) error {
	at := askedAt.UnixMilli()
	obs := store.PRObservation{
		Repo:        t.Repo.Canonical(),
		HeadBranch:  t.Branch,
		TaskID:      t.TaskID,
		Source:      res.Source,
		ObservedAt:  &at,
		AttemptedAt: at,
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

// SnapshotForTask returns the cached observations for a task's current branch.
//
// Without force it does not query, write, or leave anything running: a branch
// nobody has looked at yet comes back with a repo and a branch and no rows. That
// is what lets the console ask this question on every open without spending rate
// limit, and it is why the answer needs a freshness line — nothing here is live.
// Freshness comes from two places, and neither is this call: Reconcile, the
// bounded background pass, which is the design's answer for open pull requests
// whose checks change while nobody is watching; and force, the one action the
// user asks for by hand.
//
// "No query" is the claim, not "no work": resolving the task's repository reads
// the workspace row and runs git against the checkout, and Status may re-probe
// for a gh binary. Cheap, local, and bounded — but not free, so this is a call to
// make once per screen rather than in a loop.
//
// force queries GitHub inline and waits, because the user asked for an answer
// and is watching for it — returning the cached one instead would look like the
// button did nothing.
//
// A task that is not on a GitHub repository, or has no workspace yet, gets an
// empty snapshot rather than an error: having no pull request is the normal
// state of a session that has not been published.
func (s *Service) SnapshotForTask(ctx context.Context, taskID string, force bool) (Snapshot, error) {
	// Observations is initialised rather than left nil so the JSON is `[]` and
	// not `null`. The console types it as an array, and a null there is the kind
	// of contract drift that only bites once something calls a method on it.
	snap := Snapshot{GH: s.Status(), Observations: []store.PRObservation{}}

	target, ok, err := s.TargetForTask(ctx, taskID)
	if err != nil {
		return snap, err
	}
	if ok {
		snap.Repo = target.Repo.Canonical()
		snap.Branch = target.Branch
		if force {
			if _, err := s.Observe(ctx, target); err != nil {
				snap.Notice = err.Error()
			}
		}
	}

	observations, err := s.store.ListPRObservationsByTask(ctx, taskID)
	if err != nil {
		return snap, err
	}
	snap.Observations = observations
	s.applyAnonymousNotice(&snap)
	return snap, nil
}

// applyAnonymousNotice explains an anonymous answer.
//
// It is about the answer in hand, not about gh's state: an anonymous row is
// missing private data whether or not the CLI happens to be working, and a row
// read anonymously while gh was down stays anonymous after gh comes back.
func (s *Service) applyAnonymousNotice(snap *Snapshot) {
	lead, ok := leadObservation(snap.Observations, snap.Branch)
	if !ok || lead.Source != SourceAnonymous {
		return
	}
	snap.Notice = joinNotice(snap.Notice, anonymousNotice)
}

// leadObservation picks the row the console will lead with, so the notice
// describes the card it appears above.
//
// An exact branch match wins even when it has never been observed: a failed
// check on this branch is this branch's answer, and an older generation's row
// belongs to a different branch. Only when nothing matches does the most
// recently observed row stand in, which is what keeps a task whose checkout is
// gone from going blank. This mirrors leadObservation in
// ui/src/lib/prObservation.ts, which is the other half of the same rule.
func leadObservation(observations []store.PRObservation, branch string) (store.PRObservation, bool) {
	if len(observations) == 0 {
		return store.PRObservation{}, false
	}
	if branch != "" {
		for _, o := range observations {
			if o.HeadBranch == branch {
				return o, true
			}
		}
	}
	var best store.PRObservation
	found := false
	for _, o := range observations {
		if o.ObservedAt == nil {
			continue
		}
		if !found || *best.ObservedAt < *o.ObservedAt {
			best, found = o, true
		}
	}
	if found {
		return best, true
	}
	return observations[0], true
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
// Anonymous reads are charged against a shared hourly budget at the point they
// are made (see query). The floor alone is not enough: twenty minutes times a
// batch of twenty-five is already more requests an hour than the anonymous quota
// contains, and the pass would discover that by spending the whole thing.
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
		if s.anonymousBackoffRemaining() > 0 && s.nextReadIsAnonymous(obs.Source) {
			continue
		}
		if !s.due(obs, now) {
			continue
		}
		repo, ok := ParseCanonical(obs.Repo)
		if !ok {
			continue
		}
		if _, err := s.observe(ctx, Target{TaskID: obs.TaskID, Repo: repo, Branch: obs.HeadBranch}, true); err != nil {
			// A row the budget skipped is not a failure and is not the pass's
			// first error; it is the pass working as designed.
			if errors.Is(err, errBudgetSpent) {
				continue
			}
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		refreshed++
	}
	return refreshed, firstErr
}

// due reports whether a row is worth querying now.
//
// It consults the attempt clock as well as the observation clock, because those
// are different clocks and a row can be old by one and new by the other. An open
// pull request whose read started failing — the repository went private, the
// login expired, the quota ran out — keeps an observation time that stops
// advancing, so a floor keyed only on the observation would put a fresh query
// behind every tick: twenty-five rows a minute is fifteen hundred anonymous
// lookups an hour against a quota of sixty.
//
// The never-succeeded case has no branch here on purpose. A row with no
// observation has no number either, so it is not in this pass's set at all —
// only a successful answer writes a number.
func (s *Service) due(o store.PRObservation, now time.Time) bool {
	floor := s.floorFor(o.Source)
	if o.ObservedAt != nil && now.Sub(time.UnixMilli(*o.ObservedAt)) < floor {
		return false
	}
	return now.Sub(time.UnixMilli(o.AttemptedAt)) >= floor
}
