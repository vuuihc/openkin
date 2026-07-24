package task

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
)

// ReportSignalTrailer is appended to routine prompts so agents self-report
// whether the run is noteworthy. Keep in sync with ADR 0011 prompt convention.
const ReportSignalTrailer = `

---
When finished, end your final reply with exactly two lines:
TLDR: <one-line summary of what you found>
noteworthy: true|false
Use noteworthy: true only if the user should be interrupted (real change, risk, or action needed). Use false for quiet "nothing new" runs.
`

var (
	reTLDR       = regexp.MustCompile(`(?im)^\s*TLDR:\s*(.+?)\s*$`)
	reNoteworthy = regexp.MustCompile(`(?im)^\s*noteworthy:\s*(true|false|yes|no|1|0)\s*$`)
)

// ParseReportSignal extracts TL;DR + noteworthy from agent output.
// Defaults: empty tldr, noteworthy=false (silent feed).
func ParseReportSignal(text string) (tldr string, noteworthy bool) {
	if m := reTLDR.FindStringSubmatch(text); len(m) == 2 {
		tldr = strings.TrimSpace(m[1])
	}
	if m := reNoteworthy.FindStringSubmatch(text); len(m) == 2 {
		switch strings.ToLower(strings.TrimSpace(m[1])) {
		case "true", "yes", "1":
			noteworthy = true
		}
	}
	return tldr, noteworthy
}

// RoutineNotifier is an optional extension of Notifier for routine-specific push.
type RoutineNotifier interface {
	NotifyRoutine(ctx context.Context, taskID, title, tldr string, noteworthy bool)
	NotifyRoutineFailure(ctx context.Context, routineID, title, message string)
}

// onRoutineTerminal records the report signal, unread flag, circuit breaker,
// and optional push. Never raises — background failure must not block the engine.
func (e *Engine) onRoutineTerminal(ctx context.Context, t store.Task, status string) {
	if e == nil || e.store == nil || t.RoutineID == "" {
		return
	}
	tldr, noteworthy := e.extractRoutineSignal(ctx, t.ID)
	if status != StatusSucceeded {
		// Failures are always surfaced as noteworthy in the feed, but push is
		// reserved for the circuit-breaker alert (one alert after N failures).
		noteworthy = true
		if tldr == "" {
			tldr = "run " + status
		}
	}
	unread := true
	patch := store.TaskPatch{
		RoutineTLDR:       &tldr,
		RoutineNoteworthy: &noteworthy,
		RoutineUnread:     &unread,
	}
	if err := e.store.UpdateTask(ctx, t.ID, patch); err != nil {
		return
	}
	if updated, err := e.store.GetTask(ctx, t.ID); err == nil {
		t = updated
		e.bus.PublishTask(t)
	}

	// Update routine bookkeeping / circuit breaker.
	r, err := e.store.GetRoutine(ctx, t.RoutineID)
	if err != nil {
		// Routine may have been deleted; keep the historical task.
		if noteworthy {
			e.pushRoutine(ctx, t, true)
		}
		return
	}

	if status == StatusSucceeded {
		zero := 0
		_ = e.store.UpdateRoutine(ctx, r.ID, store.RoutinePatch{ConsecFailures: &zero})
		if noteworthy {
			e.pushRoutine(ctx, t, true)
		}
		return
	}

	// failed / canceled → bump consec_failures; auto-disable after N.
	fails := r.ConsecFailures + 1
	patchR := store.RoutinePatch{ConsecFailures: &fails}
	tripped := fails >= store.RoutineMaxConsecFailures
	if tripped {
		off := false
		patchR.Enabled = &off
	}
	_ = e.store.UpdateRoutine(ctx, r.ID, patchR)
	if tripped {
		e.pushRoutineFailure(ctx, r, fmt.Sprintf("auto-disabled after %d consecutive failures", fails))
	}
}

func (e *Engine) extractRoutineSignal(ctx context.Context, taskID string) (string, bool) {
	// Prefer the latest result event text; fall back to last assistant message.
	evs, err := e.store.ListEvents(ctx, taskID, 0)
	if err != nil || len(evs) == 0 {
		return "", false
	}
	var resultText, lastAssistant string
	for _, ev := range evs {
		switch ev.Type {
		case "result":
			if parsed, ok := adapter.ParseResult(ev.Payload); ok && strings.TrimSpace(parsed.Text) != "" {
				resultText = parsed.Text
			} else {
				var m map[string]any
				if json.Unmarshal(ev.Payload, &m) == nil {
					if s, _ := m["text"].(string); s != "" {
						resultText = s
					} else if s, _ := m["result"].(string); s != "" {
						resultText = s
					}
				}
			}
		case "message":
			var m struct {
				Role    string `json:"role"`
				Speaker string `json:"speaker"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			}
			if json.Unmarshal(ev.Payload, &m) != nil {
				continue
			}
			if m.Role != "assistant" && m.Speaker != "assistant" {
				continue
			}
			var b strings.Builder
			for _, c := range m.Content {
				if c.Type == "text" || c.Type == "" {
					b.WriteString(c.Text)
				}
			}
			if s := b.String(); s != "" {
				lastAssistant = s
			}
		}
	}
	text := resultText
	if text == "" {
		text = lastAssistant
	}
	return ParseReportSignal(text)
}

func (e *Engine) pushRoutine(ctx context.Context, t store.Task, noteworthy bool) {
	if e.notify == nil {
		return
	}
	if rn, ok := e.notify.(RoutineNotifier); ok {
		rn.NotifyRoutine(ctx, t.ID, t.Title, t.RoutineTLDR, noteworthy)
		return
	}
	// Fallback: reuse terminal notify with tldr body.
	if noteworthy {
		title := t.Title
		if t.RoutineTLDR != "" {
			title = t.Title
		}
		e.notify.NotifyTaskTerminal(ctx, t.ID, title, "noteworthy")
	}
}

func (e *Engine) pushRoutineFailure(ctx context.Context, r store.Routine, message string) {
	if e.notify == nil {
		return
	}
	if rn, ok := e.notify.(RoutineNotifier); ok {
		rn.NotifyRoutineFailure(ctx, r.ID, r.Title, message)
		return
	}
	e.notify.NotifyTaskTerminal(ctx, r.ID, r.Title, "disabled")
}
