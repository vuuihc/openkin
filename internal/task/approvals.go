package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/vuuihc/kin/internal/sessionctx"
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

// pendingFollowUp is applied after an in-flight turn is interrupted so the user
// can stop the current agent and immediately inject a new guiding prompt.
type pendingFollowUp struct {
	req       FollowUpRequest
	fromAgent string
	// interrupted marks that the previous turn was cut short.
	interrupted bool
}

// FollowUp re-queues a terminal task for a new prompt (spec §6 M2).
// When the task is still running / waiting_approval, the current turn is interrupted first
// and the new prompt is applied once the process exits (steer / insert guide).
func (e *Engine) FollowUp(ctx context.Context, id, prompt string) (store.Task, error) {
	return e.FollowUpWith(ctx, id, FollowUpRequest{Prompt: prompt})
}

// FollowUpWith supports same-agent resume, cross-agent handoff, and interrupt-then-guide.
//
//   - agent empty or same: resume via session_ref when present; otherwise inject recent transcript.
//   - agent different: clear session_ref, switch task.agent, inject handoff context into prompt.
//   - task running / waiting_approval: interrupt current session, then re-queue with the new prompt.
func (e *Engine) FollowUpWith(ctx context.Context, id string, req FollowUpRequest) (store.Task, error) {
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return store.Task{}, fmt.Errorf("prompt is required")
	}
	req.Prompt = prompt

	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}

	switch t.Status {
	case StatusSucceeded, StatusFailed, StatusCanceled:
		return e.applyFollowUp(ctx, id, t, req, false /*interrupted*/)
	case StatusRunning, StatusWaitingApproval, StatusQueued:
		return e.interruptAndFollowUp(ctx, id, t, req)
	default:
		return store.Task{}, fmt.Errorf("%w: task status %s cannot accept prompt", ErrConflict, t.Status)
	}
}

// interruptAndFollowUp stops the in-flight turn and schedules req to run next.
func (e *Engine) interruptAndFollowUp(ctx context.Context, id string, t store.Task, req FollowUpRequest) (store.Task, error) {
	// Validate agent early so we do not cancel then fail.
	if req.Agent != "" && req.Agent != t.Agent {
		if _, ok := e.adapters[req.Agent]; !ok {
			return store.Task{}, fmt.Errorf("unknown or unavailable agent %q", req.Agent)
		}
	}

	// Deny pending approvals so MCP waiters unblock before we kill the process.
	if pending, err := e.store.ListPendingForTask(ctx, id); err == nil {
		for _, a := range pending {
			_, _ = e.Decide(ctx, a.ID, store.DecisionDenied, "web")
		}
	}

	e.mu.Lock()
	// If still only queued (not started), drop from queue and apply immediately.
	for i, qid := range e.queue {
		if qid == id {
			e.queue = append(e.queue[:i], e.queue[i+1:]...)
			e.mu.Unlock()
			// Still non-terminal; force a clean re-queue path via applyFollowUp.
			// Mark as canceled-equivalent by finishing then applying, but simpler:
			// applyFollowUp requires terminal — so finish as canceled then apply.
			if _, err := e.finish(ctx, id, StatusCanceled, nil, nil); err != nil {
				return store.Task{}, err
			}
			t2, err := e.store.GetTask(ctx, id)
			if err != nil {
				return store.Task{}, err
			}
			return e.applyFollowUp(ctx, id, t2, req, true /*interrupted*/)
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
	e.appendUserGuideEvent(ctx, id, t, req, true /*interrupted*/)

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
			if _, err := e.finish(ctx, id, StatusCanceled, nil, nil); err != nil {
				return store.Task{}, err
			}
			t2, err := e.store.GetTask(ctx, id)
			if err != nil {
				return store.Task{}, err
			}
			// User event already appended above — apply without duplicating.
			return e.applyFollowUpPrepared(ctx, id, t2, pf.req, true /*interrupted*/, false /*emitUser*/)
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
	// User guide event was already appended at interrupt time.
	return e.applyFollowUpPrepared(ctx, id, t, pf.req, pf.interrupted, false /*emitUser*/)
}

func (e *Engine) applyFollowUp(ctx context.Context, id string, t store.Task, req FollowUpRequest, interrupted bool) (store.Task, error) {
	return e.applyFollowUpPrepared(ctx, id, t, req, interrupted, true /*emitUser*/)
}

// applyFollowUpPrepared patches the task prompt/agent and re-queues. When emitUser
// is false the caller already published the user message (interrupt path).
func (e *Engine) applyFollowUpPrepared(ctx context.Context, id string, t store.Task, req FollowUpRequest, interrupted, emitUser bool) (store.Task, error) {
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return store.Task{}, fmt.Errorf("prompt is required")
	}

	fromAgent := t.Agent
	targetAgent := t.Agent
	handoff := false

	// Multi-@ is decided from the *current* user message only. Prior transcript
	// @mentions must not force orchestration on a plain follow-up (mixed modes).
	plan := ParseDelegatePlan(UserTurnPrompt(prompt), AvailableSet(e.AgentIDs()))
	orchestrate := plan.HasSubAgents()
	if orchestrate {
		if main := e.MainAgent(); main != "" {
			req.Agent = main
		}
	}

	if req.Agent != "" && req.Agent != t.Agent {
		if _, ok := e.adapters[req.Agent]; !ok {
			return store.Task{}, fmt.Errorf("unknown or unavailable agent %q", req.Agent)
		}
		targetAgent = req.Agent
		handoff = true
	}

	// Cross-turn context strategy (ADR 0002 Policy K):
	//   - same-agent kin with durable transcript → append-only live user prompt
	//   - handoff / interrupt / orchestrate / no-session CLI → sealed Context Pack blob
	// Orchestrated turns still store the user request under "User request:" so
	// UserTurnPrompt / shouldOrchestrate only see the live @mentions.
	runPrompt := prompt
	sameKinResume := !handoff && !interrupted && !orchestrate && targetAgent == "kin"
	if sameKinResume {
		// Live user turn only; kinagent loads prior messages from kin_messages.
		runPrompt = prompt
	} else {
		ctxBlock := e.handoffContext(ctx, id)
		needContext := handoff || t.SessionRef == nil || *t.SessionRef == "" || targetAgent == "kin" || interrupted || orchestrate
		if needContext && (handoff || interrupted || ctxBlock != "" || orchestrate) {
			runPrompt = formatHandoffPrompt(fromAgent, targetAgent, ctxBlock, prompt)
			if interrupted {
				runPrompt = "The previous turn was interrupted by the user. Treat the request below as the new guidance.\n\n" + runPrompt
			}
		}
		// Cold prefix: drop durable Kin transcript so we don't mix packs with resume.
		if handoff || interrupted || orchestrate || targetAgent != "kin" {
			_ = e.store.ClearKinMessages(ctx, id)
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
	// Fresh worker sessions for multi-@ orchestrated turns.
	if orchestrate {
		patch.ClearSessionRef = true
		if main := e.MainAgent(); main != "" {
			patch.Agent = &main
		}
	}
	// Interrupt always starts a clean turn (CLI may have left a half-finished session).
	if interrupted {
		// Keep session_ref only when same agent and not orchestrating — resume is best-effort.
		if handoff || orchestrate {
			patch.ClearSessionRef = true
		}
	}
	if err := e.store.UpdateTask(ctx, id, patch); err != nil {
		return store.Task{}, err
	}
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	e.bus.PublishTask(t)

	if emitUser {
		e.appendUserGuideEvent(ctx, id, t, req, interrupted)
	}

	e.mu.Lock()
	e.queue = append(e.queue, id)
	e.mu.Unlock()
	e.pump()

	return e.store.GetTask(ctx, id)
}

func (e *Engine) appendUserGuideEvent(ctx context.Context, id string, t store.Task, req FollowUpRequest, interrupted bool) {
	prompt := req.Prompt
	fromAgent := t.Agent
	targetAgent := t.Agent
	handoff := req.Agent != "" && req.Agent != t.Agent
	if handoff {
		targetAgent = req.Agent
	}
	plan := ParseDelegatePlan(UserTurnPrompt(prompt), AvailableSet(e.AgentIDs()))
	orchestrate := plan.HasSubAgents()

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
	}
}

// handoffContext builds a short transcript excerpt for cross-agent (or no-session) continues.
// Packing is newest-first (see sessionctx.BuildPack / ADR 0002) so adjacent recent turns
// are not dropped when older verbose lines exhaust the char budget.
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
