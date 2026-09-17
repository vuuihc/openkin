package task

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
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
		if err := e.scheduleLimitWaitExplicit(ctx, id, resetAt); err != nil {
			return store.Task{}, err
		}
		return e.store.GetTask(ctx, id)

	case "continue":
		if t.Status != StatusFailed && t.Status != StatusCanceled && t.Status != StatusSucceeded {
			return store.Task{}, fmt.Errorf("%w: continue requires a terminal task", ErrConflict)
		}
		e.cancelLimitWait(id)
		_ = e.store.SetTaskLimitWaitState(ctx, id, "canceled", "continued manually", 0)
		result, err := e.Retry(ctx, id, RetryRequest{})
		if err == nil && hasHit {
			e.patchLimitHitStatus(ctx, id, hitSeq, info, "continued", "")
		}
		return result, err

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
		_ = e.store.SetTaskLimitWaitState(ctx, id, "canceled", "switched manually", 0)
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
		e.notifyQuota(ctx, taskID, info, status)
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

// --- auto wait scheduler (durable state plus an in-memory wakeup) ---

func (e *Engine) scheduleLimitWait(ctx context.Context, taskID string, resetAt int64) error {
	return e.scheduleLimitWaitMode(ctx, taskID, resetAt, false)
}

func (e *Engine) scheduleLimitWaitExplicit(ctx context.Context, taskID string, resetAt int64) error {
	return e.scheduleLimitWaitMode(ctx, taskID, resetAt, true)
}

func (e *Engine) scheduleLimitWaitMode(ctx context.Context, taskID string, resetAt int64, force bool) error {
	info, _, hasHit := e.latestOpenLimitHit(ctx, taskID)
	if !hasHit {
		info = adapter.RateLimitInfo{Kind: adapter.RateLimitKind}
	}
	if resetAt > 0 {
		// The caller's explicit reset overrides a stale event payload. Keep the
		// durable row and the in-memory timer anchored to the same deadline.
		info.ResetAt = resetAt
	}
	now := time.Now()
	next := now.Add(limitWaitProbeStart).UnixMilli()
	if resetAt > 0 {
		next = time.Unix(resetAt, 0).Add(2 * time.Second).UnixMilli()
		if next < now.UnixMilli() {
			next = now.UnixMilli()
		}
	}
	if err := e.persistLimitWait(ctx, taskID, info, next, 0, "", force); err != nil {
		return err
	}
	if wait, err := e.store.GetTaskLimitWait(ctx, taskID); err == nil {
		e.armLimitWaitTimer(taskID, wait.NextProbeAt)
	} else {
		e.armLimitWaitTimer(taskID, next)
	}
	return nil
}

func (e *Engine) persistLimitWait(
	ctx context.Context,
	taskID string,
	info adapter.RateLimitInfo,
	nextProbeAt int64,
	attempts int,
	lastError string,
	force bool,
) error {
	t, err := e.store.GetTask(ctx, taskID)
	if err != nil {
		return err
	}
	userSeq := e.latestUserSeq(ctx, taskID)
	now := time.Now().UnixMilli()
	firstWaitAt := now
	if old, err := e.store.GetTaskLimitWait(ctx, taskID); err == nil &&
		old.EventEpoch == t.EventEpoch && old.UserSeq == userSeq && old.FirstWaitAt > 0 {
		firstWaitAt = old.FirstWaitAt
		if attempts == 0 {
			attempts = old.Attempts
		}
	}
	if info.Agent == "" {
		info.Agent = t.Agent
	}
	if info.Provider == "" {
		info.Provider = providerForAgent(info.Agent)
	}
	wait := store.TaskLimitWait{
		TaskID:      taskID,
		EventEpoch:  t.EventEpoch,
		UserSeq:     userSeq,
		Agent:       info.Agent,
		Provider:    info.Provider,
		Window:      info.Window,
		ResetAt:     info.ResetAt,
		State:       "waiting",
		Attempts:    attempts,
		NextProbeAt: nextProbeAt,
		FirstWaitAt: firstWaitAt,
		LastError:   lastError,
		UpdatedAt:   now,
	}
	if force {
		if err := e.store.UpsertTaskLimitWait(ctx, wait); err != nil {
			return err
		}
		e.armQuotaWaitNotification(taskID, wait.FirstWaitAt)
		return nil
	}
	if err := e.store.UpsertTaskLimitWaitMonotonic(ctx, wait); err != nil {
		return err
	}
	e.armQuotaWaitNotification(taskID, wait.FirstWaitAt)
	return nil
}

func (e *Engine) latestUserSeq(ctx context.Context, taskID string) int {
	evs, err := e.store.ListEvents(ctx, taskID, 0)
	if err != nil {
		return 0
	}
	latest := 0
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
		if role == "user" || speaker == "user" {
			latest = ev.Seq
		}
	}
	return latest
}

func (e *Engine) armLimitWaitTimer(taskID string, dueAt int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.limitWaitCancel == nil {
		e.limitWaitCancel = make(map[string]context.CancelFunc)
	}
	if cancel, ok := e.limitWaitCancel[taskID]; ok {
		cancel()
		delete(e.limitWaitCancel, taskID)
	}
	delay := time.Until(time.UnixMilli(dueAt))
	if delay < 0 {
		delay = 0
	}
	// Do not rely on a runtime timer for long waits. The durable due time is
	// retained and the timer wakes in chunks so process sleep does not lose it.
	if delay > limitWaitTimerChunk {
		delay = limitWaitTimerChunk
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
	if cancel, ok := e.limitNotifyCancel[taskID]; ok {
		cancel()
		delete(e.limitNotifyCancel, taskID)
	}
}

func (e *Engine) armQuotaWaitNotification(taskID string, firstWaitAt int64) {
	if e.store == nil || e.notify == nil || firstWaitAt <= 0 {
		return
	}
	if _, ok := e.notify.(QuotaNotifier); !ok {
		return
	}
	e.mu.Lock()
	if e.limitNotifyCancel == nil {
		e.limitNotifyCancel = make(map[string]context.CancelFunc)
	}
	if cancel, ok := e.limitNotifyCancel[taskID]; ok {
		cancel()
	}
	ctx, cancel := context.WithCancel(e.ctx)
	e.limitNotifyCancel[taskID] = cancel
	e.mu.Unlock()
	dueAt := time.UnixMilli(firstWaitAt).Add(e.quotaWaitNotifyAfter(context.Background()))
	delay := time.Until(dueAt)
	if delay < 0 {
		delay = 0
	}
	go e.runQuotaWaitNotification(ctx, taskID, firstWaitAt, delay)
}

func (e *Engine) runQuotaWaitNotification(ctx context.Context, taskID string, firstWaitAt int64, delay time.Duration) {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
	}
	wait, err := e.store.GetTaskLimitWait(ctx, taskID)
	if err != nil || wait.FirstWaitAt != firstWaitAt ||
		(wait.State != "waiting" && wait.State != "probing") {
		return
	}
	e.notifyQuota(ctx, taskID, adapter.RateLimitInfo{
		Agent: wait.Agent, Provider: wait.Provider, Window: wait.Window, ResetAt: wait.ResetAt,
	}, "waiting")
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

	// Re-arm a chunked timer if the durable due time is still in the future.
	wait, err := e.store.GetTaskLimitWait(ctx, taskID)
	if err != nil || (wait.State != "waiting" && wait.State != "probing") {
		return
	}
	if wait.NextProbeAt > time.Now().UnixMilli() {
		e.armLimitWaitTimer(taskID, wait.NextProbeAt)
		return
	}
	wait, err = e.store.ClaimTaskLimitWait(ctx, taskID, time.Now().UnixMilli())
	if err != nil {
		return
	}

	// Only auto-continue if still failed and still waiting.
	t, err := e.store.GetTask(ctx, taskID)
	if err != nil {
		_ = e.store.SetTaskLimitWaitStateClaimed(ctx, taskID, wait.ClaimedAt, "canceled", "task is unavailable", 0)
		return
	}
	if t.Status != StatusFailed {
		// Retry may have committed a new epoch before returning an error. Keep
		// the durable wait alive while that run is still active so startup or a
		// later provider failure can re-arm it under the new turn identity.
		switch t.Status {
		case StatusQueued, StatusRunning, StatusWaitingApproval, StatusWaitingInput:
			wait.EventEpoch = t.EventEpoch
			wait.UserSeq = e.latestUserSeq(ctx, taskID)
			wait.Attempts++
			wait.LastError = "retry is still in progress"
			wait.NextProbeAt = time.Now().Add(limitWaitBackoff(wait.Attempts)).UnixMilli()
			wait.State = "waiting"
			wait.UpdatedAt = time.Now().UnixMilli()
			if err := e.store.UpdateTaskLimitWait(ctx, wait); err == nil {
				e.armLimitWaitTimer(taskID, wait.NextProbeAt)
			}
			return
		default:
			_ = e.store.SetTaskLimitWaitStateClaimed(ctx, taskID, wait.ClaimedAt, "canceled", "task is no longer failed", 0)
			return
		}
	}
	if t.EventEpoch != wait.EventEpoch || e.latestUserSeq(ctx, taskID) != wait.UserSeq {
		_ = e.store.SetTaskLimitWaitStateClaimed(ctx, taskID, wait.ClaimedAt, "canceled", "a newer user turn superseded this wait", 0)
		return
	}

	if wait.ResetAt == 0 {
		retry, next, probeErr := e.probeUnknownLimitWait(ctx, wait)
		if !retry {
			if e.limitWaitExpired(wait) {
				_ = e.store.SetTaskLimitWaitStateClaimed(
					ctx,
					taskID,
					wait.ClaimedAt,
					"blocked",
					firstNonEmptyStr(probeErr, "provider reset remains unknown"),
					0,
				)
				info, hitSeq, hasHit := e.latestOpenLimitHit(ctx, taskID)
				if hasHit {
					e.patchLimitHitStatus(ctx, taskID, hitSeq, info, "blocked", "")
				}
				return
			}
			wait.Attempts++
			wait.LastProbeAt = time.Now().UnixMilli()
			wait.LastError = probeErr
			wait.NextProbeAt = next
			wait.State = "waiting"
			wait.UpdatedAt = time.Now().UnixMilli()
			if err := e.store.UpdateTaskLimitWait(ctx, wait); err != nil {
				return
			}
			e.armLimitWaitTimer(taskID, next)
			return
		}
		if next > 0 {
			wait.ResetAt = next / 1000
			wait.NextProbeAt = next
			wait.State = "waiting"
			wait.UpdatedAt = time.Now().UnixMilli()
			if err := e.store.UpdateTaskLimitWait(ctx, wait); err != nil {
				return
			}
			e.armLimitWaitTimer(taskID, next)
			return
		}
	}

	info, hitSeq, hasHit := e.latestOpenLimitHit(ctx, taskID)
	if !hasHit {
		_ = e.store.SetTaskLimitWaitStateClaimed(ctx, taskID, wait.ClaimedAt, "canceled", "limit event no longer open", 0)
		return
	}
	if _, err := e.Retry(ctx, taskID, RetryRequest{}); err != nil {
		next := time.Now().Add(limitWaitBackoff(wait.Attempts + 1)).UnixMilli()
		wait.Attempts++
		wait.LastError = err.Error()
		wait.NextProbeAt = next
		wait.State = "waiting"
		wait.UpdatedAt = time.Now().UnixMilli()
		if current, getErr := e.store.GetTask(ctx, taskID); getErr == nil {
			wait.EventEpoch = current.EventEpoch
			wait.UserSeq = e.latestUserSeq(ctx, taskID)
		}
		if err := e.store.UpdateTaskLimitWait(ctx, wait); err != nil {
			return
		}
		// Retry itself failed, so keep the limit event actionable for the
		// next durable wakeup instead of leaving it terminal as "continued".
		e.patchLimitHitStatus(ctx, taskID, hitSeq, info, "waiting", "")
		e.armLimitWaitTimer(taskID, next)
		payload, _ := json.Marshal(map[string]string{
			"message": "auto-continue after rate limit failed: " + err.Error(),
		})
		if ev, err := e.store.AppendEvent(ctx, taskID, "error", payload); err == nil {
			e.bus.PublishEvent(ev)
		}
		return
	}
	e.patchLimitHitStatus(ctx, taskID, hitSeq, info, "continued", "")
	_ = e.store.SetTaskLimitWaitStateClaimed(ctx, taskID, wait.ClaimedAt, "completed", "", 0)
}

func limitWaitBackoff(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	d := limitWaitProbeStart
	for i := 1; i < attempts; i++ {
		if d >= limitWaitProbeMax/2 {
			return limitWaitProbeMax
		}
		d *= 2
	}
	if d > limitWaitProbeMax {
		return limitWaitProbeMax
	}
	return d
}

func (e *Engine) limitWaitMaxElapsed(ctx context.Context) time.Duration {
	if e.store != nil {
		if raw, err := e.store.GetSetting(ctx, KeyLimitWaitMaxElapsedSecs); err == nil {
			if seconds, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err == nil && seconds > 0 {
				return time.Duration(seconds) * time.Second
			}
		}
	}
	return limitWaitDefaultMax
}

func (e *Engine) limitWaitExpired(wait store.TaskLimitWait) bool {
	return wait.FirstWaitAt > 0 && time.Since(time.UnixMilli(wait.FirstWaitAt)) >= e.limitWaitMaxElapsed(context.Background())
}

// probeUnknownLimitWait returns retry=true when the provider window is known
// to be available. A positive next value means a reset was discovered.
func (e *Engine) probeUnknownLimitWait(ctx context.Context, wait store.TaskLimitWait) (retry bool, next int64, lastError string) {
	if e.usageWindows == nil || strings.TrimSpace(wait.Provider) == "" {
		return false, time.Now().Add(limitWaitBackoff(wait.Attempts + 1)).UnixMilli(), "provider reset is unavailable"
	}
	pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for _, p := range e.usageWindows.Statuses(pctx) {
		if p.Provider != wait.Provider {
			continue
		}
		if p.Error != "" {
			return false, time.Now().Add(limitWaitBackoff(wait.Attempts + 1)).UnixMilli(), p.Error
		}
		for _, w := range p.Windows {
			if w.Status == "over" {
				if w.ResetAt > 0 {
					return false, time.Unix(w.ResetAt, 0).Add(2 * time.Second).UnixMilli(), ""
				}
				return false, time.Now().Add(limitWaitBackoff(wait.Attempts + 1)).UnixMilli(), "provider still reports an exhausted window"
			}
		}
		return true, 0, ""
	}
	return false, time.Now().Add(limitWaitBackoff(wait.Attempts + 1)).UnixMilli(), "provider window status unavailable"
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
