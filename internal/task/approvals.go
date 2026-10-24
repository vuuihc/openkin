package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/sessionctx"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// ErrConflict is returned when a state transition is not allowed (HTTP 409).
var ErrConflict = errors.New("conflict")

// ErrAlreadyDecided is returned when deciding a non-pending approval.
var ErrAlreadyDecided = errors.New("approval already decided")

// ErrAlreadyAnswered is returned when answering a non-pending user question.
var ErrAlreadyAnswered = errors.New("user question already answered")

// CreateApprovalRequest is the body for POST /internal/approvals.
// Execution fields are optional and identify the concrete adapter run that
// requested the approval. Parent TaskID remains required for lifecycle.
type CreateApprovalRequest struct {
	TaskID  string          `json:"task_id"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
	// Optional execution attribution (worker / host adapter run).
	ExecutionID    string `json:"execution_id,omitempty"`
	ExecutionAgent string `json:"execution_agent,omitempty"`
	ExecutionStep  int    `json:"execution_step,omitempty"` // 1-based; 0 = unset
	ExecutionModel string `json:"execution_model,omitempty"`
}

// DecisionRequest is the body for POST /api/approvals/{id}/decision.
type DecisionRequest struct {
	Decision string `json:"decision"` // approved | denied
}

// normalizeExecutionAttribution enforces approval attribution invariants.
// Historical / unattributed requests leave all fields empty.
// Partial metadata without execution_id is rejected so nothing is persisted.
// When execution_id is set, execution_agent is required. Delegated workers
// (step >= 1) must pass a positive plan step; host runs may omit step (0).
func normalizeExecutionAttribution(id, agent string, step int, model string) (string, string, int, string, error) {
	id = strings.TrimSpace(id)
	agent = strings.TrimSpace(agent)
	model = strings.TrimSpace(model)
	if id == "" {
		if agent != "" || step != 0 || model != "" {
			return "", "", 0, "", fmt.Errorf("execution_agent/step/model require execution_id")
		}
		return "", "", 0, "", nil
	}
	if agent == "" {
		return "", "", 0, "", fmt.Errorf("execution_agent is required when execution_id is set")
	}
	if step < 0 {
		return "", "", 0, "", fmt.Errorf("execution_step must be >= 0")
	}
	// Positive step marks a delegated worker plan step. Zero is host / unset.
	return id, agent, step, model, nil
}

// RequestApproval inserts a pending approval, sets task waiting_approval,
// appends approval_requested, and broadcasts (spec §4.2).
func (e *Engine) RequestApproval(ctx context.Context, req CreateApprovalRequest) (store.Approval, error) {
	if req.TaskID == "" {
		return store.Approval{}, fmt.Errorf("task_id is required")
	}
	if req.Kind == "" {
		req.Kind = "tool_use"
	}
	if len(req.Payload) == 0 {
		req.Payload = json.RawMessage(`{}`)
	}
	execID, execAgent, execStep, execModel, err := normalizeExecutionAttribution(
		req.ExecutionID, req.ExecutionAgent, req.ExecutionStep, req.ExecutionModel,
	)
	if err != nil {
		return store.Approval{}, err
	}

	t, err := e.store.GetTask(ctx, req.TaskID)
	if err != nil {
		return store.Approval{}, err
	}
	switch t.Status {
	case StatusRunning, StatusWaitingApproval, StatusWaitingInput:
		// ok
	default:
		return store.Approval{}, fmt.Errorf("%w: task status %s cannot request approval", ErrConflict, t.Status)
	}

	id, err := e.newID()
	if err != nil {
		return store.Approval{}, err
	}
	now := e.nowMilli()
	a := store.Approval{
		ID:        id,
		TaskID:    req.TaskID,
		Kind:      req.Kind,
		Payload:   req.Payload,
		Decision:  store.DecisionPending,
		CreatedAt: now,
	}
	if execID != "" {
		a.ExecutionID = &execID
		a.ExecutionAgent = &execAgent
		if execStep > 0 {
			step := execStep
			a.ExecutionStep = &step
		}
		if execModel != "" {
			a.ExecutionModel = &execModel
		}
	}
	if err := e.store.InsertApproval(ctx, a); err != nil {
		return store.Approval{}, err
	}

	// Task → waiting_approval.
	status := StatusWaitingApproval
	if err := e.store.UpdateTask(ctx, req.TaskID, store.TaskPatch{Status: &status}); err != nil {
		return store.Approval{}, err
	}
	t, _ = e.store.GetTask(ctx, req.TaskID)
	e.bus.PublishTask(t)

	// Event payload includes approval id + tool request body + optional execution ref.
	evMap := map[string]any{
		"approval_id": id,
		"kind":        req.Kind,
		"payload":     json.RawMessage(req.Payload),
	}
	if a.ExecutionID != nil {
		evMap["execution_id"] = *a.ExecutionID
	}
	if a.ExecutionAgent != nil {
		evMap["execution_agent"] = *a.ExecutionAgent
		evMap["agent"] = *a.ExecutionAgent
		evMap["speaker"] = *a.ExecutionAgent
	}
	if a.ExecutionStep != nil {
		evMap["execution_step"] = *a.ExecutionStep
	}
	if a.ExecutionModel != nil {
		evMap["execution_model"] = *a.ExecutionModel
		evMap["model"] = *a.ExecutionModel
	}
	evPayload, _ := json.Marshal(evMap)
	if _, err := e.appendEventLocked(ctx, req.TaskID, "approval_requested", evPayload); err != nil {
		return store.Approval{}, fmt.Errorf("persist approval_requested: %w", err)
	}
	e.bus.PublishApproval(a)

	if e.notify != nil {
		title := "Approval needed"
		if t.Title != "" {
			title = t.Title
		}
		e.notify.NotifyApproval(ctx, a.ID, a.TaskID, title)
	}

	return a, nil
}

// Decide records an approval decision from the web console (or expiry path).
// decision must be approved|denied|expired; via is "web" or "timeout".
func (e *Engine) Decide(ctx context.Context, id, decision, via string) (store.Approval, error) {
	switch decision {
	case store.DecisionApproved, store.DecisionDenied, store.DecisionExpired:
	default:
		return store.Approval{}, fmt.Errorf("invalid decision %q", decision)
	}

	now := e.nowMilli()
	a, err := e.store.DecideApproval(ctx, id, decision, via, now)
	if err != nil {
		if errors.Is(err, store.ErrAlreadyDecided) {
			return store.Approval{}, ErrAlreadyDecided
		}
		return store.Approval{}, err
	}

	// Notify long-poll waiters.
	e.notifyApprovalWaiters(id, a)

	// Event + task status. Losing approval_decided would make the audit trail
	// incomplete; surface the error even though the decision row is stored.
	evPayload, _ := json.Marshal(map[string]any{
		"approval_id": id,
		"decision":    decision,
		"decided_via": via,
	})
	if _, err := e.appendEventLocked(ctx, a.TaskID, "approval_decided", evPayload); err != nil {
		e.bus.PublishApproval(a)
		return a, fmt.Errorf("persist approval_decided: %w", err)
	}

	// Resume task to running if still waiting (process is blocked on MCP).
	t, err := e.store.GetTask(ctx, a.TaskID)
	if err == nil && (t.Status == StatusWaitingApproval || t.Status == StatusWaitingInput) {
		// Only resume if no other pending approvals or user questions for this task.
		pending, _ := e.store.ListPendingForTask(ctx, a.TaskID)
		pendingQ, _ := e.store.ListPendingUserQuestionsForTask(ctx, a.TaskID)
		if len(pending) == 0 && len(pendingQ) == 0 {
			status := StatusRunning
			_ = e.store.UpdateTask(ctx, a.TaskID, store.TaskPatch{Status: &status})
			if t2, err := e.store.GetTask(ctx, a.TaskID); err == nil {
				e.bus.PublishTask(t2)
			}
		}
	}

	e.bus.PublishApproval(a)
	return a, nil
}

// GetApproval returns one approval.
func (e *Engine) GetApproval(ctx context.Context, id string) (store.Approval, error) {
	return e.store.GetApproval(ctx, id)
}

// ListApprovals lists approvals with optional status filter.
func (e *Engine) ListApprovals(ctx context.Context, opts store.ListApprovalsOpts) ([]store.Approval, error) {
	return e.store.ListApprovals(ctx, opts)
}

// WaitApproval long-polls until the approval is decided or timeout elapses.
// Also enforces expiry: pending older than TTL becomes expired (deny).
func (e *Engine) WaitApproval(ctx context.Context, id string, timeout time.Duration) (store.Approval, error) {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if timeout > 30*time.Second {
		timeout = 30 * time.Second
	}

	a, err := e.store.GetApproval(ctx, id)
	if err != nil {
		return store.Approval{}, err
	}
	if a.Decision != store.DecisionPending {
		return a, nil
	}
	// Check expiry before waiting.
	if expired, err := e.maybeExpire(ctx, a); err != nil {
		return store.Approval{}, err
	} else if expired.Decision != store.DecisionPending {
		return expired, nil
	}

	ch := e.registerApprovalWaiter(id)
	defer e.unregisterApprovalWaiter(id, ch)

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return e.store.GetApproval(ctx, id)
		case <-timer.C:
			// Final check for decision/expiry after timeout.
			a, err := e.store.GetApproval(ctx, id)
			if err != nil {
				return store.Approval{}, err
			}
			if a.Decision == store.DecisionPending {
				if expired, err := e.maybeExpire(ctx, a); err != nil {
					return store.Approval{}, err
				} else {
					return expired, nil
				}
			}
			return a, nil
		case a := <-ch:
			return a, nil
		}
	}
}

func (e *Engine) maybeExpire(ctx context.Context, a store.Approval) (store.Approval, error) {
	if a.Decision != store.DecisionPending {
		return a, nil
	}
	ttl := e.approvalTTL
	if ttl <= 0 {
		ttl = store.DefaultApprovalTTL
	}
	age := e.now().Sub(time.UnixMilli(a.CreatedAt))
	if age < ttl {
		return a, nil
	}
	return e.expireApproval(ctx, a.ID)
}

// expireApproval ends a question nobody answered, tolerating a person who
// answered it in the same instant.
//
// The conflict is not an error to pass on: their decision is the answer the
// caller has been waiting for, and a waiter that only saw the conflict would go
// on waiting for an answer that is already there.
func (e *Engine) expireApproval(ctx context.Context, id string) (store.Approval, error) {
	expired, err := e.Decide(ctx, id, store.DecisionExpired, "timeout")
	if errors.Is(err, ErrAlreadyDecided) {
		return e.store.GetApproval(ctx, id)
	}
	return expired, err
}

// ExpireStale marks all pending approvals older than TTL as expired.
// Returns how many were expired. Safe to call periodically.
func (e *Engine) ExpireStale(ctx context.Context) (int, error) {
	ttl := e.approvalTTL
	if ttl <= 0 {
		ttl = store.DefaultApprovalTTL
	}
	cutoff := e.now().Add(-ttl).UnixMilli()
	list, err := e.store.ListPendingOlderThan(ctx, cutoff)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, a := range list {
		if _, err := e.Decide(ctx, a.ID, store.DecisionExpired, "timeout"); err != nil {
			if errors.Is(err, ErrAlreadyDecided) {
				continue
			}
			return n, err
		}
		n++
	}
	return n, nil
}

// StartExpiryLoop runs ExpireStale every interval until ctx is done.
func (e *Engine) StartExpiryLoop(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-e.ctx.Done():
				return
			case <-t.C:
				_, _ = e.ExpireStale(context.Background())
				_, _ = e.ExpireStaleUserQuestions(context.Background())
			}
		}
	}()
}

func (e *Engine) registerApprovalWaiter(id string) chan store.Approval {
	ch := make(chan store.Approval, 1)
	e.mu.Lock()
	if e.approvalWaiters == nil {
		e.approvalWaiters = make(map[string][]chan store.Approval)
	}
	e.approvalWaiters[id] = append(e.approvalWaiters[id], ch)
	e.mu.Unlock()
	return ch
}

func (e *Engine) unregisterApprovalWaiter(id string, ch chan store.Approval) {
	e.mu.Lock()
	defer e.mu.Unlock()
	list := e.approvalWaiters[id]
	for i, c := range list {
		if c == ch {
			e.approvalWaiters[id] = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(e.approvalWaiters[id]) == 0 {
		delete(e.approvalWaiters, id)
	}
}

func (e *Engine) notifyApprovalWaiters(id string, a store.Approval) {
	e.mu.Lock()
	list := e.approvalWaiters[id]
	delete(e.approvalWaiters, id)
	e.mu.Unlock()
	for _, ch := range list {
		select {
		case ch <- a:
		default:
		}
	}
}

// pendingFollowUp is applied after an in-flight turn is interrupted so the user
// can stop the current agent and immediately inject a new guiding prompt.
type pendingFollowUp struct {
	req       FollowUpRequest
	fromAgent string
	// interrupted marks that the previous turn was cut short.
	interrupted bool
}

// FollowUp re-queues a terminal task for a new prompt (spec §6 M2).
// When the task is still running / waiting_approval, the prompt is queued and
// delivered at the next turn boundary (see FollowUpWith for the interrupting
// variant).
func (e *Engine) FollowUp(ctx context.Context, id, prompt string) (store.Task, error) {
	return e.FollowUpWith(ctx, id, FollowUpRequest{Prompt: prompt})
}

// FollowUpWith supports same-agent resume, cross-agent handoff, and a follow-up
// during a live turn.
//
//   - agent empty or same: resume via session_ref when present; otherwise inject recent transcript.
//   - agent different: clear session_ref, switch task.agent, inject handoff context into prompt.
//   - task running / waiting_approval / waiting_input / queued: hold the prompt in the
//     task's queue and deliver it at the next turn boundary, oldest first. Nothing in
//     flight is cancelled, no pending approval is denied, no pending question is
//     answered on the user's behalf. Set req.Interrupt to cut the turn short instead
//     and deliver next -- that path answers and denies the same way, on purpose,
//     because the process it is talking to is about to die.
func (e *Engine) FollowUpWith(ctx context.Context, id string, req FollowUpRequest) (store.Task, error) {
	e.retryMu.Lock()
	defer e.retryMu.Unlock()

	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return store.Task{}, fmt.Errorf("prompt is required")
	}
	req.Prompt = prompt

	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	e.mu.Lock()
	finalizing := e.workspaceCommitting[id]
	e.mu.Unlock()
	if finalizing != "" {
		return t, fmt.Errorf("%w: workspace finalization is in progress", ErrConflict)
	}

	// A task with nothing in flight is waiting for exactly this prompt, so it is
	// delivered now. A task that is still working keeps it in its queue instead:
	// the work in flight is the user's work, and cancelling it to make room for a
	// message that was not urgent costs them more than the wait does.
	switch t.Status {
	case StatusSucceeded, StatusFailed, StatusCanceled:
		return e.queuedFollowUp(ctx, id, t, req, true /*deliverNow*/)
	case StatusRunning, StatusWaitingApproval, StatusWaitingInput, StatusQueued:
		if req.Interrupt {
			return e.interruptAndFollowUp(ctx, id, t, req)
		}
		return e.queuedFollowUp(ctx, id, t, req, false /*deliverNow*/)
	default:
		return store.Task{}, fmt.Errorf("%w: task status %s cannot accept prompt", ErrConflict, t.Status)
	}
}

// queuedFollowUp accepts a prompt for a task and records it as the newest message
// waiting to be delivered. When deliverNow is set the task has no turn to wait
// for, so the queue is drained immediately -- through the queue rather than
// around it, so that a message still waiting from earlier keeps its place.
//
// The queue is the only way a prompt enters a busy task, which is what makes
// ordering one rule instead of one rule per entry point: appended at the tail,
// delivered from the head, one per turn.
func (e *Engine) queuedFollowUp(ctx context.Context, id string, t store.Task, req FollowUpRequest, deliverNow bool) (store.Task, error) {
	// An agent that cannot be resolved is refused while the sender is still
	// listening, rather than discovered at a turn boundary nobody is watching.
	if req.Agent != "" && req.Agent != t.Agent && !e.HasAgent(req.Agent) {
		return store.Task{}, fmt.Errorf("unknown or unavailable agent %q", req.Agent)
	}
	// The visible copy comes first: a message the user can see and then gets an
	// error about is a message they can resend. The reverse -- a queue row with
	// no message in the chat -- is a silent hole in the conversation.
	userSeq := e.appendUserGuideEvent(ctx, id, t, req, false /*interrupted*/)
	if _, err := e.store.AppendPendingPrompt(ctx, store.PendingPrompt{
		TaskID:         id,
		Prompt:         req.Prompt,
		Agent:          req.Agent,
		Model:          req.Model,
		PermissionMode: req.PermissionMode,
		UserSeq:        userSeq,
	}); err != nil {
		return store.Task{}, err
	}
	if !deliverNow {
		return e.store.GetTask(ctx, id)
	}
	t2, _, err := e.deliverQueuedPrompt(ctx, id)
	return t2, err
}

// deliverQueuedPrompt starts the turn that answers the oldest message a task has
// waiting. ok is false when nothing was waiting, which is a normal outcome at a
// turn boundary (two boundaries can race for the same last message).
//
// The message is taken off the queue before it is applied, so a failure here
// means the prompt is gone from the queue and the caller owes the user an
// error event naming it: it was visible in the chat, and it will not be
// answered by anything else.
func (e *Engine) deliverQueuedPrompt(ctx context.Context, id string) (store.Task, bool, error) {
	p, ok, err := e.store.PopPendingPrompt(ctx, id)
	if err != nil || !ok {
		return store.Task{}, false, err
	}
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, true, err
	}
	// interrupted=false on purpose: this message did not cut anything short, and
	// telling the agent that its previous turn was interrupted by the user would
	// make it re-read context it does not need and drop the session it can resume.
	t2, err := e.applyFollowUpPrepared(ctx, id, t, followUpRequestFrom(p), false /*interrupted*/, p.UserSeq)
	return t2, true, err
}

// deliverQueuedAfterRestart delivers the oldest prompt a task had waiting when
// the daemon died. There is no run to attribute an error to at this point, so a
// failure is reported as a task event; the rest of the queue stays where it is,
// to be delivered by the turn this one starts (or by the next restart).
func (e *Engine) deliverQueuedAfterRestart(ctx context.Context, id string) {
	t, ok, err := e.deliverQueuedPrompt(ctx, id)
	if !ok {
		return
	}
	if err != nil {
		payload, _ := json.Marshal(map[string]string{
			"message": "queued prompt could not be delivered after the restart: " + err.Error(),
		})
		if ev, appendErr := e.store.AppendEvent(ctx, id, "error", payload); appendErr == nil {
			e.bus.PublishEvent(ev)
		}
		return
	}
	e.bus.PublishTask(t)
}

// followUpRequestFrom rebuilds the request a queued message was accepted with.
// The optional fields have to survive the round trip intact: nil means "leave the
// task's setting alone", while a pointer to "" means "clear it".
func followUpRequestFrom(p store.PendingPrompt) FollowUpRequest {
	return FollowUpRequest{
		Prompt:         p.Prompt,
		Agent:          p.Agent,
		Model:          p.Model,
		PermissionMode: p.PermissionMode,
	}
}

// interruptAndFollowUp stops the in-flight turn and schedules req to run next.
func (e *Engine) interruptAndFollowUp(ctx context.Context, id string, t store.Task, req FollowUpRequest) (store.Task, error) {
	// Validate agent early so we do not cancel then fail.
	if req.Agent != "" && req.Agent != t.Agent {
		if !e.HasAgent(req.Agent) {
			return store.Task{}, fmt.Errorf("unknown or unavailable agent %q", req.Agent)
		}
	}

	// Deny pending approvals so MCP waiters unblock before we kill the process.
	if pending, err := e.store.ListPendingForTask(ctx, id); err == nil {
		for _, a := range pending {
			_, _ = e.Decide(ctx, a.ID, store.DecisionDenied, "web")
		}
	}
	// Resolve pending user questions the same way so ask_user_question long-polls unblock.
	if pending, err := e.store.ListPendingUserQuestionsForTask(ctx, id); err == nil {
		for _, q := range pending {
			_, _ = e.AnswerUserQuestion(ctx, q.ID, AnswerUserQuestionRequest{}, "interrupt")
		}
	}

	e.mu.Lock()
	if e.workspaceCommitting[id] != "" {
		e.mu.Unlock()
		return t, fmt.Errorf("%w: workspace finalization is in progress", ErrConflict)
	}
	// If still only queued (not started), drop from queue and apply immediately.
	for i, qid := range e.queue {
		if qid == id {
			e.queue = append(e.queue[:i], e.queue[i+1:]...)
			e.mu.Unlock()
			// Still non-terminal; force a clean re-queue path by finishing first.
			// applyFollowUpPrepared expects a task with nothing in flight, so finish
			// as canceled, then apply -- and let it write the user event, since
			// nothing has been published for this prompt yet.
			if _, err := e.finishQueued(ctx, id, StatusCanceled, nil, nil); err != nil {
				return store.Task{}, err
			}
			t2, err := e.store.GetTask(ctx, id)
			if err != nil {
				return store.Task{}, err
			}
			return e.applyFollowUpPrepared(ctx, id, t2, req, true /*interrupted*/, 0 /*write the user event*/)
		}
	}

	h := e.handles[id]
	group := e.handleGroups[id]
	e.canceled[id] = true
	e.pendingFollowUp[id] = pendingFollowUp{
		req:         req,
		fromAgent:   t.Agent,
		interrupted: true,
	}
	e.mu.Unlock()

	// Surface the user guide immediately so the chat is not locked waiting for process death.
	userSeq := e.appendUserGuideEvent(ctx, id, t, req, true /*interrupted*/)

	if h != nil {
		_ = h.Cancel()
	}
	for _, gh := range group {
		_ = gh.Cancel()
	}

	// If nothing was running (race), apply now.
	if h == nil && len(group) == 0 {
		e.mu.Lock()
		pf, ok := e.pendingFollowUp[id]
		delete(e.pendingFollowUp, id)
		delete(e.canceled, id)
		e.mu.Unlock()
		if ok {
			if _, err := e.finishQueued(ctx, id, StatusCanceled, nil, nil); err != nil {
				return store.Task{}, err
			}
			t2, err := e.store.GetTask(ctx, id)
			if err != nil {
				return store.Task{}, err
			}
			// The user event was appended above, so the checkpoint anchors there
			// rather than to whatever happens to be the newest user message.
			return e.applyFollowUpPrepared(ctx, id, t2, pf.req, true /*interrupted*/, userSeq)
		}
	}

	// Keep task in a non-terminal visual state while the process winds down.
	// Cancel() path may have already stamped canceled; re-read and publish.
	if t2, err := e.store.GetTask(ctx, id); err == nil {
		e.bus.PublishTask(t2)
		return t2, nil
	}
	return t, nil
}

// applyPendingFollowUp is invoked from runLoop / finishOrchestrated after interrupt.
func (e *Engine) applyPendingFollowUp(ctx context.Context, id string, pf pendingFollowUp) (store.Task, error) {
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	// Re-queue directly (StatusQueued). Avoid a canceled → queued flash when possible.
	// The user guide event was already appended at interrupt time, so the newest
	// user message in the stream is this one -- looked up here rather than carried
	// on the struct, which is as precise as this path has ever been.
	userSeq := e.latestUserMessageSeq(ctx, id)
	return e.applyFollowUpPrepared(ctx, id, t, pf.req, pf.interrupted, userSeq)
}

// applyFollowUpPrepared patches the task prompt/agent and re-queues it.
//
// userSeq is the seq of the user message event this delivery answers. Pass 0
// when the event has not been written yet and this call should write it; pass
// the existing seq when the message was already visible -- it was interrupted
// into, or queued while the previous turn was still running. The distinction is
// the checkpoint anchor: a turn that claims a newer message than the one it is
// answering restores to the wrong point.
func (e *Engine) applyFollowUpPrepared(ctx context.Context, id string, t store.Task, req FollowUpRequest, interrupted bool, userSeq int) (store.Task, error) {
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return store.Task{}, fmt.Errorf("prompt is required")
	}

	fromAgent := t.Agent
	targetAgent := t.Agent
	handoff := false

	if req.Agent != "" && req.Agent != t.Agent {
		if !e.HasAgent(req.Agent) {
			return store.Task{}, fmt.Errorf("unknown or unavailable agent %q", req.Agent)
		}
		targetAgent = req.Agent
		handoff = true
	}

	// Resolve the host model baseline for this turn (current task model, optionally
	// overridden by FollowUpRequest.Model). Used for same-agent model-switch detection.
	hostModel := ""
	if t.Model != nil {
		hostModel = strings.TrimSpace(*t.Model)
	}
	modelSwitch := false
	setModel := false
	clearModel := false
	resolvedModel := ""
	if req.Model != nil {
		m := strings.TrimSpace(*req.Model)
		if m == "" {
			clearModel = true
			if hostModel != "" {
				modelSwitch = true
			}
			hostModel = ""
		} else {
			// An explicit API/UI model selection is an opaque adapter value. Do not
			// expand stable CLI aliases through BuiltinCatalog: that catalog is only
			// advisory for natural-language routing and may contain stale full IDs.
			setModel = true
			resolvedModel = m
			if !modelsEqual(m, hostModel) {
				modelSwitch = true
			}
			hostModel = m
		}
	}

	// Multi-@ is decided from the *current* user message only. Prior transcript
	// @mentions must not force orchestration on a plain follow-up (mixed modes).
	// Bare @host is not self-delegation; @host[otherModel] is a model-switch worker.
	plan := ParseDelegatePlan(UserTurnPrompt(prompt), AvailableSet(e.AgentIDs()))
	orchestrate := plan.HasDelegateWorkers(targetAgent, hostModel)

	// Cross-turn context strategy (ADR 0002 Policy K):
	//   - same-agent resume-capable host with live session → append-only live user prompt
	//   - handoff / interrupt / orchestrate / model-switch / no-session → sealed Context Pack
	// Orchestrated turns still store the user request under "User request:" so
	// UserTurnPrompt / shouldOrchestrate only see the live @mentions.
	runPrompt := prompt
	targetReg, _ := e.agents.Get(targetAgent)
	canResume := targetReg.Descriptor.Has(agent.CapabilityResume)
	// Kin-style managed transcript: SessionHooks + private kin_messages (session_ref
	// alone is not enough — Kin's session_id is synthetic and carries no history).
	managedTranscript := targetReg.Sessions != nil
	hasManagedHistory := managedTranscript && e.hostTranscriptNonEmpty(ctx, id)
	// Model switch clears session continuity: adapters must see TaskSpec.Model on a
	// fresh Start rather than a resume that silently keeps the old model.
	sameAgentResume := !handoff && !interrupted && !orchestrate && !modelSwitch && canResume && fromAgent == targetAgent
	if managedTranscript {
		// Resume only when private transcript has history. Empty after orchestrate
		// clear (or never seeded) must rebuild a sealed pack from events.
		sameAgentResume = sameAgentResume && hasManagedHistory
	} else {
		sameAgentResume = sameAgentResume && t.SessionRef != nil && *t.SessionRef != ""
	}
	if sameAgentResume {
		// Live user turn only; CLI resumes via session_ref / Kin loads private messages.
		runPrompt = prompt
	} else {
		ctxBlock := e.handoffContext(ctx, id)
		needContext := handoff || interrupted || orchestrate || modelSwitch || managedTranscript ||
			t.SessionRef == nil || *t.SessionRef == ""
		if needContext && (handoff || interrupted || ctxBlock != "" || orchestrate || managedTranscript || modelSwitch) {
			runPrompt = formatHandoffPrompt(fromAgent, targetAgent, ctxBlock, prompt)
			if interrupted {
				runPrompt = "The previous turn was interrupted by the user. Treat the request below as the new guidance.\n\n" + runPrompt
			}
		}
		// Cold prefix: reset plugin session state so we don't mix packs with resume.
		if handoff || interrupted || orchestrate || modelSwitch {
			e.resetAgentSession(ctx, fromAgent, id)
			if targetAgent != fromAgent {
				e.resetAgentSession(ctx, targetAgent, id)
			}
		} else if managedTranscript {
			// Empty-history pack rebuild: keep table empty / clear any partial state.
			e.resetAgentSession(ctx, targetAgent, id)
		}
	}

	status := StatusQueued
	patch := store.TaskPatch{
		Status:          &status,
		Prompt:          &runPrompt,
		ClearExitCode:   true,
		ClearFinishedAt: true,
	}
	if handoff {
		patch.Agent = &targetAgent
		patch.ClearSessionRef = true
	}
	if clearModel {
		patch.ClearModel = true
	} else if setModel {
		patch.Model = &resolvedModel
	}
	// Permission mode is per-turn like model, but it is not part of transcript
	// identity: changing it keeps session continuity (no ClearSessionRef).
	if req.PermissionMode != nil {
		perm := adapter.NormalizePermissionMode(*req.PermissionMode)
		patch.PermissionMode = &perm
	}
	// Fresh sessions for multi-@, handoff, or model switch.
	if orchestrate || modelSwitch {
		patch.ClearSessionRef = true
	}
	// Interrupt always starts a clean turn (CLI may have left a half-finished session).
	if interrupted {
		// Keep session_ref only when same agent and not orchestrating — resume is best-effort.
		if handoff || orchestrate || modelSwitch {
			patch.ClearSessionRef = true
		}
	}
	if err := e.store.UpdateTask(ctx, id, patch); err != nil {
		return store.Task{}, err
	}
	if handoff {
		if err := e.store.DetachTaskAgentSessions(ctx, id, "cross-agent handoff"); err != nil {
			return store.Task{}, err
		}
	}
	e.invalidateActiveRun(id)
	e.clearPersistTracking(id)
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	e.bus.PublishTask(t)

	if userSeq < 1 {
		userSeq = e.appendUserGuideEvent(ctx, id, t, req, interrupted)
	}
	if userSeq > 0 {
		e.captureCheckpoint(ctx, t, userSeq)
	}

	e.mu.Lock()
	e.queue = append(e.queue, id)
	e.mu.Unlock()
	e.pump()

	return e.store.GetTask(ctx, id)
}

func (e *Engine) appendUserGuideEvent(ctx context.Context, id string, t store.Task, req FollowUpRequest, interrupted bool) int {
	prompt := req.Prompt
	fromAgent := t.Agent
	targetAgent := t.Agent
	handoff := req.Agent != "" && req.Agent != t.Agent
	if handoff {
		targetAgent = req.Agent
	}
	plan := ParseDelegatePlan(UserTurnPrompt(prompt), AvailableSet(e.AgentIDs()))
	hostModel := ""
	if t.Model != nil {
		hostModel = strings.TrimSpace(*t.Model)
	}
	if req.Model != nil {
		if m := strings.TrimSpace(*req.Model); m != "" {
			hostModel = m
		}
	}
	orchestrate := plan.HasDelegateWorkers(targetAgent, hostModel)

	meta := map[string]any{
		"role":    "user",
		"content": []map[string]string{{"type": "text", "text": prompt}},
		"partial": false,
		"source":  "follow_up",
		"agent":   "user",
		"speaker": "user",
	}
	if interrupted {
		meta["source"] = "interrupt"
		meta["interrupted"] = true
	}
	if handoff {
		meta["source"] = "handoff"
		meta["from_agent"] = fromAgent
		meta["to_agent"] = targetAgent
	}
	if orchestrate {
		meta["source"] = "orchestrate"
	}
	evPayload, _ := json.Marshal(meta)
	if ev, err := e.store.AppendEvent(ctx, id, "message", evPayload); err == nil {
		e.bus.PublishEvent(ev)
		return ev.Seq
	}
	return 0
}

func (e *Engine) latestUserMessageSeq(ctx context.Context, id string) int {
	evs, err := e.store.ListEvents(ctx, id, 0)
	if err != nil {
		return 0
	}
	for i := len(evs) - 1; i >= 0; i-- {
		ev := evs[i]
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		if json.Unmarshal(ev.Payload, &m) != nil {
			continue
		}
		role, _ := m["role"].(string)
		speaker, _ := m["speaker"].(string)
		if role == "user" || speaker == "user" {
			return ev.Seq
		}
	}
	return 0
}

// RetryRequest is the body for POST /api/tasks/{id}/retry.
// FromSeq may be a user message or an assistant reply; the engine rewinds to the
// nearest user turn at or before FromSeq and re-runs from there.
// When FromSeq is 0, the last user turn is used.
type RetryRequest struct {
	FromSeq      int   `json:"from_seq,omitempty"`
	RestoreFiles *bool `json:"restore_files,omitempty"`
}

// ForkRequest is the body for POST /api/tasks/{id}/fork.
// FromSeq is the last event seq to keep (inclusive) — typically an assistant reply
// so the branch includes that answer and everything before it. When 0, copies the full transcript.
// Prompt optional: when set, appends a new user message and runs it on the forked task.
type ForkRequest struct {
	FromSeq int    `json:"from_seq,omitempty"`
	Prompt  string `json:"prompt,omitempty"`
	Agent   string `json:"agent,omitempty"`
}

// ErrNotTerminal is returned when retry/fork requires a finished task.
var ErrNotTerminal = errors.New("task is not terminal")

// ErrInvalidSeq is returned when from_seq does not point at a usable user turn.
var ErrInvalidSeq = errors.New("invalid from_seq")

// Retry rewinds a terminal task to a user turn and re-runs from there (same task id).
// Events with seq >= fromSeq are dropped; the user message is re-seeded and the task re-queued.
func (e *Engine) Retry(ctx context.Context, id string, req RetryRequest) (store.Task, error) {
	e.retryMu.Lock()
	defer e.retryMu.Unlock()

	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	if !isTerminalStatus(t.Status) {
		return store.Task{}, ErrNotTerminal
	}

	evs, err := e.store.ListEvents(ctx, id, 0)
	if err != nil {
		return store.Task{}, err
	}
	fromSeq, userText, err := resolveUserTurn(evs, req.FromSeq, t.Prompt)
	if err != nil {
		return store.Task{}, err
	}

	restoreFiles := t.WorkspaceMode == string(workspace.ResolvedWorktree)
	if req.RestoreFiles != nil {
		restoreFiles = *req.RestoreFiles
	}
	// Capture prior context BEFORE truncate (events with seq < fromSeq).
	priorCtx := e.handoffContextUpTo(ctx, id, fromSeq-1)

	// Build run prompt: inject prior transcript when rewinding past the first turn
	// (mirrors applyFollowUpPrepared needContext path).
	runPrompt := userText
	if priorCtx != "" {
		runPrompt = priorCtx + "\n\n---\n\n" + userText
	}

	userPayload, _ := json.Marshal(map[string]any{
		"role":           "user",
		"content":        []map[string]string{{"type": "text", "text": userText}},
		"partial":        false,
		"agent":          "user",
		"speaker":        "user",
		"source":         "retry",
		"retry_from_seq": fromSeq,
	})
	if restoreFiles {
		if t.WorkspaceMode != string(workspace.ResolvedWorktree) {
			return store.Task{}, workspace.ErrNotIsolated
		}
		if e.workspace == nil {
			return store.Task{}, workspace.ErrCheckpointUnavailable
		}
		cp, err := e.store.GetCheckpoint(ctx, id, fromSeq)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return store.Task{}, workspace.ErrCheckpointUnavailable
			}
			return store.Task{}, err
		}
		target, rollback, unlock, err := e.planRetryRestore(ctx, t)
		if err != nil {
			return store.Task{}, err
		}
		defer unlock()
		intent := store.RetryRestoreIntent{
			TaskID: id, RestoreFiles: true,
			FromSeq: fromSeq, ExpectedEventEpoch: t.EventEpoch,
			Prompt: runPrompt, UserPayload: userPayload, Checkpoint: cp,
			RollbackCheckpoint: rollback, Target: target.generationValue(),
			TargetIsNew: target.generation != nil, ActivateTarget: target.activate,
		}
		if err := e.store.BeginRetryRestore(ctx, intent); err != nil {
			return store.Task{}, err
		}
		result, compensated, err := e.resolveRetryRestoreIntent(ctx, intent, true)
		if err != nil {
			if compensated {
				return store.Task{}, err
			}
			return store.Task{}, fmt.Errorf("retry restore left pending for startup recovery: %w", err)
		}
		if err := e.publishCompletedRetry(ctx, result, false, true); err != nil {
			return result.Task, err
		}
		return result.Task, nil
	}

	intent := store.RetryRestoreIntent{
		TaskID: id, RestoreFiles: false,
		FromSeq: fromSeq, ExpectedEventEpoch: t.EventEpoch,
		Prompt: runPrompt, UserPayload: userPayload,
	}
	current, currentErr := e.store.GetCurrentWorkspace(ctx, id)
	if currentErr == nil {
		intent.Target = current
	} else if !errors.Is(currentErr, store.ErrNotFound) {
		return store.Task{}, currentErr
	} else if t.WorkspaceMode == string(workspace.ResolvedWorktree) {
		target, _, unlock, planErr := e.planRetryRestore(ctx, t)
		if planErr != nil {
			return store.Task{}, planErr
		}
		defer unlock()
		intent.Target = target.generationValue()
		intent.TargetIsNew = true
	}
	if err := e.store.BeginRetryRestore(ctx, intent); err != nil {
		return store.Task{}, err
	}
	result, compensated, err := e.resolveRetryRestoreIntent(ctx, intent, true)
	if err != nil {
		if compensated {
			return store.Task{}, err
		}
		return store.Task{}, fmt.Errorf("retry left pending for startup recovery: %w", err)
	}
	if err := e.publishCompletedRetry(
		ctx,
		result,
		t.WorkspaceMode == string(workspace.ResolvedWorktree),
		true,
	); err != nil {
		return result.Task, err
	}
	return result.Task, nil
}

func (e *Engine) publishCompletedRetry(
	_ context.Context, result store.RetryMutationResult, captureFiles, start bool,
) error {
	t := result.Task
	resumeCtx, cancel := context.WithTimeout(e.ctx, 30*time.Second)
	defer cancel()
	e.invalidateActiveRun(t.ID)
	e.clearPersistTracking(t.ID)
	if err := e.resetAgentSessionStrict(resumeCtx, t.Agent, t.ID); err != nil {
		return fmt.Errorf("reset retry session: %w", err)
	}
	e.mu.Lock()
	delete(e.canceled, t.ID)
	e.mu.Unlock()
	// Publish the incremented event_epoch before any reused event sequence.
	e.bus.PublishTask(t)
	if result.WorkspaceEvent != nil {
		e.bus.PublishEvent(*result.WorkspaceEvent)
	}
	e.bus.PublishEvent(result.UserEvent)

	if captureFiles {
		e.captureCheckpoint(resumeCtx, t, result.UserEvent.Seq)
	}

	e.mu.Lock()
	e.queue = append(e.queue, t.ID)
	e.mu.Unlock()
	if start {
		e.pump()
	}
	return nil
}

// RestoreWorkspace materializes a prior checkpoint into the isolated worktree without
// truncating the transcript. eventSeq 0 (or negative) selects the earliest checkpoint;
// a positive value selects the latest checkpoint at or before that sequence.
// Requires a terminal, worktree-isolated task.
func (e *Engine) RestoreWorkspace(ctx context.Context, taskID string, eventSeq int) (store.Task, error) {
	e.retryMu.Lock()
	defer e.retryMu.Unlock()

	t, err := e.store.GetTask(ctx, taskID)
	if err != nil {
		return store.Task{}, err
	}
	switch t.Status {
	case StatusSucceeded, StatusFailed, StatusCanceled:
		// allowed
	default:
		return store.Task{}, ErrConflict
	}
	if t.WorkspaceMode != string(workspace.ResolvedWorktree) {
		return store.Task{}, workspace.ErrNotIsolated
	}
	if e.workspace == nil {
		return store.Task{}, workspace.ErrCheckpointUnavailable
	}

	var cp store.TaskCheckpoint
	if eventSeq <= 0 {
		cp, err = e.store.GetInitialCheckpoint(ctx, taskID)
	} else {
		cp, err = e.store.GetCheckpointAtOrBefore(ctx, taskID, eventSeq)
	}
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.Task{}, workspace.ErrCheckpointUnavailable
		}
		return store.Task{}, err
	}

	target, err := e.prepareCheckpointRestoreTarget(ctx, t, cp)
	if err != nil {
		return store.Task{}, err
	}
	defer target.unlock()
	if err := e.restoreCheckpointIntoTarget(ctx, taskID, target, cp); err != nil {
		if target.generation != nil {
			_ = e.workspace.CleanupPrepared(context.Background(), taskID, target.meta)
		}
		return store.Task{}, err
	}
	if err := e.commitCheckpointRestoreTarget(ctx, target); err != nil {
		if target.generation != nil {
			_ = e.workspace.CleanupPrepared(context.Background(), taskID, target.meta)
		}
		return store.Task{}, err
	}

	// Audit-only meta event; do not change task status.
	payload, _ := json.Marshal(map[string]any{
		"event_seq": cp.EventSeq,
	})
	if ev, appendErr := e.store.AppendEvent(ctx, taskID, "workspace_restored", payload); appendErr == nil {
		e.bus.PublishEvent(ev)
	}

	return e.store.GetTask(ctx, taskID)
}

// Fork creates a new task that shares the transcript prefix up to fromSeq, then optionally continues with prompt.
func (e *Engine) Fork(ctx context.Context, id string, req ForkRequest) (store.Task, error) {
	e.retryMu.Lock()
	defer e.retryMu.Unlock()

	src, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	// Fork is allowed while running (branch from a past point) or terminal.
	// We only copy events; we never mutate the source task.

	evs, err := e.store.ListEvents(ctx, id, 0)
	if err != nil {
		return store.Task{}, err
	}
	if len(evs) == 0 {
		return store.Task{}, ErrInvalidSeq
	}

	maxSeq := req.FromSeq
	if maxSeq <= 0 {
		// Default: last event (full branch) — or last user message if we want branch-from-message UX.
		// Prefer last user message so forking from the latest prompt is natural.
		_, _, err := resolveUserTurn(evs, 0, src.Prompt)
		if err != nil {
			maxSeq = evs[len(evs)-1].Seq
		} else {
			// resolveUserTurn returns the user msg seq; for fork we keep through that user msg only
			// when branching "from this message" — caller should pass the user message seq.
			// Default when 0: copy everything.
			maxSeq = evs[len(evs)-1].Seq
		}
	}

	// Validate maxSeq exists.
	found := false
	for _, ev := range evs {
		if ev.Seq == maxSeq {
			found = true
			break
		}
	}
	if !found {
		return store.Task{}, ErrInvalidSeq
	}

	newID, err := e.newID()
	if err != nil {
		return store.Task{}, err
	}

	agent := src.Agent
	if a := strings.TrimSpace(req.Agent); a != "" {
		if !e.HasAgent(a) {
			return store.Task{}, fmt.Errorf("unknown agent %q", a)
		}
		agent = a
	}

	// Prompt for the new task: optional new prompt, else last user text in the prefix.
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		if _, userText, err := resolveUserTurn(evs, 0, src.Prompt); err == nil {
			// Prefer last user message that is within the prefix.
			if ut, ok := lastUserTextUpTo(evs, maxSeq); ok {
				prompt = ut
			} else {
				prompt = userText
			}
		} else if ut, ok := lastUserTextUpTo(evs, maxSeq); ok {
			prompt = ut
		} else {
			prompt = src.Prompt
		}
	}

	title := TruncateTitle(src.Title, TitleMaxRunes)
	if title == "" {
		title = TruncateTitle(prompt, TitleMaxRunes)
	}
	// Mark forked sessions in title lightly if not already.
	if !strings.HasPrefix(title, "Fork · ") && !strings.HasPrefix(title, "Fork: ") {
		title = TruncateTitle("Fork · "+title, TitleMaxRunes)
	}

	now := e.nowMilli()
	// If caller supplied a new prompt, we will append it and queue; otherwise leave as succeeded snapshot?
	// Product: fork always creates a branch ready to continue. If prompt provided → queue; else → succeeded copy for browsing + follow-up.
	status := StatusSucceeded
	runNow := strings.TrimSpace(req.Prompt) != ""
	if runNow {
		status = StatusQueued
	}

	// The workspace identity travels with the cwd, because a cwd on its own is an
	// address on whichever machine wrote it. A source that never got one — a task
	// created before its device reported that root — gets one derived now.
	anchorID := src.WorkspaceAnchorID
	if anchorID == "" {
		anchorID = e.workspaceAnchorFor(ctx, src.Cwd, src.ExecutingDeviceID, now)
	}

	dst := store.Task{
		ID:             newID,
		Title:          title,
		Agent:          agent,
		Cwd:            src.Cwd,
		Prompt:         prompt,
		Model:          src.Model,
		PermissionMode: src.PermissionMode,
		// The cwd is an address on the machine that will run this; the anchor is
		// the same workspace said portably, so a turn dispatched to another
		// machine can be handed *that* machine's address instead of this one's.
		WorkspaceAnchorID: anchorID,
		Status:            status,
		CreatedAt:         now,
		// A fork continues the same conversation in the same directory, so it
		// runs where the source runs. Carrying only the cwd would leave the
		// branch on this machine: same path, different files, different agent
		// session — the user asked to continue that work, not to copy it here.
		ExecutingDeviceID: src.ExecutingDeviceID,
		// A fork belongs to whoever owned the source. Forking is not a way to
		// acquire someone else's task, and not a way to shed your own.
		OwnerUserID: src.OwnerUserID,
	}
	if status == StatusSucceeded {
		dst.FinishedAt = &now
	}
	// Context from source prefix (before copy); dst seqs are renumbered.
	priorCtx := e.handoffContextUpTo(ctx, id, maxSeq)

	remote := e.isRemoteDevice(src.ExecutingDeviceID)
	if remote {
		// The other machine owns that directory, so there is nothing here to
		// prepare — the same rule Create follows for a dispatched task.
		applyWorkspaceMetadata(&dst, sharedWorkspace(src.Cwd))
		dst.WorkspacePolicy = string(store.WorkspacePolicyShared)
		// Where the work sits travels with the fork, as the device does. It is
		// what the panels draw before anybody asks the machine — the repository
		// chip, the pull-request header — and the machine's own answer is what
		// corrects it later. Dropping it would leave every fork of a remote
		// session with nothing to draw and no branch for the panel's first read
		// to be about, which is not a state the person can act on from a phone.
		dst.WorkspaceRepo, dst.WorkspaceBranch = src.WorkspaceRepo, src.WorkspaceBranch
	}

	preparedFork := false
	var forkMeta workspace.Metadata
	if !remote && src.WorkspaceMode == string(workspace.ResolvedWorktree) {
		if e.workspace == nil {
			return store.Task{}, workspace.ErrCheckpointUnavailable
		}
		cp, err := e.store.GetCheckpointAtOrBefore(ctx, id, maxSeq)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return store.Task{}, workspace.ErrCheckpointUnavailable
			}
			return store.Task{}, err
		}
		sourceMeta, metaErr := e.workspaceMetadataForCheckpoint(ctx, src, cp)
		if metaErr != nil {
			return store.Task{}, metaErr
		}
		forkMeta, err = e.workspace.PrepareFork(ctx, newID, sourceMeta, runtimeCheckpoint(cp))
		if err != nil {
			return store.Task{}, err
		}
		applyWorkspaceMetadata(&dst, forkMeta)
		dst.WorkspacePolicy = string(store.WorkspacePolicyWorktree)
		preparedFork = true
	}

	if err := e.store.InsertTask(ctx, dst); err != nil {
		if preparedFork {
			e.cleanupPreparedWorkspace(newID, forkMeta)
		}
		return store.Task{}, err
	}

	if _, err := e.store.CopyEventsToTask(ctx, id, newID, maxSeq); err != nil {
		if preparedFork {
			e.cleanupPreparedWorkspace(newID, forkMeta)
		}
		_ = e.store.DeleteTask(ctx, newID)
		return store.Task{}, err
	}
	if preparedFork {
		now := store.NowMilli()
		ws := store.WorkspaceGeneration{
			ID:              newID + ":g1",
			TaskID:          newID,
			Generation:      1,
			State:           store.WorkspaceActive,
			SourceRoot:      forkMeta.SourceRoot,
			Scope:           forkMeta.Scope,
			TargetBranch:    forkMeta.TargetBranch,
			WorkspaceBranch: forkMeta.Branch,
			PhysicalRoot:    forkMeta.Root,
			ExecutionCwd:    forkMeta.Cwd,
			BaseOID:         forkMeta.BaseOID,
			CreatedAt:       now,
			UpdatedAt:       now,
		}
		ev, insertErr := e.store.InsertWorkspaceAsCurrent(ctx, ws)
		if insertErr != nil {
			e.cleanupPreparedWorkspace(newID, forkMeta)
			_ = e.store.DeleteTask(ctx, newID)
			return store.Task{}, insertErr
		}
		e.bus.PublishEvent(ev)
		if seq := e.latestUserMessageSeq(ctx, newID); seq > 0 {
			e.captureCheckpoint(ctx, dst, seq)
		}
	}

	// Optional new user turn on top of the prefix.
	if runNow {
		userPayload, _ := json.Marshal(map[string]any{
			"role":          "user",
			"content":       []map[string]string{{"type": "text", "text": prompt}},
			"partial":       false,
			"agent":         "user",
			"speaker":       "user",
			"source":        "fork",
			"forked_from":   id,
			"fork_from_seq": maxSeq,
		})
		if ev, err := e.store.AppendEvent(ctx, newID, "message", userPayload); err == nil {
			e.bus.PublishEvent(ev)
			e.captureCheckpoint(ctx, dst, ev.Seq)
		}
		runPrompt := prompt
		if priorCtx != "" {
			runPrompt = priorCtx + "\n\n---\n\n" + prompt
		}
		if err := e.store.UpdateTask(ctx, newID, store.TaskPatch{Prompt: &runPrompt}); err != nil {
			return store.Task{}, err
		}
	} else {
		// Annotate fork origin as meta so UI can show lineage if desired.
		meta, _ := json.Marshal(map[string]any{
			"message":       "forked from " + id,
			"forked_from":   id,
			"fork_from_seq": maxSeq,
		})
		if ev, err := e.store.AppendEvent(ctx, newID, "meta", meta); err == nil {
			e.bus.PublishEvent(ev)
		}
	}

	t, err := e.store.GetTask(ctx, newID)
	if err != nil {
		return store.Task{}, err
	}
	e.bus.PublishTask(t)

	if runNow {
		e.mu.Lock()
		e.queue = append(e.queue, newID)
		e.mu.Unlock()
		e.pump()
		return e.store.GetTask(ctx, newID)
	}
	return t, nil
}

func isTerminalStatus(status string) bool {
	switch status {
	case StatusSucceeded, StatusFailed, StatusCanceled:
		return true
	default:
		return false
	}
}

// resolveUserTurn finds the user message event to retry from.
// fromSeq 0 → last user message; otherwise must be a user message seq (or we walk back to nearest user ≤ fromSeq).
func resolveUserTurn(evs []store.Event, fromSeq int, fallbackPrompt string) (seq int, text string, err error) {
	type hit struct {
		seq  int
		text string
	}
	var users []hit
	for _, ev := range evs {
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		if json.Unmarshal(ev.Payload, &m) != nil {
			continue
		}
		role, _ := m["role"].(string)
		speaker, _ := m["speaker"].(string)
		if role != "user" && speaker != "user" {
			continue
		}
		tx := extractMessageText(m)
		if tx == "" {
			continue
		}
		users = append(users, hit{seq: ev.Seq, text: tx})
	}
	if len(users) == 0 {
		// No user events — use fallback prompt as synthetic turn at seq 1 if any events exist.
		if strings.TrimSpace(fallbackPrompt) == "" {
			return 0, "", ErrInvalidSeq
		}
		if fromSeq > 0 {
			return fromSeq, fallbackPrompt, nil
		}
		// Retry whole task from the beginning: drop all events (from seq 1).
		return 1, fallbackPrompt, nil
	}
	if fromSeq <= 0 {
		u := users[len(users)-1]
		return u.seq, u.text, nil
	}
	// Exact match preferred.
	for i := len(users) - 1; i >= 0; i-- {
		if users[i].seq == fromSeq {
			return users[i].seq, users[i].text, nil
		}
	}
	// Allow fromSeq pointing into an assistant turn: rewind to nearest user at or before fromSeq.
	for i := len(users) - 1; i >= 0; i-- {
		if users[i].seq <= fromSeq {
			return users[i].seq, users[i].text, nil
		}
	}
	return 0, "", ErrInvalidSeq
}

func lastUserTextUpTo(evs []store.Event, maxSeq int) (string, bool) {
	for i := len(evs) - 1; i >= 0; i-- {
		ev := evs[i]
		if ev.Seq > maxSeq || ev.Type != "message" {
			continue
		}
		var m map[string]any
		if json.Unmarshal(ev.Payload, &m) != nil {
			continue
		}
		role, _ := m["role"].(string)
		speaker, _ := m["speaker"].(string)
		if role != "user" && speaker != "user" {
			continue
		}
		tx := extractMessageText(m)
		if tx != "" {
			return tx, true
		}
	}
	return "", false
}

// hostTranscriptNonEmpty reports whether the host plugin's durable transcript
// for this task has at least one message (currently kin_messages).
func (e *Engine) hostTranscriptNonEmpty(ctx context.Context, taskID string) bool {
	if e == nil || e.store == nil {
		return false
	}
	msgs, err := e.store.LoadKinMessages(ctx, taskID)
	return err == nil && len(msgs) > 0
}

// handoffContext builds a short transcript excerpt for cross-agent (or no-session) continues.
// Packing is newest-first (see sessionctx.BuildPack / ADR 0002) so adjacent recent turns
// are not dropped when older verbose lines exhaust the char budget.
// handoffContextUpTo is like handoffContext but only considers events with seq <= maxSeq.
// maxSeq < 1 means no prior events.
func (e *Engine) handoffContextUpTo(ctx context.Context, taskID string, maxSeq int) string {
	if maxSeq < 1 {
		return ""
	}
	evs, err := e.store.ListEvents(ctx, taskID, 0)
	if err != nil || len(evs) == 0 {
		return ""
	}
	var lines []sessionctx.Line
	for _, ev := range evs {
		if ev.Seq > maxSeq {
			continue
		}
		switch ev.Type {
		case "message", "error":
		default:
			continue
		}
		s := summarizeEvent(ev)
		if s == "" {
			continue
		}
		lines = append(lines, sessionctx.Line{Text: s, Seq: ev.Seq})
	}
	pack := sessionctx.BuildSealedPack(lines, sessionctx.PackOptions{
		MaxChars:     sessionctx.DefaultMaxChars,
		MaxLines:     sessionctx.DefaultMaxLines,
		LineMaxChars: sessionctx.DefaultLineMaxChars,
	}, "")
	return pack.Render()
}

func (e *Engine) handoffContext(ctx context.Context, taskID string) string {
	evs, err := e.store.ListEvents(ctx, taskID, 0)
	if err != nil || len(evs) == 0 {
		return ""
	}
	var lines []sessionctx.Line
	for _, ev := range evs {
		switch ev.Type {
		case "message", "error":
			// Prefer high-signal types. Skip raw_output noise and generic "result: task turn finished".
		default:
			continue
		}
		s := summarizeEvent(ev)
		if s == "" {
			continue
		}
		lines = append(lines, sessionctx.Line{Text: s, Seq: ev.Seq})
	}
	// Newest turns stay verbatim under [Recent turns]; older overflow is sealed
	// into [Sealed summary] + [Session index] rather than dropped (ADR 0002 P1b).
	// Fixed section order keeps the cross-turn prefix stable (Policy K).
	pack := sessionctx.BuildSealedPack(lines, sessionctx.PackOptions{
		MaxChars:     sessionctx.DefaultMaxChars,
		MaxLines:     sessionctx.DefaultMaxLines,
		LineMaxChars: sessionctx.DefaultLineMaxChars,
	}, "" /* pinned: auto-derivation deferred to P1.5 */)
	return pack.Render()
}

func summarizeEvent(ev store.Event) string {
	var m map[string]any
	_ = json.Unmarshal(ev.Payload, &m)
	switch ev.Type {
	case "message":
		role, _ := m["role"].(string)
		if role == "" {
			role = "assistant"
		}
		// Skip "→ worker" delegate chrome, but keep orchestrator plan/summary
		// so a later @worker follow-up still sees what happened last turn.
		if src, _ := m["source"].(string); src == "delegate" {
			return ""
		}
		if role != "user" {
			if src, _ := m["source"].(string); src != "orchestrator" {
				if v, ok := m["visibility"].(map[string]any); ok {
					if user, _ := v["user"].(bool); !user {
						return ""
					}
				}
			}
		}
		text := extractMessageText(m)
		if text == "" {
			return ""
		}
		// Never re-inject full system-ish prompts into context.
		if strings.Contains(text, "You are a task worker agent") ||
			strings.Contains(text, "You are Kin — a local coding agent") {
			return ""
		}
		// Rune-safe soft cap; orchestrator summaries may carry worker findings.
		capN := 800
		if src, _ := m["source"].(string); src == "orchestrator" {
			capN = 1600
		}
		text = sessionctx.TruncateRunes(text, capN)
		return role + ": " + text
	case "error":
		if msg, ok := m["message"].(string); ok {
			return "error: " + msg
		}
	case "result":
		return "result: task turn finished"
	case "raw_output":
		// Keep handoff context small — skip CLI noise.
		return ""
	}
	return ""
}

func extractMessageText(m map[string]any) string {
	// content: [{type:text,text:…}] or string
	switch c := m["content"].(type) {
	case string:
		return c
	case []any:
		var b string
		for _, part := range c {
			pm, ok := part.(map[string]any)
			if !ok {
				continue
			}
			if t, ok := pm["text"].(string); ok {
				b += t
			}
		}
		return b
	}
	if t, ok := m["text"].(string); ok {
		return t
	}
	return ""
}

func formatHandoffPrompt(fromAgent, toAgent, contextBlock, userPrompt string) string {
	var b strings.Builder
	if fromAgent != toAgent {
		b.WriteString("You are taking over this Kin task from agent ")
		b.WriteString(fromAgent)
		b.WriteString(" as ")
		b.WriteString(toAgent)
		b.WriteString(".\n")
	} else {
		b.WriteString("Continue this Kin task.\n")
	}
	if contextBlock != "" {
		b.WriteString("\n--- prior context ---\n")
		b.WriteString(contextBlock)
		b.WriteString("\n--- end context ---\n\n")
	}
	b.WriteString("User request:\n")
	b.WriteString(userPrompt)
	return b.String()
}

func (e *Engine) now() time.Time {
	if e.clock != nil {
		return e.clock()
	}
	return time.Now()
}

func (e *Engine) nowMilli() int64 {
	return e.now().UnixMilli()
}
