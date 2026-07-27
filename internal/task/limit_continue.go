package task

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
)

// LimitContinueRequest is the body for POST /api/tasks/{id}/limit/continue.
//
// Actions:
//   - wait: arm auto-continue after reset_at (or immediately if already past / unknown with force)
//   - continue: retry the last user turn now on the same agent
//   - switch: hand off to another agent with the last user prompt
//   - dismiss: acknowledge the limit card without retrying
type LimitContinueRequest struct {
	Action string `json:"action"`
	// Agent is required for action=switch.
	Agent string `json:"agent,omitempty"`
	// ResetAt overrides the detected reset time for action=wait (unix seconds).
	ResetAt int64 `json:"reset_at,omitempty"`
}

// providerForAgent maps agent ids to usage-window provider ids.
func providerForAgent(agent string) string {
	switch strings.TrimSpace(agent) {
	case "claude-code", "claude":
		return "claude"
	case "codex":
		return "codex"
	case "kin":
		return "kin"
	default:
		return ""
	}
}

// maybeEmitLimitHit appends a limit_hit event when payload looks rate-limited
// and this task has not already recorded one for the current failure window.
// Safe to call multiple times; duplicates within the recent tail are skipped.
func (e *Engine) maybeEmitLimitHit(ctx context.Context, taskID, agent string, payload json.RawMessage, source string) {
	info, ok := adapter.DetectRateLimitPayload(payload)
	if !ok {
		return
	}
	if info.Agent == "" {
		info.Agent = agent
	}
	if info.Provider == "" {
		info.Provider = providerForAgent(agent)
	}
	if info.Source == "" {
		info.Source = source
	}
	if info.Message == "" {
		info.Message = "rate limited"
	}

	// Skip if a limit_hit already exists after the latest user message.
	evs, err := e.store.ListEvents(ctx, taskID, 0)
	if err == nil {
		lastUser := 0
		for _, ev := range evs {
			if ev.Type == "message" {
				var m map[string]any
				if json.Unmarshal(ev.Payload, &m) == nil {
					role, _ := m["role"].(string)
					speaker, _ := m["speaker"].(string)
					if role == "user" || speaker == "user" {
						lastUser = ev.Seq
					}
				}
			}
		}
		for _, ev := range evs {
			if ev.Seq > lastUser && ev.Type == "limit_hit" {
				return
			}
		}
	}

	out := map[string]any{
		"kind":     adapter.RateLimitKind,
		"message":  info.Message,
		"agent":    info.Agent,
		"provider": info.Provider,
		"source":   info.Source,
		"status":   "open", // open | waiting | continued | switched | dismissed
	}
	if info.ResetAt > 0 {
		out["reset_at"] = info.ResetAt
	}
	if info.Window != "" {
		out["window"] = info.Window
	}
	b, _ := json.Marshal(out)
	if w := e.eventWriter(); w != nil {
		if ev, err := w.AppendEvent(ctx, taskID, "limit_hit", b); err == nil {
			e.bus.PublishEvent(ev)
		}
	}
}

// scanAndEmitLimitHit inspects the recent event tail after a failed run and
// emits limit_hit when any error/result looks rate-limited.
func (e *Engine) scanAndEmitLimitHit(ctx context.Context, taskID, agent string) {
	evs, err := e.store.ListEvents(ctx, taskID, 0)
	if err != nil || len(evs) == 0 {
		return
	}
	// Walk from the end; stop at the latest user message.
	for i := len(evs) - 1; i >= 0; i-- {
		ev := evs[i]
		if ev.Type == "message" {
			var m map[string]any
			if json.Unmarshal(ev.Payload, &m) == nil {
				role, _ := m["role"].(string)
				speaker, _ := m["speaker"].(string)
				if role == "user" || speaker == "user" {
					break
				}
			}
		}
		if ev.Type == "limit_hit" {
			return // already recorded for this turn
		}
		if ev.Type == "error" || ev.Type == "result" {
			e.maybeEmitLimitHit(ctx, taskID, agent, ev.Payload, ev.Type)
			// maybeEmitLimitHit no-ops when not a limit; keep scanning other events.
			// If it emitted, subsequent call will see limit_hit and skip.
		}
	}
}

// LimitContinue applies a user choice after a rate-limit failure.
func (e *Engine) LimitContinue(ctx context.Context, id string, req LimitContinueRequest) (store.Task, error) {
	action := strings.ToLower(strings.TrimSpace(req.Action))
	switch action {
	case "wait", "continue", "switch", "dismiss":
	default:
		return store.Task{}, fmt.Errorf("invalid action %q (want wait|continue|switch|dismiss)", req.Action)
	}

	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	switch t.Status {
	case StatusFailed, StatusSucceeded, StatusCanceled:
		// allowed — primarily failed; other terminals still accept dismiss
	case StatusQueued, StatusRunning, StatusWaitingApproval, StatusWaitingInput:
		return store.Task{}, fmt.Errorf("%w: task is not terminal", ErrConflict)
	default:
		return store.Task{}, fmt.Errorf("%w: task status %s", ErrConflict, t.Status)
	}

	info, hitSeq, hasHit := e.latestOpenLimitHit(ctx, id)

	switch action {
	case "dismiss":
		if hasHit {
			e.patchLimitHitStatus(ctx, id, hitSeq, info, "dismissed", "")
		}
		return e.store.GetTask(ctx, id)

	case "wait":
		if t.Status != StatusFailed {
			return store.Task{}, fmt.Errorf("%w: wait requires a failed task", ErrConflict)
		}
		resetAt := req.ResetAt
		if resetAt <= 0 {
			resetAt = info.ResetAt
		}
		if hasHit {
			info.ResetAt = resetAt
			e.patchLimitHitStatus(ctx, id, hitSeq, info, "waiting", "")
		} else {
			// Synthesize a limit_hit so the UI has something to render.
			payload := map[string]any{
				"kind":     adapter.RateLimitKind,
				"message":  firstNonEmptyStr(info.Message, "rate limited"),
				"agent":    t.Agent,
				"provider": providerForAgent(t.Agent),
				"status":   "waiting",
				"source":   "user_wait",
			}
			if resetAt > 0 {
				payload["reset_at"] = resetAt
			}
			b, _ := json.Marshal(payload)
			if ev, err := e.store.AppendEvent(ctx, id, "limit_hit", b); err == nil {
				e.bus.PublishEvent(ev)
			}
		}
		// Schedule auto-continue when we have a reset time; otherwise leave it
		// armed for a manual Continue (status=waiting still helps the UI).
		if resetAt > 0 {
			e.scheduleLimitWait(id, resetAt)
		}
		return e.store.GetTask(ctx, id)

	case "continue":
		if t.Status != StatusFailed && t.Status != StatusCanceled && t.Status != StatusSucceeded {
			return store.Task{}, fmt.Errorf("%w: continue requires a terminal task", ErrConflict)
		}
		if hasHit {
			e.patchLimitHitStatus(ctx, id, hitSeq, info, "continued", "")
		}
		e.cancelLimitWait(id)
		return e.Retry(ctx, id, RetryRequest{})

	case "switch":
		agentID := strings.TrimSpace(req.Agent)
		if agentID == "" {
			return store.Task{}, fmt.Errorf("agent is required for switch")
		}
		if !e.HasAgent(agentID) {
			return store.Task{}, fmt.Errorf("unknown or unavailable agent %q", agentID)
		}
		if agentID == t.Agent {
			return store.Task{}, fmt.Errorf("agent is already %q", agentID)
		}
		prompt, err := e.lastUserPrompt(ctx, id, t.Prompt)
		if err != nil {
			return store.Task{}, err
		}
		if hasHit {
			e.patchLimitHitStatus(ctx, id, hitSeq, info, "switched", agentID)
		}
		e.cancelLimitWait(id)
		return e.FollowUpWith(ctx, id, FollowUpRequest{Prompt: prompt, Agent: agentID})
	}

	return t, nil
}

func (e *Engine) latestOpenLimitHit(ctx context.Context, taskID string) (adapter.RateLimitInfo, int, bool) {
	evs, err := e.store.ListEvents(ctx, taskID, 0)
	if err != nil {
		return adapter.RateLimitInfo{}, 0, false
	}
	for i := len(evs) - 1; i >= 0; i-- {
		ev := evs[i]
		if ev.Type != "limit_hit" {
			continue
		}
		info, ok := adapter.DetectRateLimitPayload(ev.Payload)
		if !ok {
			info = adapter.RateLimitInfo{Kind: adapter.RateLimitKind, Message: "rate limited"}
		}
		// Parse status from payload.
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		status, _ := m["status"].(string)
		status = strings.ToLower(strings.TrimSpace(status))
		if status == "" {
			status = "open"
		}
		// Treat open/waiting as actionable; skip terminal card states.
		if status == "continued" || status == "switched" || status == "dismissed" {
			return info, ev.Seq, false
		}
		if v := int64FieldAny(m, "reset_at"); v > 0 {
			info.ResetAt = v
		}
		if msg, _ := m["message"].(string); strings.TrimSpace(msg) != "" {
			info.Message = msg
		}
		if agent, _ := m["agent"].(string); agent != "" {
			info.Agent = agent
		}
		return info, ev.Seq, true
	}
	return adapter.RateLimitInfo{}, 0, false
}

func (e *Engine) patchLimitHitStatus(ctx context.Context, taskID string, seq int, info adapter.RateLimitInfo, status, toAgent string) {
	// Append a follow-up limit_hit with updated status rather than mutating history.
	// The UI uses the latest limit_hit after the last user message.
	payload := map[string]any{
		"kind":     adapter.RateLimitKind,
		"message":  firstNonEmptyStr(info.Message, "rate limited"),
		"agent":    info.Agent,
		"provider": info.Provider,
		"status":   status,
		"source":   "user_action",
	}
	if info.ResetAt > 0 {
		payload["reset_at"] = info.ResetAt
	}
	if info.Window != "" {
		payload["window"] = info.Window
	}
	if toAgent != "" {
		payload["to_agent"] = toAgent
	}
	if seq > 0 {
		payload["replaces_seq"] = seq
	}
	b, _ := json.Marshal(payload)
	if ev, err := e.store.AppendEvent(ctx, taskID, "limit_hit", b); err == nil {
		e.bus.PublishEvent(ev)
	}
}

func (e *Engine) lastUserPrompt(ctx context.Context, taskID, fallback string) (string, error) {
	evs, err := e.store.ListEvents(ctx, taskID, 0)
	if err != nil {
		return "", err
	}
	seq, text, err := resolveUserTurn(evs, 0, fallback)
	if err != nil {
		return "", err
	}
	_ = seq
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("no user prompt to continue")
	}
	return text, nil
}

// --- auto wait scheduler (in-memory; process lifetime only) ---

func (e *Engine) scheduleLimitWait(taskID string, resetAt int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.limitWaitCancel == nil {
		e.limitWaitCancel = make(map[string]context.CancelFunc)
	}
	if cancel, ok := e.limitWaitCancel[taskID]; ok {
		cancel()
		delete(e.limitWaitCancel, taskID)
	}
	delay := time.Until(time.Unix(resetAt, 0))
	if delay < 0 {
		delay = 0
	}
	// Small grace so the provider window is actually open.
	delay += 2 * time.Second
	// Cap absurd delays (e.g. bad reset_at far in the future) at 48h.
	if delay > 48*time.Hour {
		delay = 48 * time.Hour
	}
	ctx, cancel := context.WithCancel(e.ctx)
	e.limitWaitCancel[taskID] = cancel
	go e.runLimitWait(ctx, taskID, delay)
}

func (e *Engine) cancelLimitWait(taskID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.limitWaitCancel == nil {
		return
	}
	if cancel, ok := e.limitWaitCancel[taskID]; ok {
		cancel()
		delete(e.limitWaitCancel, taskID)
	}
}

func (e *Engine) runLimitWait(ctx context.Context, taskID string, delay time.Duration) {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
	}
	// Clear registry entry.
	e.mu.Lock()
	if e.limitWaitCancel != nil {
		delete(e.limitWaitCancel, taskID)
	}
	e.mu.Unlock()

	// Only auto-continue if still failed and still waiting.
	t, err := e.store.GetTask(ctx, taskID)
	if err != nil || t.Status != StatusFailed {
		return
	}
	info, hitSeq, hasHit := e.latestOpenLimitHit(ctx, taskID)
	if !hasHit {
		return
	}
	if hasHit {
		e.patchLimitHitStatus(ctx, taskID, hitSeq, info, "continued", "")
	}
	if _, err := e.Retry(ctx, taskID, RetryRequest{}); err != nil {
		payload, _ := json.Marshal(map[string]string{
			"message": "auto-continue after rate limit failed: " + err.Error(),
		})
		if ev, err := e.store.AppendEvent(ctx, taskID, "error", payload); err == nil {
			e.bus.PublishEvent(ev)
		}
	}
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func int64FieldAny(m map[string]any, key string) int64 {
	v, ok := m[key]
	if !ok || v == nil {
		return 0
	}
	switch t := v.(type) {
	case float64:
		n := int64(t)
		if n > 1_000_000_000_000 {
			n /= 1000
		}
		return n
	case int64:
		return t
	case int:
		return int64(t)
	case json.Number:
		n, _ := t.Int64()
		return n
	default:
		return 0
	}
}
