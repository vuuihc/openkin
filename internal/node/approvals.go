package node

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// ApprovalAuthority is the approval inbox this Hub asks its people through. It
// is what the engine already is, narrowed to the three things a cross-device
// approval needs, so that a Hub has exactly one approval store no matter which
// machine the agent is running on (ADR 0022 D1).
type ApprovalAuthority interface {
	// RequestApproval records a pending question and puts it in the console.
	RequestApproval(ctx context.Context, req task.CreateApprovalRequest) (store.Approval, error)
	// WaitApproval returns when the question is answered or expires.
	WaitApproval(ctx context.Context, id string, timeout time.Duration) (store.Approval, error)
	// Decide records an outcome nobody chose — used when the machine asking the
	// question goes away, so its request cannot be left looking answerable.
	Decide(ctx context.Context, id, decision, via string) (store.Approval, error)
}

// Approvals is the Hub's half of a cross-device approval: the questions a device
// is blocked on, and the answers it is owed.
//
// It is the mirror of Turns. A turn is bound to the connection that dispatched
// it and a question is bound to the turn that asked it, so a decision goes back
// down the same socket that carried the question and nowhere else.
//
// Nothing here decides anything. A question becomes a pending row and waits for
// a person; the only outcome this package produces on its own is "the machine
// asking is gone", which settles the row as expired. That is deliberate: a Hub
// that answered a permission question itself would be a Hub that approves
// running things on other people's machines (ADR 0022 D1).
type Approvals struct {
	// Turns is the registry that says which connection owns a turn. A question
	// is only ever about one of those.
	Turns  *Turns
	Engine ApprovalAuthority
	// Warn receives problems that have nowhere else to go. Nil means quiet.
	Warn func(format string, args ...any)
	// Poll is how long one wait for a decision lasts. Zero means
	// DefaultApprovalPoll, and the engine's own ceiling applies on top of it.
	Poll time.Duration

	mu      sync.Mutex
	pending map[string]*pendingApproval
}

// DefaultApprovalPoll is the length of one wait for a person to decide.
//
// The engine caps a single wait at 30s, so this is a loop, not a timeout: the
// question stays open until somebody answers it or its TTL runs out.
const DefaultApprovalPoll = 30 * time.Second

// pendingApproval is one question a device is blocked on.
type pendingApproval struct {
	requestID string
	approval  string
	turnID    string
	sender    Sender
	// cancel ends this entry's wait when the connection goes away, so the
	// goroutine does not sit on a socket that can no longer carry the answer.
	cancel context.CancelFunc
}

func (a *Approvals) warn(format string, args ...any) {
	if a.Warn != nil {
		a.Warn(format, args...)
	}
}

func (a *Approvals) poll() time.Duration {
	if a.Poll > 0 {
		return a.Poll
	}
	return DefaultApprovalPoll
}

// Route handles one frame from a device. It is the Approvals half of what the
// api server hands to NodeFrames.
func (a *Approvals) Route(ctx context.Context, sender Sender, frame worker.Frame) error {
	switch frame.Kind {
	case "approval.request":
		request, err := Decode[worker.ApprovalRequest](frame)
		if err != nil {
			return err
		}
		if err := request.Validate(); err != nil {
			return err
		}
		return a.ask(ctx, sender, request)
	default:
		return fmt.Errorf("unhandled frame kind %q", frame.Kind)
	}
}

// ask turns a device's question into a pending approval, and starts waiting for
// the answer that will be sent back to it.
func (a *Approvals) ask(ctx context.Context, sender Sender, request worker.ApprovalRequest) error {
	if a.Engine == nil {
		return errors.New("this hub has no approval inbox")
	}
	// The task is looked up from the turn, never taken from the device: a machine
	// asking for permission can only ask about the work this Hub gave it. This is
	// also what stops a paired device from opening approval rows against tasks it
	// has nothing to do with.
	item, err := a.turn(sender, request.TurnID)
	if err != nil {
		return err
	}

	// The request id is claimed before the row is created, not after: a device
	// repeating an id it already used would otherwise get a second row, and the
	// duplicate would be refused only once it was already in the console.
	waitCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	entry := &pendingApproval{
		requestID: request.RequestID,
		turnID:    request.TurnID,
		sender:    sender,
		cancel:    cancel,
	}
	a.mu.Lock()
	if a.pending == nil {
		a.pending = make(map[string]*pendingApproval)
	}
	if _, exists := a.pending[request.RequestID]; exists {
		a.mu.Unlock()
		cancel()
		return fmt.Errorf("approval request %s is already open", request.RequestID)
	}
	a.pending[request.RequestID] = entry
	a.mu.Unlock()

	approval, err := a.Engine.RequestApproval(ctx, task.CreateApprovalRequest{
		TaskID:         item.taskID,
		Kind:           approvalKind(request.Kind),
		Payload:        request.Payload,
		ExecutionID:    request.TurnID,
		ExecutionAgent: request.Agent,
		ExecutionStep:  request.Step,
		ExecutionModel: request.Model,
	})
	if err != nil {
		// The device is blocked on this. A refusal is an answer, not a failure:
		// it is sent back so the agent's tool call fails with a reason instead of
		// hanging until somebody notices.
		a.forget(entry)
		cancel()
		a.refuse(ctx, sender, request.RequestID, err)
		return nil
	}

	a.mu.Lock()
	gone := a.pending[request.RequestID] != entry
	if !gone {
		entry.approval = approval.ID
	}
	a.mu.Unlock()
	if gone {
		// The connection ended while the row was being created, so nobody is
		// waiting for it and nobody was told about it. A question left pending
		// would be one a person can answer with nothing on the other end.
		cancel()
		a.settle(approval.ID)
		return nil
	}

	if err := a.status(ctx, sender, worker.ApprovalStatus{
		RequestID:  request.RequestID,
		ApprovalID: approval.ID,
	}); err != nil {
		// The device never learned the id, so it is not waiting for a decision
		// either. The row stays: a person may still be looking at it.
		a.forget(entry)
		cancel()
		return fmt.Errorf("answer approval request %s: %w", request.RequestID, err)
	}
	go a.await(waitCtx, entry)
	return nil
}

// await waits for the decision and sends it down the connection that asked.
func (a *Approvals) await(ctx context.Context, entry *pendingApproval) {
	defer a.forget(entry)
	for {
		approval, err := a.Engine.WaitApproval(ctx, entry.approval, a.poll())
		if err != nil {
			if ctx.Err() == nil {
				a.warn("approval %s: %v", entry.approval, err)
			}
			return
		}
		if approval.Decision == store.DecisionPending {
			// Nobody has decided yet. The wait is a long poll, not a deadline: the
			// question is open until a person answers it or its TTL runs out.
			continue
		}
		if !a.stillOpen(entry) {
			// The connection ended while this was in flight. The question has been
			// settled on this side already, and a decision sent now would be an
			// answer to a machine that has stopped asking.
			return
		}
		if err := a.decide(ctx, entry, approval.Decision); err != nil {
			a.warn("approval %s: %v", entry.approval, err)
		}
		return
	}
}

// stillOpen reports whether a question is still the one registered for its
// request, and therefore still worth answering.
func (a *Approvals) stillOpen(entry *pendingApproval) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.pending[entry.requestID] == entry
}

// turn finds the turn a request is about, and checks this connection owns it.
func (a *Approvals) turn(sender Sender, turnID string) (*turn, error) {
	if a.Turns == nil {
		return nil, errors.New("this hub has no turns")
	}
	if sender == nil {
		return nil, errors.New("no connection")
	}
	return a.Turns.owned(sender, turnID)
}

// status tells a device whether its request became a question.
func (a *Approvals) status(ctx context.Context, sender Sender, status worker.ApprovalStatus) error {
	frame, err := worker.NewFrame("approval.status", status)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), approvalWriteTimeout)
	defer cancel()
	return sender.Send(writeCtx, frame)
}

// refuse answers a request the Hub will not ask anybody about.
//
// Best effort: a device that cannot be told is a device whose connection is
// gone, which fails its waiters anyway.
func (a *Approvals) refuse(ctx context.Context, sender Sender, requestID string, cause error) {
	message := strings.TrimSpace(cause.Error())
	if len(message) > worker.MaxApprovalError {
		message = message[:worker.MaxApprovalError]
	}
	if err := a.status(ctx, sender, worker.ApprovalStatus{RequestID: requestID, Error: message}); err != nil {
		a.warn("refuse approval request %s: %v", requestID, err)
	}
}

// decide sends the answer to the machine that asked the question.
func (a *Approvals) decide(ctx context.Context, entry *pendingApproval, decision string) error {
	frame, err := worker.NewFrame("approval.decision", worker.ApprovalDecision{
		RequestID: entry.requestID,
		Decision:  decision,
	})
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), approvalWriteTimeout)
	defer cancel()
	if err := entry.sender.Send(writeCtx, frame); err != nil {
		return fmt.Errorf("send decision: %w", err)
	}
	return nil
}

// Abandon settles every question asked on a connection that has ended.
//
// The answer can no longer reach the machine that asked, and the work it was
// blocked on is being failed at the same moment, so a question left pending
// would be a row in the console that nobody can act on: the user would approve
// it and nothing would happen. Expiry with a stated reason is the honest end,
// and it is what the TTL would have said an hour later.
//
// It must run before the turns on that connection are abandoned. Settling the
// row can push the task out of waiting_approval and back into running; failing
// the turn afterwards overwrites that with failed. The other order leaves a task
// that says running with no run loop behind it.
func (a *Approvals) Abandon(sender Sender) []string {
	if sender == nil {
		return nil
	}
	deviceID, gen := sender.DeviceID(), sender.Generation()
	a.mu.Lock()
	var doomed []*pendingApproval
	for _, entry := range a.pending {
		if entry.sender == nil || entry.sender.DeviceID() != deviceID || entry.sender.Generation() != gen {
			continue
		}
		doomed = append(doomed, entry)
	}
	a.mu.Unlock()

	settled := make([]string, 0, len(doomed))
	for _, entry := range doomed {
		// Stop waiting first: the decision this writes is the row's last word, and
		// a waiter that is still polling would race it.
		a.forget(entry)
		entry.cancel()
		if entry.approval == "" {
			// A request whose row is still being created. ask notices that its entry
			// is gone and settles the row itself, so there is nothing to decide here.
			continue
		}
		a.settle(entry.approval)
		settled = append(settled, entry.approval)
	}
	return settled
}

// settle records an outcome nobody chose, for a question whose asker is gone.
//
// Expired is what the TTL would have said an hour later, and "expired" is what
// the vocabulary has for an outcome that is not a decision: nobody approved it,
// and nothing is left running that could be approved.
func (a *Approvals) settle(approvalID string) {
	ctx, cancel := context.WithTimeout(context.Background(), approvalWriteTimeout)
	defer cancel()
	if _, err := a.Engine.Decide(ctx, approvalID, store.DecisionExpired, "device_disconnected"); err != nil &&
		!errors.Is(err, task.ErrAlreadyDecided) {
		a.warn("approval %s: settle after disconnect: %v", approvalID, err)
	}
}

// Pending lists the approvals devices are blocked on, for diagnostics.
func (a *Approvals) Pending() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, 0, len(a.pending))
	for _, entry := range a.pending {
		out = append(out, entry.approval)
	}
	return out
}

// forget removes an entry, if it is still the one registered under its request.
func (a *Approvals) forget(entry *pendingApproval) {
	a.mu.Lock()
	if a.pending[entry.requestID] == entry {
		delete(a.pending, entry.requestID)
	}
	a.mu.Unlock()
}

// approvalWriteTimeout bounds one frame sent to a device waiting on an answer.
const approvalWriteTimeout = 10 * time.Second

// approvalKind is what to call the question in the console. An agent that does
// not say gets the same default a local one does.
func approvalKind(kind string) string {
	if trimmed := strings.TrimSpace(kind); trimmed != "" {
		return trimmed
	}
	return "tool_use"
}
