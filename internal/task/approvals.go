package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/vuuihc/kin/internal/store"
)

// ErrConflict is returned when a state transition is not allowed (HTTP 409).
var ErrConflict = errors.New("conflict")

// ErrAlreadyDecided is returned when deciding a non-pending approval.
var ErrAlreadyDecided = errors.New("approval already decided")

// CreateApprovalRequest is the body for POST /internal/approvals.
type CreateApprovalRequest struct {
	TaskID  string          `json:"task_id"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

// DecisionRequest is the body for POST /api/approvals/{id}/decision.
type DecisionRequest struct {
	Decision string `json:"decision"` // approved | denied
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

	t, err := e.store.GetTask(ctx, req.TaskID)
	if err != nil {
		return store.Approval{}, err
	}
	switch t.Status {
	case StatusRunning, StatusWaitingApproval:
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

	// Event payload includes approval id + tool request body.
	evPayload, _ := json.Marshal(map[string]any{
		"approval_id": id,
		"kind":        req.Kind,
		"payload":     json.RawMessage(req.Payload),
	})
	ev, err := e.store.AppendEvent(ctx, req.TaskID, "approval_requested", evPayload)
	if err != nil {
		return store.Approval{}, err
	}
	e.bus.PublishEvent(ev)
	e.bus.PublishApproval(a)

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

	// Event + task status.
	evPayload, _ := json.Marshal(map[string]any{
		"approval_id": id,
		"decision":    decision,
		"decided_via": via,
	})
	ev, err := e.store.AppendEvent(ctx, a.TaskID, "approval_decided", evPayload)
	if err == nil {
		e.bus.PublishEvent(ev)
	}

	// Resume task to running if still waiting (process is blocked on MCP).
	t, err := e.store.GetTask(ctx, a.TaskID)
	if err == nil && t.Status == StatusWaitingApproval {
		// Only resume if no other pending approvals for this task.
		pending, _ := e.store.ListPendingForTask(ctx, a.TaskID)
		if len(pending) == 0 {
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
	return e.Decide(ctx, a.ID, store.DecisionExpired, "timeout")
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

// FollowUp re-queues a terminal task with session_ref for a new prompt (spec §6 M2).
func (e *Engine) FollowUp(ctx context.Context, id, prompt string) (store.Task, error) {
	if prompt == "" {
		return store.Task{}, fmt.Errorf("prompt is required")
	}
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	if t.Status != StatusSucceeded && t.Status != StatusFailed && t.Status != StatusCanceled {
		return store.Task{}, fmt.Errorf("%w: task is not terminal (%s)", ErrConflict, t.Status)
	}
	if t.SessionRef == nil || *t.SessionRef == "" {
		return store.Task{}, fmt.Errorf("%w: task has no session_ref", ErrConflict)
	}

	status := StatusQueued
	if err := e.store.UpdateTask(ctx, id, store.TaskPatch{
		Status:          &status,
		Prompt:          &prompt,
		ClearExitCode:   true,
		ClearFinishedAt: true,
	}); err != nil {
		return store.Task{}, err
	}
	t, err = e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	e.bus.PublishTask(t)

	// Append a user message event for the audit trail.
	evPayload, _ := json.Marshal(map[string]any{
		"role":    "user",
		"content": []map[string]string{{"type": "text", "text": prompt}},
		"partial": false,
		"source":  "follow_up",
	})
	if ev, err := e.store.AppendEvent(ctx, id, "message", evPayload); err == nil {
		e.bus.PublishEvent(ev)
	}

	e.mu.Lock()
	e.queue = append(e.queue, id)
	e.mu.Unlock()
	e.pump()

	return e.store.GetTask(ctx, id)
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


