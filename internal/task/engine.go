// Package task implements the task engine: state machine, queue, event log (spec §5).
package task

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/adapter/claudecode"
	"github.com/vuuihc/kin/internal/adapter/codex"
	"github.com/vuuihc/kin/internal/adapter/grok"
	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/store"
)

// Status values (spec §3 / §5).
const (
	StatusQueued          = "queued"
	StatusRunning         = "running"
	StatusWaitingApproval = "waiting_approval"
	StatusSucceeded       = "succeeded"
	StatusFailed          = "failed"
	StatusCanceled        = "canceled"
)

// DefaultMaxConcurrent is the FIFO concurrency limit (spec §5).
const DefaultMaxConcurrent = 4

// CreateRequest is the body for POST /api/tasks.
// Agent is optional: empty → engine picks default available agent.
type CreateRequest struct {
	Agent          string  `json:"agent"`
	Cwd            string  `json:"cwd"`
	Prompt         string  `json:"prompt"`
	Model          *string `json:"model,omitempty"`
	Title          *string `json:"title,omitempty"`
	PermissionMode string  `json:"permission_mode,omitempty"` // default | accept_edits | yolo
}

// FollowUpRequest is the body for POST /api/tasks/{id}/prompt.
// Agent optional: when set to a different agent, hand off (clear session, inject context).
type FollowUpRequest struct {
	Prompt string `json:"prompt"`
	Agent  string `json:"agent,omitempty"`
}

// Notifier is optional fire-and-forget push for approvals / task finish (M3).
type Notifier interface {
	NotifyApproval(ctx context.Context, approvalID, taskID, title string)
	NotifyTaskTerminal(ctx context.Context, taskID, taskTitle, status string)
}

// TitleResolver optionally loads the cognition provider for async session naming.
// When unset or not configured, titles stay as the prompt truncation fallback.
type TitleResolver func(ctx context.Context) (provider.Client, provider.Config, error)

// Engine owns task lifecycle. Status transitions only happen here (spec §3).
type Engine struct {
	store    *store.Store
	adapters map[string]adapter.Adapter
	bus      *Bus
	notify   Notifier
	titleFn  TitleResolver

	mu            sync.Mutex
	eventMu       sync.Mutex // serializes event append during parallel worker waves
	maxConcurrent int
	active        int
	queue         []string // FIFO of task IDs waiting to run
	handles       map[string]adapter.RunHandle
	handleGroups  map[string][]adapter.RunHandle // parallel orchestration wave
	canceled      map[string]bool
	// pendingFollowUp is applied after an in-flight turn is interrupted (steer / insert prompt).
	pendingFollowUp map[string]pendingFollowUp
	ctx             context.Context
	cancel          context.CancelFunc
	entropy         ioReader

	// Approval long-poll waiters (approval id → channels).
	approvalWaiters map[string][]chan store.Approval
	// clock and approvalTTL are injectable for tests.
	clock       func() time.Time
	approvalTTL time.Duration

	// defaultAgentFn optional; when set, used by DefaultAgent() first.
	defaultAgentFn func() string
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
		pendingFollowUp: make(map[string]pendingFollowUp),
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

// SetNotifier wires Bark/ntfy notifications (M3). Optional.
func (e *Engine) SetNotifier(n Notifier) { e.notify = n }

// SetTitleResolver wires provider-backed session title summarization. Optional.
func (e *Engine) SetTitleResolver(fn TitleResolver) { e.titleFn = fn }

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

// DefaultAgent returns the preferred registered agent id, or "".
// Preference: SetDefaultAgentFn (server: kin when provider ready) → coding CLIs → kin last.
func (e *Engine) DefaultAgent() string {
	if e.defaultAgentFn != nil {
		if id := e.defaultAgentFn(); id != "" {
			if _, ok := e.adapters[id]; ok {
				return id
			}
		}
	}
	for _, id := range []string{"claude-code", "codex", "grok"} {
		if _, ok := e.adapters[id]; ok {
			return id
		}
	}
	if _, ok := e.adapters["kin"]; ok {
		return "kin"
	}
	for id := range e.adapters {
		return id
	}
	return ""
}

// SetDefaultAgentFn sets the dynamic default resolver (serve setup).
func (e *Engine) SetDefaultAgentFn(fn func() string) {
	e.defaultAgentFn = fn
}

// HasAgent reports whether an adapter is registered.
func (e *Engine) HasAgent(id string) bool {
	_, ok := e.adapters[id]
	return ok
}

// AgentIDs returns registered adapter ids (sorted).
func (e *Engine) AgentIDs() []string {
	ids := make([]string, 0, len(e.adapters))
	for id := range e.adapters {
		ids = append(ids, id)
	}
	// stable-ish: prefer known order
	pref := []string{"kin", "claude-code", "codex", "grok", "rawpty"}
	var out []string
	seen := map[string]bool{}
	for _, p := range pref {
		if _, ok := e.adapters[p]; ok {
			out = append(out, p)
			seen[p] = true
		}
	}
	for _, id := range ids {
		if !seen[id] {
			out = append(out, id)
		}
	}
	return out
}

// Create enqueues a new task and starts it if under the concurrency limit.
func (e *Engine) Create(ctx context.Context, req CreateRequest) (store.Task, error) {
	if req.Cwd == "" {
		return store.Task{}, fmt.Errorf("cwd is required")
	}
	if req.Prompt == "" {
		return store.Task{}, fmt.Errorf("prompt is required")
	}
	if req.Agent == "" {
		req.Agent = e.DefaultAgent()
		if req.Agent == "" {
			return store.Task{}, fmt.Errorf("no agents available: install claude, codex, or grok CLI")
		}
	}
	if _, ok := e.adapters[req.Agent]; !ok {
		return store.Task{}, fmt.Errorf("unknown or unavailable agent %q (available: %v)", req.Agent, e.AgentIDs())
	}

	id, err := e.newID()
	if err != nil {
		return store.Task{}, err
	}
	explicitTitle := req.Title != nil && strings.TrimSpace(*req.Title) != ""
	title := ""
	if explicitTitle {
		title = TruncateTitle(*req.Title, TitleMaxRunes)
	} else {
		// Immediate fallback so the sidebar has something; may be replaced async.
		title = TruncateTitle(req.Prompt, TitleMaxRunes)
	}

	perm := adapter.NormalizePermissionMode(req.PermissionMode)

	now := e.nowMilli()
	t := store.Task{
		ID:             id,
		Title:          title,
		Agent:          req.Agent,
		Cwd:            req.Cwd,
		Prompt:         req.Prompt,
		Model:          req.Model,
		PermissionMode: perm,
		Status:         StatusQueued,
		CreatedAt:      now,
	}
	if err := e.store.InsertTask(ctx, t); err != nil {
		return store.Task{}, err
	}
	e.bus.PublishTask(t)

	// Seed chat timeline with the user's message (speaker = user).
	userPayload, _ := json.Marshal(map[string]any{
		"role":    "user",
		"content": []map[string]string{{"type": "text", "text": req.Prompt}},
		"partial": false,
		"agent":   "user",
		"speaker": "user",
		"source":  "create",
	})
	if ev, err := e.store.AppendEvent(ctx, id, "message", userPayload); err == nil {
		e.bus.PublishEvent(ev)
	}

	// Async LLM title when the user did not supply one and a provider is available.
	if !explicitTitle {
		e.maybeSummarizeTitle(id, req.Prompt, title)
	}

	e.mu.Lock()
	e.queue = append(e.queue, id)
	e.mu.Unlock()
	e.pump()

	// Re-read in case pump already advanced status / title.
	return e.store.GetTask(ctx, id)
}

// maybeSummarizeTitle fires a best-effort provider call to replace the fallback title.
// Never blocks Create; failures leave the truncation fallback in place.
func (e *Engine) maybeSummarizeTitle(taskID, prompt, fallback string) {
	if e.titleFn == nil {
		return
	}
	// Skip very short prompts — truncation already is the title.
	if len([]rune(strings.TrimSpace(prompt))) <= 12 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(e.ctx, 12*time.Second)
		defer cancel()
		client, cfg, err := e.titleFn(ctx)
		if err != nil || client == nil || !cfg.Configured() {
			return
		}
		title, err := SummarizeTitle(ctx, client, cfg.Model, prompt)
		if err != nil || title == "" || title == fallback {
			return
		}
		if err := e.store.UpdateTask(ctx, taskID, store.TaskPatch{Title: &title}); err != nil {
			return
		}
		if t, err := e.store.GetTask(ctx, taskID); err == nil {
			e.bus.PublishTask(t)
		}
	}()
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
	group := e.handleGroups[id]
	e.canceled[id] = true
	delete(e.pendingFollowUp, id) // pure cancel must not re-queue a steerable follow-up
	e.mu.Unlock()

	if h != nil || len(group) > 0 {
		if h != nil {
			_ = h.Cancel()
		}
		for _, gh := range group {
			_ = gh.Cancel()
		}
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

	// Multi-@ keeps the selected session host; mentioned agents run as workers.
	if plan, ok := e.shouldOrchestrate(t); ok {
		e.runOrchestrated(id, t, plan)
		return
	}

	ad, ok := e.adapters[t.Agent]
	if !ok {
		_, _ = e.failStart(ctx, id, fmt.Sprintf("unknown agent %q", t.Agent))
		return
	}

	model := ""
	if t.Model != nil {
		model = *t.Model
	}
	sessionRef := ""
	if t.SessionRef != nil {
		sessionRef = *t.SessionRef
	}
	spec := adapter.TaskSpec{
		ID:             t.ID,
		Agent:          t.Agent,
		Cwd:            t.Cwd,
		Prompt:         t.Prompt,
		Model:          model,
		SessionRef:     sessionRef,
		PermissionMode: adapter.NormalizePermissionMode(t.PermissionMode),
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

	e.runLoop(id, h, t.Agent, model)
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

func (e *Engine) runLoop(id string, h adapter.RunHandle, speaker, model string) {
	ctx := context.Background()
	var sawResult bool
	var resultIsError bool
	if speaker == "" {
		speaker = "assistant"
	}

	for ev := range h.Events() {
		// Persist first, then broadcast (spec §3). Stamp speaker for chat UI.
		payload := stampSpeaker(ev.Payload, speaker, model)
		stored, err := e.store.AppendEvent(ctx, id, ev.Type, payload)
		if err != nil {
			continue
		}
		e.bus.PublishEvent(stored)

		switch ev.Type {
		case "task_started":
			sid := claudecode.ExtractSessionID(ev.Payload)
			if sid == "" {
				sid = codex.ExtractSessionID(ev.Payload)
			}
			if sid == "" {
				sid = grok.ExtractSessionID(ev.Payload)
			}
			if sid != "" {
				_ = e.store.UpdateTask(ctx, id, store.TaskPatch{SessionRef: &sid})
				if t, err := e.store.GetTask(ctx, id); err == nil {
					e.bus.PublishTask(t)
				}
			}
		case "result":
			sawResult = true
			cost, tin, tout, isErr, ok := claudecode.ExtractUsage(ev.Payload)
			if !ok {
				// Grok / other adapters.
				var gTin, gTout int
				var gErr, gOK bool
				cost, gTin, gTout, gErr, gOK = grok.ExtractUsage(ev.Payload)
				if gOK {
					tin, tout, isErr, ok = gTin, gTout, gErr, true
				}
			}
			// Capture grok session id from result if not already set.
			if sid := grok.ExtractSessionID(ev.Payload); sid != "" {
				_ = e.store.UpdateTask(ctx, id, store.TaskPatch{SessionRef: &sid})
			}
			resultIsError = isErr
			if ok {
				// Accumulate tokens/cost across follow-ups (spec §6 M2).
				cur, _ := e.store.GetTask(ctx, id)
				newIn := cur.TokensIn + tin
				newOut := cur.TokensOut + tout
				p := store.TaskPatch{TokensIn: &newIn, TokensOut: &newOut}

				// Claude: cost from result total_cost_usd (do not change that path).
				// Codex: cost not in CLI output — compute from price_table at result time.
				if cost == nil && cur.Agent == "codex" && (tin > 0 || tout > 0) {
					model := codex.DefaultModel
					if cur.Model != nil && *cur.Model != "" {
						model = *cur.Model
					}
					table := e.store.LoadPriceTable(ctx)
					if c, found := table.ComputeCost(model, tin, tout); found {
						cost = &c
					} else {
						note, _ := json.Marshal(map[string]string{
							"line": fmt.Sprintf("price_table has no entry for model %q; cost_usd left null", model),
						})
						if nev, err := e.store.AppendEvent(ctx, id, "raw_output", note); err == nil {
							e.bus.PublishEvent(nev)
						}
					}
				}

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
			sid := claudecode.ExtractSessionID(ev.Payload)
			if sid == "" {
				sid = codex.ExtractSessionID(ev.Payload)
			}
			if sid != "" {
				_ = e.store.UpdateTask(ctx, id, store.TaskPatch{SessionRef: &sid})
			}
		}
	}

	// Process exited.
	e.mu.Lock()
	wasCanceled := e.canceled[id]
	pf, hasFollowUp := e.pendingFollowUp[id]
	delete(e.handles, id)
	delete(e.canceled, id)
	delete(e.pendingFollowUp, id)
	e.active--
	e.mu.Unlock()

	// Interrupted with a steerable follow-up: re-queue instead of staying canceled.
	if hasFollowUp {
		if _, err := e.applyPendingFollowUp(ctx, id, pf); err != nil {
			payload, _ := json.Marshal(map[string]string{"message": "follow-up after interrupt failed: " + err.Error()})
			if ev, err := e.store.AppendEvent(ctx, id, "error", payload); err == nil {
				e.bus.PublishEvent(ev)
			}
			_, _ = e.finish(ctx, id, StatusFailed, nil, nil)
		}
		e.pump()
		return
	}

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
	// Terminal statuses: succeeded | failed | canceled (spec §8).
	if e.notify != nil && (status == StatusSucceeded || status == StatusFailed || status == StatusCanceled) {
		e.notify.NotifyTaskTerminal(ctx, t.ID, t.Title, status)
	}
	return t, nil
}

// ErrTerminal is returned when canceling a finished task.
var ErrTerminal = errors.New("task already terminal")
