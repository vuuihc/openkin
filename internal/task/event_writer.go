package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
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

// AppendExternalEvent appends an event produced by a task-attached worker.
// It shares the engine event mutex so external workers cannot race the
// adapter event loop while allocating the next task sequence number.
func (e *Engine) AppendExternalEvent(
	ctx context.Context,
	taskID, typ string,
	payload json.RawMessage,
) (store.Event, error) {
	if e == nil {
		return store.Event{}, fmt.Errorf("task engine is nil")
	}
	e.eventMu.Lock()
	defer e.eventMu.Unlock()
	w := e.eventWriter()
	if w == nil {
		return store.Event{}, fmt.Errorf("event writer unavailable")
	}
	event, err := w.AppendEvent(ctx, taskID, typ, payload)
	if err != nil {
		return store.Event{}, err
	}
	if e.bus != nil {
		e.bus.PublishEvent(event)
	}
	return event, nil
}

func (e *Engine) persistRunEvent(
	ctx context.Context,
	taskID, executionID, typ string,
	payload json.RawMessage,
) (store.Event, error) {
	e.eventMu.Lock()
	defer e.eventMu.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.activeRuns[taskID] != executionID {
		return store.Event{}, store.ErrConflict
	}
	w := e.eventWriter()
	if w == nil {
		return store.Event{}, fmt.Errorf("event writer unavailable")
	}
	return w.AppendEvent(ctx, taskID, typ, payload)
}

func (e *Engine) persistRunUsageEvent(
	ctx context.Context,
	taskID, executionID, typ string,
	payload json.RawMessage,
	record store.UsageRecord,
) (store.Event, store.Task, error) {
	e.eventMu.Lock()
	defer e.eventMu.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.activeRuns[taskID] != executionID {
		return store.Event{}, store.Task{}, store.ErrConflict
	}
	w := e.eventWriter()
	if w == nil {
		return store.Event{}, store.Task{}, fmt.Errorf("event writer unavailable")
	}
	return w.AppendUsageEvent(ctx, taskID, typ, payload, record)
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

func (e *Engine) noteRunPersistFailure(
	taskID, executionID, typ string,
	payload json.RawMessage,
	err error,
) {
	if e == nil || err == nil {
		return
	}
	e.mu.Lock()
	if e.activeRuns[taskID] != executionID {
		e.mu.Unlock()
		return
	}
	if isCriticalEvent(typ, payload) {
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
	e.mu.Unlock()
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

// appendUsageEventLocked keeps event ordering and usage accounting atomic when
// parallel worker streams write to the same task.
func (e *Engine) appendUsageEventLocked(
	ctx context.Context,
	taskID, typ string,
	payload json.RawMessage,
	defaultAgent, defaultModel string,
) (bool, error) {
	record, err := NormalizeUsage(defaultAgent, defaultModel, payload)
	if err != nil {
		e.notePersistFailure(taskID, typ, payload, err)
		return false, err
	}
	missingPriceModel := e.populateEstimatedUsageCost(ctx, &record)

	e.eventMu.Lock()
	defer e.eventMu.Unlock()
	w := e.eventWriter()
	if w == nil {
		err := fmt.Errorf("event writer unavailable")
		e.notePersistFailure(taskID, typ, payload, err)
		return false, err
	}
	stored, updatedTask, err := w.AppendUsageEvent(ctx, taskID, typ, payload, record)
	if err != nil {
		e.notePersistFailure(taskID, typ, payload, err)
		return false, err
	}
	e.bus.PublishEvent(stored)
	e.bus.PublishTask(updatedTask)
	if missingPriceModel != "" {
		note, _ := json.Marshal(map[string]string{
			"line": fmt.Sprintf("price_table has no entry for model %q; cost_usd left null", missingPriceModel),
		})
		if diagnostic, appendErr := w.AppendEvent(ctx, taskID, "raw_output", note); appendErr == nil {
			e.bus.PublishEvent(diagnostic)
		}
	}
	return true, nil
}

func (e *Engine) appendUsageEventLockedForRun(
	ctx context.Context,
	taskID, executionID, typ string,
	payload json.RawMessage,
	defaultAgent, defaultModel string,
) (bool, error) {
	record, err := NormalizeUsage(defaultAgent, defaultModel, payload)
	if err != nil {
		e.noteRunPersistFailure(taskID, executionID, typ, payload, err)
		return false, err
	}
	missingPriceModel := e.populateEstimatedUsageCost(ctx, &record)
	stored, updatedTask, err := e.persistRunUsageEvent(
		ctx, taskID, executionID, typ, payload, record,
	)
	if err != nil {
		if !errors.Is(err, store.ErrConflict) {
			e.noteRunPersistFailure(taskID, executionID, typ, payload, err)
		}
		return false, err
	}
	e.bus.PublishEvent(stored)
	e.bus.PublishTask(updatedTask)
	if missingPriceModel != "" {
		note, _ := json.Marshal(map[string]string{
			"line": fmt.Sprintf("price_table has no entry for model %q; cost_usd left null", missingPriceModel),
		})
		if diagnostic, appendErr := e.persistRunEvent(
			ctx, taskID, executionID, "raw_output", note,
		); appendErr == nil {
			e.bus.PublishEvent(diagnostic)
		}
	}
	return true, nil
}

// isCriticalEvent reports whether losing this event would make a successful
// terminal state dishonest. Final results, approvals, errors, and canonical
// user-visible messages are critical; disposable partial progress is not.
func isCriticalEvent(typ string, payload json.RawMessage) bool {
	switch typ {
	case "result", "error", "usage", "approval_requested", "approval_decided":
		return true
	case "message":
		return isCriticalMessage(payload)
	default:
		// tool_use, tool_result, raw_output, task_started, meta, …
		return false
	}
}

func isCriticalMessage(payload json.RawMessage) bool {
	semantic, err := adapter.DecodeEvent(adapter.Event{Type: "message", Payload: payload})
	if err != nil || semantic.Message == nil {
		// Unreadable message payloads are treated as critical so we do not
		// silently succeed after losing unknown user-facing content.
		return true
	}
	if strings.EqualFold(strings.TrimSpace(semantic.Message.Role), "user") {
		return true
	}
	if semantic.Message.Partial {
		return false
	}
	if semantic.Visibility != nil {
		return semantic.Visibility.User
	}
	var metadata struct {
		Phase  string `json:"phase"`
		Source string `json:"source"`
	}
	_ = json.Unmarshal(payload, &metadata)
	// Explicit phase summary is always user-facing.
	if metadata.Phase == PhaseSummary {
		return true
	}
	// Host/orchestrator control sources without visibility are user-facing.
	switch metadata.Source {
	case OriginOrchestrator, OriginDelegate, OriginHost, OriginCreate, OriginFollowUp:
		return true
	}
	return false
}
