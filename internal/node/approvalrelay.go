package node

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/task"
)

// ApprovalRelay carries a permission question from an agent running on this
// machine to the Hub this machine works for, and the answer back.
//
// A Node is a daemon with its own store, its own console and its own approval
// inbox. When an agent it runs for somebody else asks for permission, that inbox
// is the wrong place for the question: the person who has to answer it is
// looking at the Hub. So the question goes over the control channel the machine
// already has, the Hub records it in the one inbox everybody reads, and the
// decision comes back down the same socket (ADR 0022 D1).
//
// The id it answers with is the Hub's, so the approval an agent logs is the
// approval a person sees in the console.
type ApprovalRelay struct {
	// Executor is the turns this machine runs for its Hub. A question about one
	// of them is the only kind that travels: everything else is this machine's
	// own work, answered by its own inbox.
	Executor *Executor
	// RequestTimeout bounds the wait for the Hub to say it took the request. It
	// is short on purpose: the agent's own client gives up on the call long
	// before a person makes up their mind about it.
	RequestTimeout time.Duration
	// Warn receives problems that have nowhere else to go. Nil means quiet.
	Warn func(format string, args ...any)

	mu      sync.Mutex
	send    WriteFunc
	waiters map[string]*approvalWaiter
	byID    map[string]*approvalWaiter
	// answered keeps the outcome of questions that are already over, under every
	// id they were known by. An answer is not consumed by the wait that happened
	// to read it first: the agent's client long-polls, and a second wait for a
	// question this machine already has an answer to must get that answer rather
	// than "not a question this machine asked" — which the client reads as a
	// failed wait and turns into a deny.
	answered     map[string]approvalOutcome
	answeredKeys []string
}

// maxAnsweredRetained bounds the outcomes kept for questions that are over.
//
// The retention is a courtesy to a wait that comes back late, not a record: the
// Hub's row is the record. Oldest first, so a machine that has been connected
// for weeks holds a window rather than a transcript.
const maxAnsweredRetained = 256

// maxOpenQuestions bounds the questions one machine forwards at a time. Each one
// is an agent blocked on a person, so the cap is far above what a working
// machine reaches; it is here so a runaway agent cannot grow this map forever.
const maxOpenQuestions = 512

// SetSender installs the connection's write path, and — when it is taken away —
// ends every question this machine is still waiting on.
//
// It is the hook the executor already uses, for the same reason: a question
// whose answer can no longer arrive is not a question any more, and the agent
// blocked on it has to hear that rather than wait for a decision that has
// nowhere to land.
func (r *ApprovalRelay) SetSender(send WriteFunc) {
	r.mu.Lock()
	r.send = send
	r.mu.Unlock()
	if send == nil {
		r.End()
	}
}

// sender is the write path this machine has right now, if any.
func (r *ApprovalRelay) sender() WriteFunc {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.send
}

// DefaultApprovalRequestTimeout is how long this machine waits for the Hub to
// take a question before telling the agent the request failed.
//
// It is deliberately shorter than the agent's own post timeout (15s in
// approvalbridge): the point of this bound is to fail with a reason the agent
// can read, and a wait that outlives the caller can only produce a bare timeout
// on the other side.
const DefaultApprovalRequestTimeout = 10 * time.Second

// approvalWaiter is one question this machine is blocked on.
type approvalWaiter struct {
	// status carries the Hub's answer to the request itself: accepted, with the
	// id of the row it created, or refused with a reason. It is written once —
	// once guards it — and read by the Request that is waiting for it.
	status chan worker.ApprovalStatus
	// decision carries the outcome, once the Hub has one — or an error, when the
	// connection ends before the Hub decided anything. An agent blocked on a
	// question has to hear about that too; the alternative is a wait that ends
	// only because the agent's own client got bored.
	decision chan approvalOutcome
	once     sync.Once
}

// approvalOutcome is how a question ended.
type approvalOutcome struct {
	decision string
	err      error
}

func (r *ApprovalRelay) warn(format string, args ...any) {
	if r.Warn != nil {
		r.Warn(format, args...)
	}
}

// Owns reports whether an execution id names a turn this machine is running for
// its Hub, which is the only case a question has to travel. The Hub finds the
// task through that turn, so it is also the one field of a question the Hub acts
// on.
func (r *ApprovalRelay) Owns(executionID string) bool {
	return r.Executor != nil && r.Executor.Has(strings.TrimSpace(executionID))
}

// Ask sends a question to the Hub and returns the Hub's approval id.
//
// Nothing is returned until the Hub has taken the request: an agent that logs an
// approval id has to be holding one that exists somewhere a person can see it.
func (r *ApprovalRelay) Ask(ctx context.Context, req task.CreateApprovalRequest) (string, error) {
	executionID := strings.TrimSpace(req.ExecutionID)
	if executionID == "" {
		return "", errors.New("approval request has no execution")
	}
	requestID, err := newApprovalRequestID()
	if err != nil {
		return "", err
	}
	waiter := &approvalWaiter{
		status:   make(chan worker.ApprovalStatus, 1),
		decision: make(chan approvalOutcome, 1),
	}
	request := worker.ApprovalRequest{
		RequestID: requestID,
		TurnID:    executionID,
		Kind:      req.Kind,
		Payload:   req.Payload,
		Agent:     strings.TrimSpace(req.ExecutionAgent),
		Step:      req.ExecutionStep,
		Model:     strings.TrimSpace(req.ExecutionModel),
	}
	// The same bounds the Hub applies, applied before the question leaves: a
	// payload the Hub would refuse is refused here, with a reason, instead of
	// being sent up to be rejected as a frame the sender should never have
	// produced.
	if err := request.Validate(); err != nil {
		return "", err
	}
	if !r.track(requestID, waiter) {
		return "", fmt.Errorf("this machine already has %d questions open", maxOpenQuestions)
	}

	frame, err := worker.NewFrame("approval.request", request)
	if err != nil {
		r.forget(waiter)
		return "", err
	}
	send := r.sender()
	if send == nil {
		r.forget(waiter)
		return "", errors.New("this machine is not connected to its hub")
	}
	sendCtx, cancel := context.WithTimeout(ctx, r.requestTimeout())
	defer cancel()
	if err := send(sendCtx, frame); err != nil {
		r.forget(waiter)
		return "", fmt.Errorf("ask the hub for approval: %w", err)
	}

	select {
	case status := <-waiter.status:
		if status.Error != "" {
			// The Hub will not ask anybody. Its reason is passed through as it
			// stands: it is the Hub that knows why.
			r.forget(waiter)
			return "", errors.New(status.Error)
		}
		return status.ApprovalID, nil
	case <-time.After(r.requestTimeout()):
		r.forget(waiter)
		return "", fmt.Errorf("the hub did not answer the approval request within %s", r.requestTimeout())
	case <-ctx.Done():
		r.forget(waiter)
		return "", ctx.Err()
	}
}

// Waiting reports whether an approval id is one this machine forwarded to its
// Hub, as opposed to one its own inbox holds — including the ones it already has
// an answer for, so that the wait below is still routed here rather than to an
// inbox that never heard of this id.
func (r *ApprovalRelay) Waiting(approvalID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.byApproval(approvalID) != nil {
		return true
	}
	_, answered := r.answered[approvalID]
	return answered
}

// Decision blocks until the Hub has decided the question, or the connection
// ends. It is the second half of Ask: the outcome is buffered, so a decision that
// arrived while the agent was still walking over to ask for it is not lost.
//
// A question that never gets an answer is a denied question as far as the agent
// is concerned: the error it gets back makes its tool call fail with something a
// person can read, instead of holding the turn open forever.
//
// Once answered, a question keeps answering: the outcome is remembered until the
// connection ends, so a client that long-polls the same id twice gets the same
// decision both times.
func (r *ApprovalRelay) Decision(ctx context.Context, approvalID string) (string, error) {
	r.mu.Lock()
	waiter := r.byApproval(approvalID)
	answered, wasAnswered := r.answered[approvalID]
	r.mu.Unlock()
	if waiter == nil {
		if wasAnswered {
			return answered.decision, answered.err
		}
		// Either this machine never asked, or the connection ended between the
		// question and this wait. Both are "there is no answer coming here", which is
		// all the caller needs to know.
		return "", fmt.Errorf("approval %s is not a question this machine is waiting on", approvalID)
	}
	select {
	case outcome := <-waiter.decision:
		r.settle(waiter, outcome)
		return outcome.decision, outcome.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Handle routes a frame the Hub sent about a question.
func (r *ApprovalRelay) Handle(_ context.Context, frame worker.Frame) error {
	switch frame.Kind {
	case "approval.status":
		status, err := Decode[worker.ApprovalStatus](frame)
		if err != nil {
			return err
		}
		if err := status.Validate(); err != nil {
			return err
		}
		r.mu.Lock()
		waiter := r.waiters[status.RequestID]
		r.mu.Unlock()
		if waiter == nil {
			// The Hub answered a request this machine is not waiting on: the local
			// side gave up on it, or the Hub is confused. Either way there is nobody
			// left to tell.
			return fmt.Errorf("approval status for unknown request %s", status.RequestID)
		}
		if status.ApprovalID != "" {
			// The wait that follows arrives by the Hub's id, not by the one this
			// machine made up for the request.
			r.mu.Lock()
			if r.byID == nil {
				r.byID = make(map[string]*approvalWaiter)
			}
			r.byID[status.ApprovalID] = waiter
			r.mu.Unlock()
		}
		waiter.once.Do(func() { waiter.status <- status })
		return nil
	case "approval.decision":
		decision, err := Decode[worker.ApprovalDecision](frame)
		if err != nil {
			return err
		}
		if err := decision.Validate(); err != nil {
			return err
		}
		r.mu.Lock()
		waiter := r.waiters[decision.RequestID]
		r.mu.Unlock()
		if waiter == nil {
			return fmt.Errorf("approval decision for unknown request %s", decision.RequestID)
		}
		// The waiter stays registered until the outcome is read. This frame arrives
		// on the connection's read loop, which knows nothing about whether the
		// agent's wait call has reached this daemon yet: unregistering it here would
		// turn an answered question into "not one this machine asked about" for a
		// wait that was one HTTP round trip behind.
		select {
		case waiter.decision <- approvalOutcome{decision: decision.Decision}:
		default:
		}
		return nil
	default:
		return fmt.Errorf("node does not handle frame kind %q", frame.Kind)
	}
}

// End fails every question this machine is waiting on, because the connection
// that would have carried the answer is gone.
//
// It is the counterpart of the Hub's own cleanup: both sides stop waiting, and
// the agents blocked on a question get an error rather than a silent hang.
func (r *ApprovalRelay) End() {
	r.mu.Lock()
	waiters := make([]*approvalWaiter, 0, len(r.waiters))
	for _, waiter := range r.waiters {
		waiters = append(waiters, waiter)
	}
	r.waiters = make(map[string]*approvalWaiter)
	r.byID = make(map[string]*approvalWaiter)
	// The answers go with the questions: the Hub's row is the record, and this
	// connection is no longer a place one can be read from.
	r.answered = make(map[string]approvalOutcome)
	r.answeredKeys = nil
	r.mu.Unlock()
	for _, waiter := range waiters {
		waiter.once.Do(func() {
			waiter.status <- worker.ApprovalStatus{Error: errRelayGone.Error()}
		})
		select {
		case waiter.decision <- approvalOutcome{err: errRelayGone}:
		default:
		}
	}
}

// errRelayGone is what an agent hears when the machine it asked on stopped being
// able to reach the Hub. It denies the request by failing it, which is the only
// honest answer: nobody was asked.
var errRelayGone = errors.New("the connection to the hub ended before the question was answered")

// Pending lists the questions this machine is waiting on, for diagnostics.
func (r *ApprovalRelay) Pending() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.waiters)
}

// track registers a waiter under the id this machine made up. It reports false,
// and registers nothing, when the machine already has its cap of questions open.
func (r *ApprovalRelay) track(requestID string, waiter *approvalWaiter) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.waiters == nil {
		r.waiters = make(map[string]*approvalWaiter)
	}
	if len(r.waiters) >= maxOpenQuestions {
		return false
	}
	r.waiters[requestID] = waiter
	return true
}

// forget removes a waiter under both the ids it may be known by.
func (r *ApprovalRelay) forget(waiter *approvalWaiter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dropLocked(waiter)
}

// settle removes a waiter and remembers its outcome under every id it was known
// by, so the answer outlives the wait that happened to read it first.
func (r *ApprovalRelay) settle(waiter *approvalWaiter, outcome approvalOutcome) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, id := range r.dropLocked(waiter) {
		r.rememberLocked(id, outcome)
	}
}

// dropLocked removes a waiter from every id it is registered under, and returns
// those ids. The caller holds the lock.
func (r *ApprovalRelay) dropLocked(waiter *approvalWaiter) []string {
	var ids []string
	for requestID, candidate := range r.waiters {
		if candidate == waiter {
			delete(r.waiters, requestID)
			ids = append(ids, requestID)
		}
	}
	for approvalID, candidate := range r.byID {
		if candidate == waiter {
			delete(r.byID, approvalID)
			ids = append(ids, approvalID)
		}
	}
	return ids
}

// rememberLocked keeps one outcome under one id, oldest out first. The caller
// holds the lock.
func (r *ApprovalRelay) rememberLocked(id string, outcome approvalOutcome) {
	if r.answered == nil {
		r.answered = make(map[string]approvalOutcome)
	}
	if _, exists := r.answered[id]; exists {
		return
	}
	r.answered[id] = outcome
	r.answeredKeys = append(r.answeredKeys, id)
	if len(r.answeredKeys) > maxAnsweredRetained {
		oldest := r.answeredKeys[0]
		r.answeredKeys = r.answeredKeys[1:]
		delete(r.answered, oldest)
	}
}

// byApproval finds the waiter for a Hub approval id or a local request id. The
// caller holds the lock.
func (r *ApprovalRelay) byApproval(id string) *approvalWaiter {
	if waiter := r.byID[id]; waiter != nil {
		return waiter
	}
	return r.waiters[id]
}

func (r *ApprovalRelay) requestTimeout() time.Duration {
	if r.RequestTimeout > 0 {
		return r.RequestTimeout
	}
	return DefaultApprovalRequestTimeout
}

// newApprovalRequestID is the id this machine makes up for one question. The Hub
// assigns its own id to the row; this one only has to be unique among the
// questions in flight here.
func newApprovalRequestID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("generate approval request id: %w", err)
	}
	return "req-" + hex.EncodeToString(buf[:]), nil
}
