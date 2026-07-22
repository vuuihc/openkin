package task

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/vuuihc/kin/internal/store"
)

// eventWriter is the narrow persistence seam for task events.
// Tests inject failures here without corrupting a real database.
type eventWriter interface {
	AppendEvent(ctx context.Context, taskID, typ string, payload json.RawMessage) (store.Event, error)
	AppendUsageEvent(ctx context.Context, taskID, typ string, payload json.RawMessage, record store.UsageRecord) (store.Event, store.Task, error)
}

// storeEventWriter is the production writer backed by *store.Store.
type storeEventWriter struct {
	st *store.Store
}

func (w storeEventWriter) AppendEvent(ctx context.Context, taskID, typ string, payload json.RawMessage) (store.Event, error) {
	return w.st.AppendEvent(ctx, taskID, typ, payload)
}

func (w storeEventWriter) AppendUsageEvent(ctx context.Context, taskID, typ string, payload json.RawMessage, record store.UsageRecord) (store.Event, store.Task, error) {
	return w.st.AppendUsageEvent(ctx, taskID, typ, payload, record)
}

func (e *Engine) eventWriter() eventWriter {
	if e != nil && e.events != nil {
		return e.events
	}
	if e == nil || e.store == nil {
		return nil
	}
	return storeEventWriter{st: e.store}
}

// setEventWriter injects a test double for event persistence (tests only).
func (e *Engine) setEventWriter(w eventWriter) {
	if e == nil {
		return
	}
	e.events = w
}

// persistGap tracks disposable event drops so a later successful write can
// emit an observable diagnostic without failing the whole task.
type persistGap struct {
	dropped int
	lastErr string
}

// notePersistFailure records a failed append. Critical failures force a non-success
// terminal state; disposable failures only degrade the live preview.
func (e *Engine) notePersistFailure(taskID, typ string, payload json.RawMessage, err error) {
	if e == nil || err == nil {
		return
	}
	if isCriticalEvent(typ, payload) {
		e.mu.Lock()
		if e.criticalPersistFail == nil {
			e.criticalPersistFail = make(map[string]error)
		}
		e.criticalPersistFail[taskID] = err
		e.mu.Unlock()
		return
	}
	e.persistMu.Lock()
	if e.persistGaps == nil {
		e.persistGaps = make(map[string]*persistGap)
	}
	g := e.persistGaps[taskID]
	if g == nil {
		g = &persistGap{}
		e.persistGaps[taskID] = g
	}
	g.dropped++
	g.lastErr = err.Error()
	e.persistMu.Unlock()
}

func (e *Engine) hasCriticalPersistFailure(taskID string) bool {
	if e == nil {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.criticalPersistFail[taskID]
	return ok
}

func (e *Engine) clearPersistTracking(taskID string) {
	if e == nil {
		return
	}
	e.mu.Lock()
	delete(e.criticalPersistFail, taskID)
	e.mu.Unlock()
	e.persistMu.Lock()
	delete(e.persistGaps, taskID)
	e.persistMu.Unlock()
}

// maybeEmitPersistDiagnostic writes an observable note when the store becomes
// writable again after disposable event drops. Best-effort; never fails the task.
func (e *Engine) maybeEmitPersistDiagnostic(ctx context.Context, taskID string) {
	if e == nil {
		return
	}
	e.persistMu.Lock()
	g := e.persistGaps[taskID]
	if g == nil || g.dropped == 0 {
		e.persistMu.Unlock()
		return
	}
	dropped := g.dropped
	lastErr := g.lastErr
	delete(e.persistGaps, taskID)
	e.persistMu.Unlock()

	line := fmt.Sprintf("event persistence degraded: dropped %d partial event(s)", dropped)
	if lastErr != "" {
		line = fmt.Sprintf("%s (last error: %s)", line, lastErr)
	}
	note, _ := json.Marshal(map[string]string{"line": line})
	w := e.eventWriter()
	if w == nil {
		return
	}
	// Bypass appendEventLocked to avoid re-entering gap bookkeeping under the
	// same eventMu lock; diagnostic itself is disposable.
	if stored, err := w.AppendEvent(ctx, taskID, "raw_output", note); err == nil {
		e.bus.PublishEvent(stored)
	}
}

// isCriticalEvent reports whether losing this event would make a successful
// terminal state dishonest. Final results, approvals, errors, and canonical
// user-visible messages are critical; disposable partial progress is not.
func isCriticalEvent(typ string, payload json.RawMessage) bool {
	switch typ {
	case "result", "error", "approval_requested", "approval_decided":
		return true
	case "message":
		return isCriticalMessage(payload)
	default:
		// tool_use, tool_result, usage, raw_output, task_started, meta, …
		return false
	}
}

func isCriticalMessage(payload json.RawMessage) bool {
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil || m == nil {
		// Unreadable message payloads are treated as critical so we do not
		// silently succeed after losing unknown user-facing content.
		return true
	}
	if role, _ := m["role"].(string); strings.EqualFold(strings.TrimSpace(role), "user") {
		return true
	}
	if partial, _ := m["partial"].(bool); partial {
		return false
	}
	if v := visibilityFromMap(m); v != nil {
		return v.User
	}
	// Explicit phase summary is always user-facing.
	if phase, _ := m["phase"].(string); phase == PhaseSummary {
		return true
	}
	// Host/orchestrator control sources without visibility are user-facing.
	source, _ := m["source"].(string)
	switch source {
	case OriginOrchestrator, OriginDelegate, OriginHost, OriginCreate, OriginFollowUp:
		return true
	}
	return false
}
