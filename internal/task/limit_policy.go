package task

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/usagewindows"
)

// Settings keys for rate-limit continue policy.
const (
	// KeyLimitPolicy is the global default when a session hits provider limits.
	// Values: wait | ask | switch. Empty / unknown → wait.
	KeyLimitPolicy = "limit_policy"
	// KeyLimitFallbackAgents is an optional JSON array of agent ids used when
	// policy=switch (e.g. `["codex","kin"]`). Empty → registry order, skip current.
	KeyLimitFallbackAgents = "limit_policy.fallback_agents"
	// KeyLimitWaitMaxElapsedSecs bounds automatic waiting when a provider never
	// reports a usable reset. Empty or invalid values use the safe default.
	KeyLimitWaitMaxElapsedSecs = "limit_wait.max_elapsed_secs"
	// KeyQuotaWaitNotifyAfterSecs controls when a long quota wait becomes
	// push-worthy. Empty or invalid values use the 15-minute default.
	KeyQuotaWaitNotifyAfterSecs = "notify.quota_wait_after_secs"
)

const (
	limitWaitTimerChunk    = 24 * time.Hour
	limitWaitProbeStart    = 30 * time.Second
	limitWaitProbeMax      = 15 * time.Minute
	limitWaitDefaultMax    = 7 * 24 * time.Hour
	quotaWaitNotifyDefault = 15 * time.Minute
	maxQuotaWaitNotifySecs = int64((1<<63 - 1) / int64(time.Second))
)

// Limit policy values.
const (
	LimitPolicyWait   = "wait"
	LimitPolicyAsk    = "ask"
	LimitPolicySwitch = "switch"
)

// UsageWindowProber is optional; when set, startOne can preflight subscription windows.
type UsageWindowProber interface {
	Statuses(ctx context.Context) []usagewindows.Provider
}

// NormalizeLimitPolicy maps free-form config to wait|ask|switch.
// sticky is accepted as an alias of wait.
func NormalizeLimitPolicy(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case LimitPolicyAsk:
		return LimitPolicyAsk
	case LimitPolicySwitch:
		return LimitPolicySwitch
	case LimitPolicyWait, "sticky", "":
		return LimitPolicyWait
	default:
		return LimitPolicyWait
	}
}

// LimitPolicy returns the configured global policy (default wait).
func (e *Engine) LimitPolicy(ctx context.Context) string {
	if e.store == nil {
		return LimitPolicyWait
	}
	raw, err := e.store.GetSetting(ctx, KeyLimitPolicy)
	if err != nil {
		return LimitPolicyWait
	}
	return NormalizeLimitPolicy(raw)
}

// SetUsageWindows wires the optional subscription-window prober (serve setup).
func (e *Engine) SetUsageWindows(p UsageWindowProber) {
	e.usageWindows = p
}

// applyLimitPolicy reacts to a newly opened limit_hit according to settings.
// wait (default): arm auto-continue when reset_at is known.
// switch: hand off to the first available fallback agent.
// ask: leave the card open for the user.
func (e *Engine) applyLimitPolicy(ctx context.Context, taskID, agent string, info adapter.RateLimitInfo) {
	policy := e.LimitPolicy(ctx)
	switch policy {
	case LimitPolicyAsk:
		return
	case LimitPolicySwitch:
		to := e.pickFallbackAgent(ctx, agent)
		if to == "" {
			// No alternative — fall back to wait behavior.
			if info.ResetAt > 0 {
				e.autoArmWait(ctx, taskID, agent, info)
			}
			return
		}
		// Mark switched and hand off. Task must be terminal/failed first.
		t, err := e.store.GetTask(ctx, taskID)
		if err != nil {
			return
		}
		if t.Status != StatusFailed && t.Status != StatusSucceeded && t.Status != StatusCanceled {
			// Ensure failed so FollowUp accepts the handoff.
			status := StatusFailed
			now := e.nowMilli()
			_ = e.store.UpdateTask(ctx, taskID, store.TaskPatch{Status: &status, FinishedAt: &now})
		}
		prompt, err := e.lastUserPrompt(ctx, taskID, t.Prompt)
		if err != nil || strings.TrimSpace(prompt) == "" {
			return
		}
		e.patchLimitHitStatus(ctx, taskID, 0, info, "switched", to)
		if _, err := e.FollowUpWith(ctx, taskID, FollowUpRequest{Prompt: prompt, Agent: to}); err != nil {
			payload, _ := json.Marshal(map[string]string{
				"message": "auto-switch after rate limit failed: " + err.Error(),
			})
			if ev, err := e.store.AppendEvent(ctx, taskID, "error", payload); err == nil {
				e.bus.PublishEvent(ev)
			}
		}
	default: // wait
		e.autoArmWait(ctx, taskID, agent, info)
	}
}

func (e *Engine) autoArmWait(ctx context.Context, taskID, agent string, info adapter.RateLimitInfo) {
	if info.Agent == "" {
		info.Agent = agent
	}
	if info.Provider == "" {
		info.Provider = providerForAgent(agent)
	}
	t, err := e.store.GetTask(ctx, taskID)
	if err != nil || t.Status != StatusFailed {
		// Only arm after the run has failed; finish path re-invokes policy.
		return
	}
	e.patchLimitHitStatus(ctx, taskID, 0, info, "waiting", "")
	if err := e.scheduleLimitWait(ctx, taskID, info.ResetAt); err != nil {
		return
	}
}

// pickFallbackAgent chooses the first ready agent that is not current.
func (e *Engine) pickFallbackAgent(ctx context.Context, current string) string {
	current = strings.TrimSpace(current)
	// Configured list first.
	if e.store != nil {
		if raw, err := e.store.GetSetting(ctx, KeyLimitFallbackAgents); err == nil {
			raw = strings.TrimSpace(raw)
			if raw != "" && raw != "[]" {
				var ids []string
				if json.Unmarshal([]byte(raw), &ids) == nil {
					for _, id := range ids {
						id = strings.TrimSpace(id)
						if id == "" || id == current {
							continue
						}
						if _, err := e.agents.GetRunnable(ctx, id); err == nil {
							return id
						}
					}
				}
			}
		}
	}
	for _, id := range e.AgentIDs() {
		if id == current {
			continue
		}
		if _, err := e.agents.GetRunnable(ctx, id); err == nil {
			return id
		}
	}
	return ""
}

// preflightUsageLimit reports whether the agent's subscription window is already over.
// Best-effort: missing prober / probe errors → not blocked.
func (e *Engine) preflightUsageLimit(ctx context.Context, agentID string) (adapter.RateLimitInfo, bool) {
	if e.usageWindows == nil {
		return adapter.RateLimitInfo{}, false
	}
	providerID := providerForAgent(agentID)
	if providerID == "" || providerID == "kin" {
		// Kin uses OpenAI-compatible providers without these CLI windows.
		return adapter.RateLimitInfo{}, false
	}
	// Bound probe time so a hung network cannot stall the queue forever.
	pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	statuses := e.usageWindows.Statuses(pctx)
	for _, p := range statuses {
		if p.Provider != providerID {
			continue
		}
		if p.Error != "" {
			return adapter.RateLimitInfo{}, false
		}
		var worst *usagewindows.Window
		for i := range p.Windows {
			w := &p.Windows[i]
			if w.Status != "over" {
				continue
			}
			if worst == nil || w.ResetAt > worst.ResetAt {
				worst = w
			}
		}
		if worst == nil {
			return adapter.RateLimitInfo{}, false
		}
		msg := providerID + " " + worst.Kind + " usage window is exhausted"
		return adapter.RateLimitInfo{
			Kind:     adapter.RateLimitKind,
			Provider: providerID,
			Agent:    agentID,
			Message:  msg,
			ResetAt:  worst.ResetAt,
			Window:   worst.Kind,
			Source:   "usage_window",
		}, true
	}
	return adapter.RateLimitInfo{}, false
}

// emitOpenLimitHit writes a limit_hit with status=open (or waiting when auto).
// Returns the info and whether a new card was emitted.
func (e *Engine) emitOpenLimitHit(ctx context.Context, taskID, agent string, info adapter.RateLimitInfo) bool {
	if info.Kind == "" {
		info.Kind = adapter.RateLimitKind
	}
	if info.Agent == "" {
		info.Agent = agent
	}
	if info.Provider == "" {
		info.Provider = providerForAgent(agent)
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
				return false
			}
		}
	}

	out := map[string]any{
		"kind":     adapter.RateLimitKind,
		"message":  info.Message,
		"agent":    info.Agent,
		"provider": info.Provider,
		"source":   firstNonEmptyStr(info.Source, "error"),
		"status":   "open",
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
			e.notifyQuota(ctx, taskID, info, "open")
			return true
		}
	} else if e.store != nil {
		if ev, err := e.store.AppendEvent(ctx, taskID, "limit_hit", b); err == nil {
			e.bus.PublishEvent(ev)
			e.notifyQuota(ctx, taskID, info, "open")
			return true
		}
	}
	return false
}

func (e *Engine) notifyQuota(ctx context.Context, taskID string, info adapter.RateLimitInfo, status string) {
	n, ok := e.notify.(QuotaNotifier)
	if !ok || e.store == nil {
		return
	}
	if status != "continued" && status != "resumed" && status != "blocked" &&
		status != "open" && status != "waiting" {
		return
	}
	t, err := e.store.GetTask(ctx, taskID)
	if err != nil {
		return
	}
	if status == "open" || status == "waiting" {
		wait, err := e.store.GetTaskLimitWait(ctx, taskID)
		if err != nil {
			return
		}
		threshold := e.quotaWaitNotifyAfter(ctx)
		now := time.Now()
		longWait := wait.FirstWaitAt > 0 && now.Sub(time.UnixMilli(wait.FirstWaitAt)) >= threshold
		if !longWait {
			return
		}
		e.quotaNotifyMu.Lock()
		if e.quotaNotified == nil {
			e.quotaNotified = make(map[string]int64)
		}
		if e.quotaNotified[taskID] == wait.FirstWaitAt {
			e.quotaNotifyMu.Unlock()
			return
		}
		e.quotaNotified[taskID] = wait.FirstWaitAt
		e.quotaNotifyMu.Unlock()
	}
	n.NotifyQuota(ctx, taskID, t.Title, status, info.ResetAt)
}

func (e *Engine) quotaWaitNotifyAfter(ctx context.Context) time.Duration {
	threshold := quotaWaitNotifyDefault
	if e.store != nil {
		if raw, err := e.store.GetSetting(ctx, KeyQuotaWaitNotifyAfterSecs); err == nil {
			if seconds, parseErr := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); parseErr == nil &&
				seconds > 0 && seconds <= maxQuotaWaitNotifySecs {
				threshold = time.Duration(seconds) * time.Second
			}
		}
	}
	return threshold
}

// handleNewLimitHit emits a card (if needed) and applies the global policy.
func (e *Engine) handleNewLimitHit(ctx context.Context, taskID, agent string, info adapter.RateLimitInfo) {
	if !e.emitOpenLimitHit(ctx, taskID, agent, info) {
		// Card already present for this turn — still try to arm wait if policy says so
		// and status is still open (e.g. live error then finish).
		if e.LimitPolicy(ctx) == LimitPolicyWait {
			if t, err := e.store.GetTask(ctx, taskID); err == nil && t.Status == StatusFailed {
				_, _, has := e.latestOpenLimitHit(ctx, taskID)
				if has && info.ResetAt > 0 {
					e.autoArmWait(ctx, taskID, agent, info)
				}
			}
		}
		return
	}
	// Only auto-apply policy once the task is (or will immediately be) failed.
	// For live mid-run errors we wait until finish; scanAndEmitLimitHit / finish path
	// call this again. For preflight and failStart, status is already failed.
	if t, err := e.store.GetTask(ctx, taskID); err == nil {
		if t.Status == StatusFailed || t.Status == StatusSucceeded || t.Status == StatusCanceled {
			e.applyLimitPolicy(ctx, taskID, agent, info)
		}
	}
}

// recoverLimitWaits re-arms durable auto-continue timers after a daemon restart.
func (e *Engine) recoverLimitWaits(ctx context.Context) {
	if e.store == nil {
		return
	}
	// Any probing row belongs to a worker from the previous process lifetime.
	// Release it before arming timers so a quick restart is recoverable too.
	if err := e.store.RequeueTaskLimitWaitClaims(ctx); err != nil {
		return
	}
	var afterProbeAt int64
	var afterTaskID string
	for {
		waits, err := e.store.ListActiveTaskLimitWaitsPage(ctx, afterProbeAt, afterTaskID, 1000)
		if err != nil {
			return
		}
		for _, wait := range waits {
			e.armLimitWaitTimer(wait.TaskID, wait.NextProbeAt)
			e.armQuotaWaitNotification(wait.TaskID, wait.FirstWaitAt)
		}
		if len(waits) < 1000 {
			break
		}
		last := waits[len(waits)-1]
		afterProbeAt = last.NextProbeAt
		afterTaskID = last.TaskID
	}

	// Backfill waits created before migration 018. Paginate instead of relying
	// on ListTasks' UI-oriented 200-row cap.
	var before string
	for {
		tasks, err := e.store.ListTasks(ctx, store.ListTasksOpts{Status: StatusFailed, Limit: 200, Before: before})
		if err != nil || len(tasks) == 0 {
			break
		}
		for _, t := range tasks {
			if _, err := e.store.GetTaskLimitWait(ctx, t.ID); err == nil {
				continue
			}
			info, _, has := e.latestOpenLimitHit(ctx, t.ID)
			if !has {
				continue
			}
			// latestOpenLimitHit returns open|waiting. Only re-arm explicit waiting
			// with a known reset; open cards stay for the user (or default wait on next hit).
			evs, err := e.store.ListEvents(ctx, t.ID, 0)
			if err != nil {
				continue
			}
			status := "open"
			for i := len(evs) - 1; i >= 0; i-- {
				if evs[i].Type != "limit_hit" {
					continue
				}
				var m map[string]any
				_ = json.Unmarshal(evs[i].Payload, &m)
				if s, _ := m["status"].(string); s != "" {
					status = strings.ToLower(s)
				}
				break
			}
			if status != "waiting" {
				// Default policy is wait: also re-arm open cards with reset_at so
				// restart does not strand sessions that never got a user click.
				if status == "open" && info.ResetAt > 0 && e.LimitPolicy(ctx) == LimitPolicyWait {
					e.autoArmWait(ctx, t.ID, t.Agent, info)
				} else if status == "waiting" && e.LimitPolicy(ctx) == LimitPolicyWait {
					_ = e.scheduleLimitWait(ctx, t.ID, info.ResetAt)
				}
				continue
			}
			_ = e.scheduleLimitWait(ctx, t.ID, info.ResetAt)
		}
		before = tasks[len(tasks)-1].ID
		if len(tasks) < 200 {
			break
		}
	}
}
