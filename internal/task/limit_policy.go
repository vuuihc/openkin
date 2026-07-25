package task

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/usagewindows"
)

// Settings keys for rate-limit continue policy.
const (
	// KeyLimitPolicy is the global default when a session hits provider limits.
	// Values: wait | ask | switch. Empty / unknown → wait.
	KeyLimitPolicy = "limit_policy"
	// KeyLimitFallbackAgents is an optional JSON array of agent ids used when
	// policy=switch (e.g. `["codex","kin"]`). Empty → registry order, skip current.
	KeyLimitFallbackAgents = "limit_policy.fallback_agents"
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
	if info.ResetAt > 0 {
		e.scheduleLimitWait(taskID, info.ResetAt)
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
			return true
		}
	} else if e.store != nil {
		if ev, err := e.store.AppendEvent(ctx, taskID, "limit_hit", b); err == nil {
			e.bus.PublishEvent(ev)
			return true
		}
	}
	return false
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

// recoverLimitWaits re-arms auto-continue timers for failed tasks that were left
// in status=waiting after a daemon restart.
func (e *Engine) recoverLimitWaits(ctx context.Context) {
	if e.store == nil {
		return
	}
	tasks, err := e.store.ListTasks(ctx, store.ListTasksOpts{Status: StatusFailed, Limit: 200})
	if err != nil {
		return
	}
	for _, t := range tasks {
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
			}
			continue
		}
		if info.ResetAt > 0 {
			e.scheduleLimitWait(t.ID, info.ResetAt)
		}
	}
}
