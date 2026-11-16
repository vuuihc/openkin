package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
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
//
// For a task that runs on another machine, the branch is not known here at all
// until that machine says which one it is on — the row records where the session
// started, which is not where the work necessarily stayed. Device and Dir are
// what such a task is observed through: the machine, and the checkout on it.
type Target struct {
	TaskID string
	Repo   Repo
	Branch string
	// Device names the machine holding the checkout, or is empty when this
	// daemon holds it.
	Device string
	// Dir is that checkout's directory on that machine. Unused for a local
	// target, whose repository and branch are already resolved.
	Dir string
	// DirReason is why the checkout could not be located on Device, set instead
	// of Dir when the task has a workspace identity that machine cannot place.
	// The read is refused with it rather than pointed at the task's original
	// path, which is a directory no turn can run in and may be a different
	// checkout with the same name.
	DirReason string
}

// Machines is the Hub's own view of the paired machines, as this package needs
// it. It is an interface because the Hub is the only thing that has one, and
// this package must still be testable without a channel to a real one.
type Machines interface {
	// RunsElsewhere reports whether a task's turns run on another machine.
	RunsElsewhere(t store.Task) bool
	// RemoteWorkspaceCwd resolves where a task's work sits on that machine, and
	// reports false when it cannot be resolved there.
	RemoteWorkspaceCwd(ctx context.Context, t store.Task) (string, bool, error)
	// Ask puts one question to one machine and decodes its answer.
	Ask(ctx context.Context, device, method string, params, out any) error
}

// remoteObserveTimeout bounds one question about another machine's pull request.
//
// It has to be generous: the answer is a read of GitHub made by that machine,
// through its own CLI, which is a process launch and up to three requests. What
// it must not be is absent — a machine that accepts the question and then goes
// quiet would otherwise hold a person's refresh open until they gave up on it.
const remoteObserveTimeout = 45 * time.Second

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
	// machines is how a task that runs elsewhere is observed: the Hub asks the
	// machine holding the checkout. Nil means every task is this machine's, which
	// is what a daemon with no Hub role is.
	machines Machines

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

// SetMachines gives the service the Hub's paired machines. A daemon that runs
// every task itself never calls this, and never asks anybody anything.
func (s *Service) SetMachines(m Machines) { s.machines = m }

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
// An error with an empty observation is the one case where the reason is not on a
// row: the attempt could not be written down at all, which is a store that failed
// rather than a query that did.
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
	// device and dir identify a question about another machine's checkout. Such a
	// question is about that directory and nothing else: the repository and branch
	// are part of its answer, so they cannot also be part of what makes it unique,
	// and the caller's budget does not enter into it — that machine's own
	// credentials make the read, and its own address pays for it.
	device, dir string
	// reason stands in for dir when there is no directory to ask about: the
	// machine cannot place the task's workspace, and the refusal is the whole
	// question. It is part of the identity so that two such tasks on one machine
	// do not share an answer about one of their workspaces.
	reason string
}

// observeKeyFor is the identity of the question one target asks.
func observeKeyFor(t Target, maySpendAnonymous bool) observeKey {
	if t.Device != "" {
		return observeKey{device: t.Device, dir: t.Dir, reason: t.DirReason}
	}
	return observeKey{repo: t.Repo.Canonical(), branch: t.Branch, maySpend: maySpendAnonymous}
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
	key := observeKeyFor(t, maySpendAnonymous)
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
	// A task whose work is on another machine is asked about there. Nothing below
	// this line would be about the right checkout: this daemon may hold its own
	// copy of the same repository at the same path, and its own credentials may
	// see a different set of repositories.
	if t.Device != "" {
		return s.observeOnMachine(ctx, t, askedAt)
	}
	key := t.Repo.Canonical()
	result, err := s.query(ctx, t.Repo, t.Branch, maySpendAnonymous)
	if err != nil {
		return s.failedAttempt(ctx, key, t.Branch, t.TaskID, err, askedAt)
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

// failedAttempt writes one failed attempt onto the row it belongs to and returns
// the best answer still known: the previous successful one, carrying the reason
// this attempt failed. The console renders that pair — the card, and the
// sentence under it — which is why the cached row is returned even though the
// call failed.
//
// A skipped attempt is not a failure. Recording one would write a sentence onto
// the row that says the query failed when the truth is that it was never made,
// and the next read would show it to the user.
//
// Nothing to write on is a different case again, and the reason travels as the
// error instead: a task that has never had an answer has no row, and inventing
// one would key a pull request to a branch nobody named.
func (s *Service) failedAttempt(ctx context.Context, repo, branch, taskID string, cause error, askedAt time.Time) (store.PRObservation, error) {
	if errors.Is(cause, errBudgetSpent) || repo == "" || branch == "" {
		return store.PRObservation{}, cause
	}
	if err := s.store.RecordPRFailure(ctx, repo, branch, taskID, cause.Error(), askedAt); err != nil {
		return store.PRObservation{}, err
	}
	cached, _, err := s.store.GetPRObservation(ctx, repo, branch)
	if err != nil {
		return store.PRObservation{}, err
	}
	cached.Repo, cached.HeadBranch, cached.TaskID = repo, branch, taskID
	return cached, cause
}

// observeOnMachine asks the machine holding a task's checkout what pull request
// its branch has, and writes the answer down here.
//
// The Hub keeps the row: it is the thing that serves both screens, and the
// machine's answer is about a moment, not a state it stores. What the machine
// decides is everything the answer is made of — which repository, which branch,
// and what the pull request is — because that is the machine with the checkout,
// the credentials, and the network.
//
// The Hub's anonymous budget does not apply. That budget exists to stop this
// process spending a quota nobody is watching; the read here is made with the
// other machine's credentials against the other machine's address, and what
// keeps it rare is the cadence the Hub asks at — the floor and the batch size of
// the background pass, which are the same ones it applies to its own reads.
func (s *Service) observeOnMachine(ctx context.Context, t Target, askedAt time.Time) (store.PRObservation, error) {
	if s.machines == nil {
		return store.PRObservation{}, errors.New("no machines are paired with this daemon")
	}
	if t.DirReason != "" {
		// Refused, not guessed. The machine cannot place the workspace this
		// task's turns run in, so there is no checkout whose pull request this
		// could be — and the sentence is the one the refused turn itself gets,
		// so the panel and the transcript say the same thing.
		return s.failedAttempt(ctx, t.Repo.Canonical(), t.Branch, t.TaskID,
			errors.New(t.DirReason), askedAt)
	}
	if t.Dir == "" {
		return s.failedAttempt(ctx, t.Repo.Canonical(), t.Branch, t.TaskID,
			fmt.Errorf("%s did not say which directory to read", t.Device), askedAt)
	}
	askCtx, cancel := context.WithTimeout(ctx, remoteObserveTimeout)
	defer cancel()
	var answer worker.PRObserveResult
	err := s.machines.Ask(askCtx, t.Device, worker.QueryPRObserve, worker.PRObserveParams{Path: t.Dir}, &answer)
	if err == nil && !answer.Observed {
		// The reason is what the row's last_error will say, and the console prints
		// it under the card. An answer that says "I did not look" and nothing else
		// is one this Hub cannot render — every path in this repo's own node sets a
		// reason, but the answer is a wire value and an empty sentence on screen is
		// worse than a plain one.
		reason := strings.TrimSpace(answer.Reason)
		if reason == "" {
			reason = fmt.Sprintf("%s did not say why it could not read the pull request", t.Device)
		}
		err = errors.New(reason)
	}
	if err != nil {
		return s.failedAttempt(ctx, t.Repo.Canonical(), t.Branch, t.TaskID, err, askedAt)
	}

	// What the machine said, checked rather than trusted: the answer is a wire
	// value, and a Hub that keyed a row on it unchecked would file another
	// repository's pull request under this task.
	repo, ok := ParseCanonical(answer.Repo)
	if !ok {
		return s.failedAttempt(ctx, t.Repo.Canonical(), t.Branch, t.TaskID,
			fmt.Errorf("%s answered about %q, which is not a repository this Hub can read", t.Device, answer.Repo), askedAt)
	}
	if strings.TrimSpace(answer.Branch) == "" {
		return s.failedAttempt(ctx, t.Repo.Canonical(), t.Branch, t.TaskID,
			fmt.Errorf("%s answered about %s with no branch", t.Device, repo.Canonical()), askedAt)
	}
	observed := Target{TaskID: t.TaskID, Repo: repo, Branch: answer.Branch}
	res := LookupResult{Source: answer.Source}
	if answer.Number > 0 {
		number := answer.Number
		res.PR = &PullRequest{
			Number:     &number,
			URL:        answer.URL,
			Title:      answer.Title,
			State:      answer.State,
			IsDraft:    answer.Draft,
			BaseBranch: answer.BaseBranch,
			HeadOID:    answer.HeadOID,
			CI:         CIStatus{State: answer.CIState},
		}
		if answer.CISummary != "" {
			if err := json.Unmarshal([]byte(answer.CISummary), &res.PR.CI); err != nil {
				// The counts are secondary to the pull request itself, and a
				// summary this Hub cannot read is a summary it does not have.
				res.PR.CI = CIStatus{State: answer.CIState}
			}
		}
	}
	if err := s.record(ctx, observed, res, askedAt); err != nil {
		return store.PRObservation{}, err
	}
	s.noteWhereTheWorkMoved(ctx, t, repo, answer.Branch)
	obs, _, err := s.store.GetPRObservation(ctx, repo.Canonical(), answer.Branch)
	if err != nil {
		return store.PRObservation{}, err
	}
	return obs, nil
}

// noteWhereTheWorkMoved writes the machine's own answer back onto the task row.
//
// The row is what the panel draws before anyone asks the machine anything, so a
// session that has switched branches since it started would otherwise keep a
// header about the branch it used to be on, beside a card about the branch it is
// on now. Best effort: the observation is written and is the answer that
// matters, and a row that could not be corrected is a header that lags.
func (s *Service) noteWhereTheWorkMoved(ctx context.Context, t Target, repo Repo, branch string) {
	if t.TaskID == "" || (t.Repo.Canonical() == repo.Canonical() && t.Branch == branch) {
		return
	}
	recorded, moved := repo.Canonical(), branch
	_ = s.store.UpdateTask(ctx, t.TaskID, store.TaskPatch{
		WorkspaceRepo:   &recorded,
		WorkspaceBranch: &moved,
	})
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
//
// A task with no generation of its own — a session that runs on another machine,
// where the checkout is that machine's — falls back to what that machine said
// about it (see recordWhereTheWorkIs). That is a read of the task row: no git,
// no question to any machine, no network.
func (s *Service) TargetForTask(ctx context.Context, taskID string) (Target, bool, error) {
	// The task first, because whether it runs here decides which of the two
	// answers below is the right one: a task whose turns run on another machine
	// keeps its work there, and this daemon's own checkouts say nothing about it.
	if s.machines != nil {
		t, err := s.store.GetTask(ctx, taskID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return Target{}, false, fmt.Errorf("task %s: %w", taskID, err)
		}
		if err == nil && s.machines.RunsElsewhere(t) {
			return s.targetOnMachine(ctx, t)
		}
	}

	gen, err := s.store.GetCurrentWorkspace(ctx, taskID)
	if errors.Is(err, store.ErrNotFound) {
		return s.targetRecordedOnTask(ctx, taskID)
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

// targetOnMachine names the checkout a task's work is in on the machine that
// runs it.
//
// The repository and branch come from the task row, where they were recorded
// when the session started (see recordWhereTheWorkIs). They are what the panel
// draws before anyone asks the machine anything, and they are allowed to be
// missing or stale: the machine is asked afresh whenever an observation is
// actually made, and its answer is what the observation is keyed on.
//
// Resolving the directory can fail — the anchor may be gone, or the machine may
// have reported no roots — and that is a machine that cannot be asked, not a
// task with no repository: the target still exists, and the failure is what the
// observation attempt will report.
//
// The directory itself is resolved the way the turn resolves it (see
// Engine.dispatchCwd), because the checkout whose pull request this panel is
// about is the one the turn runs in. That means the two ends are kept apart:
// a task with no workspace identity runs at the path it was created with, and
// that path is the answer here too; a task whose anchor this machine cannot
// place is a turn that would be refused outright, and reading the created path
// instead would draw a card about whatever happens to sit there — then write it
// onto the task row through noteWhereTheWorkMoved.
func (s *Service) targetOnMachine(ctx context.Context, t store.Task) (Target, bool, error) {
	device := strings.TrimSpace(t.ExecutingDeviceID)
	if device == "" {
		return Target{}, false, nil
	}
	target := Target{TaskID: t.ID, Device: device}
	if t.WorkspaceRepo != "" && t.WorkspaceBranch != "" {
		if repo, ok := ParseCanonical(t.WorkspaceRepo); ok {
			target.Repo, target.Branch = repo, t.WorkspaceBranch
		}
	}
	cwd, remote, err := s.machines.RemoteWorkspaceCwd(ctx, t)
	switch {
	case err != nil:
		target.DirReason = err.Error()
	case remote && strings.TrimSpace(cwd) != "":
		target.Dir = cwd
	default:
		target.Dir = t.EffectiveCwd()
	}
	return target, true, nil
}

// targetRecordedOnTask reads the repository and branch a task was recorded on.
//
// The row is written when a remote session starts and refreshed when someone
// asks for a refresh, and both of those are moments when a machine question is
// already being asked. This is the read side of that, and it stays a cache read:
// a panel that opened must not spend a machine round trip or a rate limit to
// draw itself.
//
// A repository this Hub cannot name — not on github.com, or never recorded — is
// answered as no target rather than guessed at: the lookup paths only speak
// github.com, and a guess would show another repository's pull requests under
// this task's name.
func (s *Service) targetRecordedOnTask(ctx context.Context, taskID string) (Target, bool, error) {
	t, err := s.store.GetTask(ctx, taskID)
	if errors.Is(err, store.ErrNotFound) {
		return Target{}, false, nil
	}
	if err != nil {
		return Target{}, false, fmt.Errorf("task %s: %w", taskID, err)
	}
	if t.WorkspaceRepo == "" || t.WorkspaceBranch == "" {
		return Target{}, false, nil
	}
	repo, ok := ParseCanonical(t.WorkspaceRepo)
	if !ok {
		return Target{}, false, nil
	}
	return Target{TaskID: taskID, Repo: repo, Branch: t.WorkspaceBranch}, true, nil
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
		if force {
			// A failed query is not the notice's to report. The attempt wrote its
			// reason on the row, and the row is where the console prints it —
			// next to the pull request it failed to refresh. Copying it here as
			// well printed the same sentence twice on a phone, once as a banner
			// and once under the card. See Snapshot.Notice.
			//
			// The exception is a failure that reached no row at all, which is a
			// store that could not be written rather than a query that failed.
			// Observe returns an empty observation exactly then, and there is
			// nothing else left to carry that news.
			if obs, err := s.Observe(ctx, target); err != nil && obs.Repo == "" {
				return snap, err
			}
			// Asked afresh, because the answer may be about a different branch
			// than the row remembered: a checkout that has moved since the
			// session started is exactly what the machine is asked about, and
			// the header has to name the branch the card below it is about.
			if again, ok, err := s.TargetForTask(ctx, taskID); err == nil && ok {
				target = again
			}
		}
		// A target on another machine may have no recorded repository yet — a
		// session that started while that machine was away has one, but its
		// answer is the machine's to give. Reporting the empty one as a
		// canonical repository would print "github.com//" over the panel.
		if target.Repo.Owner != "" {
			snap.Repo = target.Repo.Canonical()
		}
		snap.Branch = target.Branch
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
		if !s.due(obs, now) {
			continue
		}
		repo, ok := ParseCanonical(obs.Repo)
		if !ok {
			continue
		}
		target, err := s.passTarget(ctx, obs, repo)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		// The two gates below are this daemon's own spending rules, and they are
		// about this daemon's reads. A row that is refreshed by asking another
		// machine spends nothing here: what that read costs is paid on that
		// machine, and the cadence above is what keeps it rare.
		if target.Device == "" {
			if s.anonymousBackoffRemaining() > 0 && s.nextReadIsAnonymous(obs.Source) {
				continue
			}
		}
		if _, err := s.observe(ctx, target, true); err != nil {
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

// passTarget is the target one cached row should be refreshed through.
//
// A row remembers the repository and branch it was answered about, which is
// enough to refresh it here. For a task that runs on another machine it is not:
// the read has to be made there, so the task is read to find out, and the row's
// own pair stays as the fallback for when that machine cannot be reached — the
// failure is then written onto the row it belongs to, which is the card the
// person is looking at.
func (s *Service) passTarget(ctx context.Context, obs store.PRObservation, repo Repo) (Target, error) {
	target := Target{TaskID: obs.TaskID, Repo: repo, Branch: obs.HeadBranch}
	if s.machines == nil || obs.TaskID == "" {
		return target, nil
	}
	t, err := s.store.GetTask(ctx, obs.TaskID)
	if errors.Is(err, store.ErrNotFound) {
		return target, nil
	}
	if err != nil {
		return Target{}, fmt.Errorf("task %s: %w", obs.TaskID, err)
	}
	if !s.machines.RunsElsewhere(t) {
		return target, nil
	}
	machine, ok, err := s.targetOnMachine(ctx, t)
	if err != nil {
		return Target{}, err
	}
	if !ok {
		return target, nil
	}
	// The row's pair, not the task's: this row is about that branch, and the
	// machine is asked about the checkout rather than about the pair — so the
	// repository and branch here are only what a failure gets written against.
	machine.Repo, machine.Branch = repo, obs.HeadBranch
	return machine, nil
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
