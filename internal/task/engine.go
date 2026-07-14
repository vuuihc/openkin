// Package task implements the task engine: state machine, queue, event log (spec §5).
package task

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/adapter/claudecode"
	"github.com/vuuihc/kin/internal/store"
)

// Status values (spec §3 / §5).
const (
	StatusQueued           = "queued"
	StatusRunning          = "running"
	StatusWaitingApproval  = "waiting_approval"
	StatusSucceeded        = "succeeded"
	StatusFailed           = "failed"
	StatusCanceled         = "canceled"
)

// DefaultMaxConcurrent is the FIFO concurrency limit (spec §5).
const DefaultMaxConcurrent = 4

// CreateRequest is the body for POST /api/tasks.
type CreateRequest struct {
	Agent  string  `json:"agent"`
	Cwd    string  `json:"cwd"`
	Prompt string  `json:"prompt"`
	Model  *string `json:"model,omitempty"`
	Title  *string `json:"title,omitempty"`
}

// Engine owns task lifecycle. Status transitions only happen here (spec §3).
type Engine struct {
	store    *store.Store
	adapters map[string]adapter.Adapter
	bus      *Bus

	mu            sync.Mutex
	maxConcurrent int
	active        int
	queue         []string // FIFO of task IDs waiting to run
	handles       map[string]adapter.RunHandle
	canceled      map[string]bool
	ctx           context.Context
	cancel        context.CancelFunc
	entropy       ioReader

	// Approval long-poll waiters (approval id → channels).
	approvalWaiters map[string][]chan store.Approval
	// clock and approvalTTL are injectable for tests.
	clock       func() time.Time
	approvalTTL time.Duration
}

// tiny interface so tests can inject ULID entropy if needed.
type ioReader interface {
	Read([]byte) (int, error)
}

// NewEngine wires the engine. Call Recover() once after construction.
func NewEngine(st *store.Store, adapters map[string]adapter.Adapter, bus *Bus, maxConcurrent int) *Engine {
	if maxConcurrent <= 0 {
		maxConcurrent = DefaultMaxConcurrent
	}
	if bus == nil {
		bus = NewBus()
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Engine{
		store:           st,
		adapters:        adapters,
		bus:             bus,
		maxConcurrent:   maxConcurrent,
		handles:         make(map[string]adapter.RunHandle),
		canceled:        make(map[string]bool),
		ctx:             ctx,
		cancel:          cancel,
		entropy:         rand.Reader,
		approvalWaiters: make(map[string][]chan store.Approval),
		approvalTTL:     store.DefaultApprovalTTL,
	}
}

// SetClock injects a clock for tests (approval expiry).
func (e *Engine) SetClock(fn func() time.Time) { e.clock = fn }

// SetApprovalTTL overrides the 1h default (tests).
func (e *Engine) SetApprovalTTL(d time.Duration) { e.approvalTTL = d }

// Bus returns the WebSocket bus.
func (e *Engine) Bus() *Bus { return e.bus }

// Close stops accepting new work (running tasks keep their process ctx).
func (e *Engine) Close() {
	e.cancel()
}

// Recover fails any queued/running rows left from a previous daemon process.
func (e *Engine) Recover(ctx context.Context) error {
	ids, err := e.store.FailOrphaned(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		payload, _ := json.Marshal(map[string]string{"message": "daemon restarted"})
		ev, err := e.store.AppendEvent(ctx, id, "error", payload)
		if err != nil {
			return err
		}
		e.bus.PublishEvent(ev)
		if t, err := e.store.GetTask(ctx, id); err == nil {
			e.bus.PublishTask(t)
		}
	}
	return nil
}

// Create enqueues a new task and starts it if under the concurrency limit.
func (e *Engine) Create(ctx context.Context, req CreateRequest) (store.Task, error) {
	if req.Agent == "" {
		return store.Task{}, fmt.Errorf("agent is required")
	}
	if req.Cwd == "" {
		return store.Task{}, fmt.Errorf("cwd is required")
	}
	if req.Prompt == "" {
		return store.Task{}, fmt.Errorf("prompt is required")
	}
	if _, ok := e.adapters[req.Agent]; !ok {
		return store.Task{}, fmt.Errorf("unknown agent %q", req.Agent)
	}

	id, err := e.newID()
	if err != nil {
		return store.Task{}, err
	}
	title := ""
	if req.Title != nil && *req.Title != "" {
		title = *req.Title
	} else {
		title = req.Prompt
		if len(title) > 80 {
			title = title[:80]
		}
	}

	now := e.nowMilli()
	t := store.Task{
		ID:        id,
		Title:     title,
		Agent:     req.Agent,
		Cwd:       req.Cwd,
		Prompt:    req.Prompt,
		Model:     req.Model,
		Status:    StatusQueued,
		CreatedAt: now,
	}
	if err := e.store.InsertTask(ctx, t); err != nil {
		return store.Task{}, err
	}
	e.bus.PublishTask(t)

	e.mu.Lock()
	e.queue = append(e.queue, id)
	e.mu.Unlock()
	e.pump()

	// Re-read in case pump already advanced status.
	return e.store.GetTask(ctx, id)
}

// Cancel requests cancellation. Queued → canceled; running/waiting_approval → SIGTERM/SIGKILL.
func (e *Engine) Cancel(ctx context.Context, id string) (store.Task, error) {
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	switch t.Status {
	case StatusSucceeded, StatusFailed, StatusCanceled:
		return t, fmt.Errorf("task already terminal (%s)", t.Status)
	}

	// Deny any pending approvals so MCP waiters unblock.
	if pending, err := e.store.ListPendingForTask(ctx, id); err == nil {
		for _, a := range pending {
			_, _ = e.Decide(ctx, a.ID, store.DecisionDenied, "web")
		}
	}

	e.mu.Lock()
	// Remove from queue if present.
	for i, qid := range e.queue {
		if qid == id {
			e.queue = append(e.queue[:i], e.queue[i+1:]...)
			e.mu.Unlock()
			return e.finish(ctx, id, StatusCanceled, nil, nil)
		}
	}
	h := e.handles[id]
	e.canceled[id] = true
	e.mu.Unlock()

	if h != nil {
		_ = h.Cancel()
		// Status becomes canceled when the run loop observes channel close,
		// or immediately if we prefer snappy UI — do both: mark canceled now
		// and let run loop no-op if already terminal.
		now := e.nowMilli()
		status := StatusCanceled
		if err := e.store.UpdateTask(ctx, id, store.TaskPatch{
			Status:     &status,
			FinishedAt: &now,
		}); err != nil {
			return store.Task{}, err
		}
		t, err = e.store.GetTask(ctx, id)
		if err != nil {
			return store.Task{}, err
		}
		e.bus.PublishTask(t)
		return t, nil
	}

	// Not queued and no handle — treat as cancel of queued race.
	return e.finish(ctx, id, StatusCanceled, nil, nil)
}

// Get returns a task by id.
func (e *Engine) Get(ctx context.Context, id string) (store.Task, error) {
	return e.store.GetTask(ctx, id)
}

// List returns tasks with filters.
func (e *Engine) List(ctx context.Context, opts store.ListTasksOpts) ([]store.Task, error) {
	return e.store.ListTasks(ctx, opts)
}

// Events returns events for a task.
func (e *Engine) Events(ctx context.Context, id string, sinceSeq int) ([]store.Event, error) {
	if _, err := e.store.GetTask(ctx, id); err != nil {
		return nil, err
	}
	return e.store.ListEvents(ctx, id, sinceSeq)
}

// RecentCwds returns recent working directories for the UI.
func (e *Engine) RecentCwds(ctx context.Context, limit int) ([]string, error) {
	return e.store.RecentCwds(ctx, limit)
}

func (e *Engine) newID() (string, error) {
	ms := ulid.Timestamp(e.now())
	id, err := ulid.New(ms, e.entropy)
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

// pump starts queued tasks up to maxConcurrent.
// startOne runs in a goroutine so a slow Adapter.Start cannot block Create.
func (e *Engine) pump() {
	for {
		e.mu.Lock()
		if e.active >= e.maxConcurrent || len(e.queue) == 0 {
			e.mu.Unlock()
			return
		}
		id := e.queue[0]
		e.queue = e.queue[1:]
		e.active++
		e.mu.Unlock()

		go e.startOne(id)
	}
}

func (e *Engine) startOne(id string) {
	ctx := e.ctx
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}
	// May have been canceled while queued.
	if t.Status != StatusQueued {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}

	ad, ok := e.adapters[t.Agent]
	if !ok {
		_, _ = e.failStart(ctx, id, fmt.Sprintf("unknown agent %q", t.Agent))
		return
	}

	now := e.nowMilli()
	status := StatusRunning
	// On follow-up, keep original started_at if already set.
	patch := store.TaskPatch{Status: &status}
	if t.StartedAt == nil {
		patch.StartedAt = &now
	}
	if err := e.store.UpdateTask(ctx, id, patch); err != nil {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}
	t, _ = e.store.GetTask(ctx, id)
	e.bus.PublishTask(t)

	model := ""
	if t.Model != nil {
		model = *t.Model
	}
	sessionRef := ""
	if t.SessionRef != nil {
		sessionRef = *t.SessionRef
	}
	spec := adapter.TaskSpec{
		ID:         t.ID,
		Agent:      t.Agent,
		Cwd:        t.Cwd,
		Prompt:     t.Prompt,
		Model:      model,
		SessionRef: sessionRef,
	}

	h, err := ad.Start(ctx, spec)
	if err != nil {
		_, _ = e.failStart(ctx, id, err.Error())
		return
	}

	e.mu.Lock()
	e.handles[id] = h
	// If cancel raced, signal now.
	if e.canceled[id] {
		e.mu.Unlock()
		_ = h.Cancel()
	} else {
		e.mu.Unlock()
	}

	e.runLoop(id, h)
}

func (e *Engine) failStart(ctx context.Context, id, msg string) (store.Task, error) {
	payload, _ := json.Marshal(map[string]string{"message": msg})
	ev, err := e.store.AppendEvent(ctx, id, "error", payload)
	if err == nil {
		e.bus.PublishEvent(ev)
	}
	t, err := e.finish(ctx, id, StatusFailed, nil, nil)
	e.mu.Lock()
	e.active--
	delete(e.handles, id)
	e.mu.Unlock()
	e.pump()
	return t, err
}

func (e *Engine) runLoop(id string, h adapter.RunHandle) {
	ctx := context.Background()
	var sawResult bool
	var resultIsError bool

	for ev := range h.Events() {
		// Persist first, then broadcast (spec §3).
		stored, err := e.store.AppendEvent(ctx, id, ev.Type, ev.Payload)
		if err != nil {
			continue
		}
		e.bus.PublishEvent(stored)

		switch ev.Type {
		case "task_started":
			if sid := claudecode.ExtractSessionID(ev.Payload); sid != "" {
				_ = e.store.UpdateTask(ctx, id, store.TaskPatch{SessionRef: &sid})
				if t, err := e.store.GetTask(ctx, id); err == nil {
					e.bus.PublishTask(t)
				}
			}
		case "result":
			sawResult = true
			cost, tin, tout, isErr, ok := claudecode.ExtractUsage(ev.Payload)
			resultIsError = isErr
			if ok {
				// Accumulate tokens/cost across follow-ups (spec §6 M2).
				cur, _ := e.store.GetTask(ctx, id)
				newIn := cur.TokensIn + tin
				newOut := cur.TokensOut + tout
				p := store.TaskPatch{TokensIn: &newIn, TokensOut: &newOut}
				if cost != nil {
					total := *cost
					if cur.CostUSD != nil {
						total = *cur.CostUSD + *cost
					}
					p.CostUSD = &total
				}
				_ = e.store.UpdateTask(ctx, id, p)
				if t, err := e.store.GetTask(ctx, id); err == nil {
					e.bus.PublishTask(t)
				}
			}
			if sid := claudecode.ExtractSessionID(ev.Payload); sid != "" {
				_ = e.store.UpdateTask(ctx, id, store.TaskPatch{SessionRef: &sid})
			}
		}
	}

	// Process exited.
	e.mu.Lock()
	wasCanceled := e.canceled[id]
	delete(e.handles, id)
	delete(e.canceled, id)
	e.active--
	e.mu.Unlock()

	// Re-read status: Cancel may have already set canceled.
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		e.pump()
		return
	}
	if t.Status == StatusCanceled || wasCanceled {
		if t.Status != StatusCanceled {
			_, _ = e.finish(ctx, id, StatusCanceled, nil, nil)
		} else if t.FinishedAt == nil {
			now := store.NowMilli()
			_ = e.store.UpdateTask(ctx, id, store.TaskPatch{FinishedAt: &now})
		}
		// Ensure broadcast of final state.
		if t2, err := e.store.GetTask(ctx, id); err == nil {
			e.bus.PublishTask(t2)
		}
		e.pump()
		return
	}

	final := StatusSucceeded
	if !sawResult || resultIsError {
		final = StatusFailed
		if !sawResult {
			payload, _ := json.Marshal(map[string]string{"message": "process exited without result"})
			if ev, err := e.store.AppendEvent(ctx, id, "error", payload); err == nil {
				e.bus.PublishEvent(ev)
			}
		}
	}
	// Exit code if available.
	var exitCode *int
	type exitCoder interface{ ExitCode() *int }
	if ec, ok := h.(exitCoder); ok {
		exitCode = ec.ExitCode()
	}
	_, _ = e.finish(ctx, id, final, exitCode, nil)
	e.pump()
}

func (e *Engine) finish(ctx context.Context, id, status string, exitCode *int, cost *float64) (store.Task, error) {
	now := e.nowMilli()
	p := store.TaskPatch{
		Status:     &status,
		FinishedAt: &now,
	}
	if exitCode != nil {
		p.ExitCode = exitCode
	}
	if cost != nil {
		p.CostUSD = cost
	}
	if err := e.store.UpdateTask(ctx, id, p); err != nil {
		return store.Task{}, err
	}
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	e.bus.PublishTask(t)
	return t, nil
}

// ErrTerminal is returned when canceling a finished task.
var ErrTerminal = errors.New("task already terminal")
