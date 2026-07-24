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
	"github.com/vuuihc/kin/internal/agent"
	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/workspace"
)

// Status values (spec §3 / §5).
const (
	StatusQueued          = "queued"
	StatusRunning         = "running"
	StatusWaitingApproval = "waiting_approval"
	StatusWaitingInput    = "waiting_input"
	StatusSucceeded       = "succeeded"
	StatusFailed          = "failed"
	StatusCanceled        = "canceled"
)

// DefaultMaxConcurrent is the FIFO concurrency limit (spec §5).
const DefaultMaxConcurrent = 4

// CreateRequest is the body for POST /api/tasks.
// Agent is optional: empty → engine picks default available agent.
type CreateRequest struct {
	Agent          string                  `json:"agent"`
	Cwd            string                  `json:"cwd"`
	Prompt         string                  `json:"prompt"`
	Model          *string                 `json:"model,omitempty"`
	Title          *string                 `json:"title,omitempty"`
	PermissionMode string                  `json:"permission_mode,omitempty"` // default | accept_edits | yolo
	WorkspaceMode  workspace.RequestedMode `json:"workspace_mode,omitempty"`  // auto | shared | worktree
	ProjectID      string                  `json:"project_id,omitempty"`      // optional project link (ADR 0008)
	// UserPrompt is the original user text shown in the chat timeline when Prompt
	// has been wrapped with project context. Empty → use Prompt.
	UserPrompt string `json:"-"`
}

// FollowUpRequest is the body for POST /api/tasks/{id}/prompt.
// Agent optional: when set to a different agent, hand off (clear session, inject context).
// Model optional: when set, updates the task model for this and subsequent turns
// (same-agent resume uses the new model on the next adapter Start).
type FollowUpRequest struct {
	Prompt string  `json:"prompt"`
	Agent  string  `json:"agent,omitempty"`
	Model  *string `json:"model,omitempty"`
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
	store     *store.Store
	agents    *agent.Registry
	bus       *Bus
	notify    Notifier
	titleFn   TitleResolver
	workspace WorkspaceRuntime

	// events is the narrow event persistence seam (nil → storeEventWriter).
	// Tests inject failures here without corrupting a real database.
	events eventWriter

	mu            sync.Mutex
	eventMu       sync.Mutex // serializes event append during parallel worker waves
	persistMu     sync.Mutex // disposable persist-gap bookkeeping
	maxConcurrent int
	active        int
	queue         []string // FIFO of task IDs waiting to run
	handles       map[string]adapter.RunHandle
	handleGroups  map[string][]adapter.RunHandle // parallel orchestration wave
	canceled      map[string]bool
	// pendingFollowUp is applied after an in-flight turn is interrupted (steer / insert prompt).
	pendingFollowUp map[string]pendingFollowUp
	// criticalPersistFail forces a non-success terminal state when a final
	// result, approval event, or user-visible message could not be stored.
	criticalPersistFail map[string]error
	// persistGaps tracks disposable drops so recovery can emit a diagnostic.
	persistGaps map[string]*persistGap
	ctx         context.Context
	cancel      context.CancelFunc
	entropy     ioReader

	// Approval long-poll waiters (approval id → channels).
	approvalWaiters     map[string][]chan store.Approval
	userQuestionWaiters map[string][]chan store.UserQuestion
	// clock and approvalTTL are injectable for tests.
	clock       func() time.Time
	approvalTTL time.Duration

	// defaultPreference optional; returns configured preferred agent id only.
	// Readiness/fallback is owned by the registry.
	defaultPreference agentDefaultPreference
}

// tiny interface so tests can inject ULID entropy if needed.
type ioReader interface {
	Read([]byte) (int, error)
}

// NewEngine wires the engine. Call Recover() once after construction.
func NewEngine(st *store.Store, agents *agent.Registry, bus *Bus, maxConcurrent int) *Engine {
	if maxConcurrent <= 0 {
		maxConcurrent = DefaultMaxConcurrent
	}
	if bus == nil {
		bus = NewBus()
	}
	if agents == nil {
		agents = agent.MustRegistry()
	}
	ctx, cancel := context.WithCancel(context.Background())
	var events eventWriter
	if st != nil {
		events = storeEventWriter{st: st}
	}
	return &Engine{
		store:               st,
		agents:              agents,
		bus:                 bus,
		events:              events,
		maxConcurrent:       maxConcurrent,
		handles:             make(map[string]adapter.RunHandle),
		canceled:            make(map[string]bool),
		pendingFollowUp:     make(map[string]pendingFollowUp),
		criticalPersistFail: make(map[string]error),
		persistGaps:         make(map[string]*persistGap),
		ctx:                 ctx,
		cancel:              cancel,
		entropy:             rand.Reader,
		approvalWaiters:     make(map[string][]chan store.Approval),
		userQuestionWaiters: make(map[string][]chan store.UserQuestion),
		approvalTTL:         store.DefaultApprovalTTL,
	}
}

// NewEngineFromAdapters is a test helper that wraps adapters as a registry.
func NewEngineFromAdapters(st *store.Store, adapters map[string]adapter.Adapter, bus *Bus, maxConcurrent int) *Engine {
	entries := make([]agent.Entry, 0, len(adapters))
	// Stable priority: kin first, then known CLIs, then others.
	prio := map[string]int{"kin": 10, "claude-code": 20, "codex": 30, "grok": 40, "rawpty": 90}
	for id, ad := range adapters {
		p := 50
		if v, ok := prio[id]; ok {
			p = v
		}
		name := id
		switch id {
		case "claude-code":
			name = "Claude Code"
		case "codex":
			name = "Codex"
		case "grok":
			name = "Grok"
		case "kin":
			name = "Kin"
		}
		caps := []agent.Capability{agent.CapabilityRun, agent.CapabilityResume}
		if id == "kin" {
			caps = append(caps, agent.CapabilityTools, agent.CapabilityOrchestrate)
		}
		entry := agent.Entry{
			ID: id, Name: name, Priority: p, Caps: caps, Runner: ad,
			// Controllers are optional in tests; orchestrate capability without
			// controller is only enforced by agent.Build, not NewRegistry for kin tests.
			// Use Status always-available for fake adapters.
			Status: func(context.Context) agent.Status {
				return agent.Status{Installed: true, Available: true}
			},
		}
		if id == "kin" && st != nil {
			entry.Sessions = agentSessionResetFunc(func(ctx context.Context, taskID string) error {
				return st.ClearKinMessages(ctx, taskID)
			})
			// Keep tools; orchestrate requires controller — omit for adapter-map helper.
			entry.Caps = []agent.Capability{agent.CapabilityRun, agent.CapabilityResume, agent.CapabilityTools}
		}
		entries = append(entries, entry)
	}
	return NewEngine(st, agent.MustRegistry(entries...), bus, maxConcurrent)
}

// putAdapter replaces or adds a runnable agent (tests).
func (e *Engine) putAdapter(id string, ad adapter.Adapter) {
	entries := make([]agent.Entry, 0, len(e.agents.IDs())+1)
	for _, existing := range e.agents.IDs() {
		if existing == id {
			continue
		}
		reg, _ := e.agents.Get(existing)
		entries = append(entries, agent.Entry{
			ID: existing, Name: reg.Descriptor.Name, Kind: reg.Descriptor.Kind,
			Priority: reg.Descriptor.Priority, Caps: reg.Descriptor.Capabilities,
			Runner: reg.Runner, Controller: reg.Controller, Sessions: reg.Sessions, Status: reg.Status,
		})
	}
	name := id
	prio := 50
	caps := []agent.Capability{agent.CapabilityRun, agent.CapabilityResume}
	if id == "kin" {
		name = "Kin"
		prio = 10
		caps = []agent.Capability{agent.CapabilityRun, agent.CapabilityResume, agent.CapabilityTools}
	}
	entry := agent.Entry{
		ID: id, Name: name, Priority: prio, Caps: caps, Runner: ad,
		Status: func(context.Context) agent.Status {
			return agent.Status{Installed: true, Available: true}
		},
	}
	if id == "kin" && e.store != nil {
		// Private transcript reset for handoff/interrupt/orchestration.
		st := e.store
		entry.Sessions = agentSessionResetFunc(func(ctx context.Context, taskID string) error {
			return st.ClearKinMessages(ctx, taskID)
		})
	}
	entries = append(entries, entry)
	e.agents = agent.MustRegistry(entries...)
}

type agentSessionResetFunc func(context.Context, string) error

func (f agentSessionResetFunc) Reset(ctx context.Context, taskID string) error { return f(ctx, taskID) }

// Agents returns the plugin registry.
func (e *Engine) Agents() *agent.Registry { return e.agents }

// DefaultPreference returns only the configured preferred agent id (e.g. agent.default).
// The registry decides readiness and fallback.
type DefaultPreference func(ctx context.Context) (string, error)

type agentDefaultPreference = DefaultPreference

// SetClock injects a clock for tests (approval expiry).
func (e *Engine) SetClock(fn func() time.Time) { e.clock = fn }

// SetApprovalTTL overrides the 1h default (tests).
func (e *Engine) SetApprovalTTL(d time.Duration) { e.approvalTTL = d }

// SetNotifier wires Bark/ntfy notifications (M3). Optional.
func (e *Engine) SetNotifier(n Notifier) { e.notify = n }

// WorkspaceRuntime prepares isolated task workspaces and (later) checkpoints.
// Optional: nil preserves shared cwd behavior for tests and headless paths.
type WorkspaceRuntime interface {
	Prepare(ctx context.Context, taskID, cwd string, requested workspace.RequestedMode) (workspace.Metadata, error)
	CleanupPrepared(ctx context.Context, taskID string, meta workspace.Metadata) error
	Capture(ctx context.Context, meta workspace.Metadata, taskID string, eventSeq int) (workspace.Checkpoint, error)
	Restore(ctx context.Context, meta workspace.Metadata, taskID string, cp workspace.Checkpoint) error
	PrepareFork(ctx context.Context, newTaskID string, source workspace.Metadata, cp workspace.Checkpoint) (workspace.Metadata, error)
}

// SetWorkspaceRuntime wires Git workspace isolation. Optional.
func (e *Engine) SetWorkspaceRuntime(runtime WorkspaceRuntime) { e.workspace = runtime }

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

// DefaultAgent returns the preferred ready agent id, or "".
// Preference comes from SetDefaultPreference; readiness/fallback from the registry.
func (e *Engine) DefaultAgent() string {
	return e.DefaultAgentContext(context.Background())
}

// DefaultAgentContext is the context-aware default selection.
func (e *Engine) DefaultAgentContext(ctx context.Context) string {
	configured := ""
	if e.defaultPreference != nil {
		if id, err := e.defaultPreference(ctx); err == nil {
			configured = strings.TrimSpace(id)
		}
	}
	return e.agents.Default(ctx, configured)
}

// SetDefaultPreference sets the configured preferred agent id resolver (serve setup).
func (e *Engine) SetDefaultPreference(fn DefaultPreference) {
	e.defaultPreference = fn
}

// SetDefaultAgentFn is a compatibility wrapper for tests/older callers.
// Prefer SetDefaultPreference.
func (e *Engine) SetDefaultAgentFn(fn func() string) {
	if fn == nil {
		e.defaultPreference = nil
		return
	}
	e.defaultPreference = func(context.Context) (string, error) { return fn(), nil }
}

// HasAgent reports whether an agent is registered (not necessarily ready).
func (e *Engine) HasAgent(id string) bool {
	return e.agents.Has(id)
}

// AgentIDs returns registered agent ids in registry order.
func (e *Engine) AgentIDs() []string {
	return e.agents.IDs()
}

// runnerFor returns the run adapter for id if registered.
func (e *Engine) runnerFor(id string) (adapter.Adapter, bool) {
	reg, ok := e.agents.Get(id)
	if !ok || reg.Runner == nil {
		return nil, false
	}
	return reg.Runner, true
}

// resetAgentSession clears plugin-private session state for id.
func (e *Engine) resetAgentSession(ctx context.Context, id, taskID string) {
	if err := e.agents.ResetSession(ctx, id, taskID); err != nil {
		payload, _ := json.Marshal(map[string]string{
			"message": fmt.Sprintf("session reset for %s failed: %v", id, err),
		})
		if ev, err := e.store.AppendEvent(ctx, taskID, "error", payload); err == nil {
			e.bus.PublishEvent(ev)
		}
	}
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
		req.Agent = e.DefaultAgentContext(ctx)
		if req.Agent == "" {
			return store.Task{}, fmt.Errorf("no agents available: install claude, codex, or grok CLI, or configure Kin provider")
		}
	}
	if _, err := e.agents.GetRunnable(ctx, req.Agent); err != nil {
		return store.Task{}, fmt.Errorf("unknown or unavailable agent %q (available: %v): %w", req.Agent, e.AgentIDs(), err)
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
		titleSrc := req.Prompt
		if strings.TrimSpace(req.UserPrompt) != "" {
			titleSrc = req.UserPrompt
		}
		title = TruncateTitle(titleSrc, TitleMaxRunes)
	}

	perm := adapter.NormalizePermissionMode(req.PermissionMode)

	now := e.nowMilli()
	projectID := strings.TrimSpace(req.ProjectID)
	if projectID == "" {
		if resolved, err := e.store.ResolveProjectIDForCwd(ctx, req.Cwd); err == nil && resolved != "" {
			projectID = resolved
		}
	}
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
		ProjectID:      projectID,
	}

	meta, err := e.prepareWorkspace(ctx, id, req.Cwd, req.WorkspaceMode)
	if err != nil {
		return store.Task{}, err
	}
	applyWorkspaceMetadata(&t, meta)

	if err := e.store.InsertTask(ctx, t); err != nil {
		e.cleanupPreparedWorkspace(id, meta)
		return store.Task{}, err
	}
	if t.ProjectID != "" {
		_ = e.store.TouchProjectActivity(ctx, t.ProjectID)
	}
	e.bus.PublishTask(t)

	// Seed chat timeline with the user's message (speaker = user).
	// Prefer UserPrompt so injected project context does not appear as user text.
	displayPrompt := req.Prompt
	if strings.TrimSpace(req.UserPrompt) != "" {
		displayPrompt = req.UserPrompt
	}
	userPayload, _ := json.Marshal(map[string]any{
		"role":    "user",
		"content": []map[string]string{{"type": "text", "text": displayPrompt}},
		"partial": false,
		"agent":   "user",
		"speaker": "user",
		"source":  "create",
	})
	ev, err := e.appendEventLocked(ctx, id, "message", userPayload)
	if err != nil {
		failed := StatusFailed
		_ = e.store.UpdateTask(ctx, id, store.TaskPatch{Status: &failed})
		return store.Task{}, fmt.Errorf("persist user message: %w", err)
	}
	e.captureCheckpoint(ctx, t, ev.Seq)

	// Async LLM title when the user did not supply one and a provider is available.
	if !explicitTitle {
		titleSrc := req.Prompt
		if strings.TrimSpace(req.UserPrompt) != "" {
			titleSrc = req.UserPrompt
		}
		e.maybeSummarizeTitle(id, titleSrc, title)
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

// planNeedsModel reports whether any delegate step still lacks a model, so the
// (provider-backed) NL directive resolution is only attempted when it can matter.
func planNeedsModel(plan DelegatePlan) bool {
	for _, s := range plan.Steps {
		if strings.TrimSpace(s.Model) == "" {
			return true
		}
	}
	return false
}

// resolveModelDirective extracts natural-language model intent from the live
// user turn using the cognition provider. Best-effort and gated: returns ok=false
// (no provider call) when unconfigured or the turn carries no model-ish hint.
func (e *Engine) resolveModelDirective(ctx context.Context, t store.Task) (ModelDirective, bool) {
	if e.titleFn == nil {
		return ModelDirective{}, false
	}
	turn := UserTurnPrompt(t.Prompt)
	if strings.TrimSpace(turn) == "" || !modelHintRE.MatchString(turn) {
		return ModelDirective{}, false
	}
	callCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	client, cfg, err := e.titleFn(callCtx)
	if err != nil || client == nil || !cfg.Configured() {
		return ModelDirective{}, false
	}
	return ExtractModelDirective(callCtx, client, cfg.Model, turn)
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
	// Resolve pending user questions the same way (ADR 0010).
	if pending, err := e.store.ListPendingUserQuestionsForTask(ctx, id); err == nil {
		for _, q := range pending {
			_, _ = e.AnswerUserQuestion(ctx, q.ID, AnswerUserQuestionRequest{}, "interrupt")
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

// Delete permanently removes a task and its history after canceling any
// in-flight work. Isolated worktrees are cleaned up when possible.
func (e *Engine) Delete(ctx context.Context, id string) error {
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return err
	}

	// Stop runners / dequeue so nothing rewrites the row while we delete.
	switch t.Status {
	case StatusSucceeded, StatusFailed, StatusCanceled:
		// already terminal
	default:
		if _, err := e.Cancel(ctx, id); err != nil {
			// Race: became terminal between Get and Cancel.
			if !errors.Is(err, ErrTerminal) && !strings.Contains(err.Error(), "already terminal") {
				return err
			}
		}
	}

	// Drop in-memory bookkeeping (run loop may also clear these).
	e.mu.Lock()
	for i, qid := range e.queue {
		if qid == id {
			e.queue = append(e.queue[:i], e.queue[i+1:]...)
			break
		}
	}
	delete(e.handles, id)
	delete(e.handleGroups, id)
	delete(e.canceled, id)
	delete(e.pendingFollowUp, id)
	e.mu.Unlock()

	e.resetAgentSession(ctx, t.Agent, id)

	meta := workspace.Metadata{
		Mode:       workspace.ResolvedMode(t.WorkspaceMode),
		SourceRoot: t.WorkspaceSourceRoot,
		Root:       t.WorkspaceRoot,
		Cwd:        t.ExecutionCwd,
		Scope:      t.WorkspaceScope,
		BaseOID:    t.WorkspaceBaseOID,
		Branch:     t.WorkspaceBranch,
	}
	e.cleanupPreparedWorkspace(id, meta)

	if err := e.store.DeleteTask(ctx, id); err != nil {
		return err
	}
	e.bus.PublishTaskDeleted(id)
	return nil
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
		// Natural-language model steering ("用 Codex 的 GPT-5.6 执行" /
		// "计划用聪明模型，执行用便宜模型") fills any worker without an explicit
		// @agent[model]. Gated + best-effort: no provider call unless a step
		// actually lacks a model and the turn mentions models/cost.
		if planNeedsModel(plan) {
			if d, ok := e.resolveModelDirective(ctx, t); ok {
				d.ApplyTo(&plan, BuiltinCatalog())
			}
		}
		e.runOrchestrated(id, t, plan)
		return
	}

	// Bare single-agent turn with NL "smart plan / cheap exec": expand into a
	// same-agent two-step plan (plan worker then exec worker) so models switch
	// without requiring explicit @mentions.
	if d, ok := e.resolveModelDirective(ctx, t); ok && d.WantsRoleSplit() {
		if split, ok := d.BuildRoleSplitPlan(t.Agent, UserTurnPrompt(t.Prompt), BuiltinCatalog()); ok {
			split.SessionContext = ExtractPriorContext(t.Prompt)
			e.runOrchestrated(id, t, split)
			return
		}
	}

	ad, ok := e.runnerFor(t.Agent)
	if !ok {
		_, _ = e.failStart(ctx, id, fmt.Sprintf("unknown agent %q", t.Agent))
		return
	}

	model := ""
	if t.Model != nil {
		model = *t.Model
	}
	// Bare task with no selected model: honor an NL model directive for the host.
	if model == "" {
		if d, ok := e.resolveModelDirective(ctx, t); ok {
			model = d.ForAgent(t.Agent, BuiltinCatalog())
		}
	}
	sessionRef := ""
	if t.SessionRef != nil {
		sessionRef = *t.SessionRef
	}
	execRef := adapter.ExecutionRef{
		Agent: t.Agent,
		Model: model,
	}
	eid, err := e.newID()
	if err != nil {
		_, _ = e.failStart(ctx, id, fmt.Sprintf("execution id: %v", err))
		return
	}
	execRef.ID = eid
	spec := adapter.TaskSpec{
		ID:             t.ID,
		Agent:          t.Agent,
		Cwd:            t.EffectiveCwd(),
		Prompt:         t.Prompt,
		Model:          model,
		SessionRef:     sessionRef,
		PermissionMode: adapter.NormalizePermissionMode(t.PermissionMode),
		Execution:      execRef,
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

	e.runLoop(id, h, t.Agent, model, execRef)
}

func (e *Engine) failStart(ctx context.Context, id, msg string) (store.Task, error) {
	payload, _ := json.Marshal(map[string]string{"message": msg})
	if w := e.eventWriter(); w != nil {
		ev, err := w.AppendEvent(ctx, id, "error", payload)
		if err == nil {
			e.bus.PublishEvent(ev)
		}
	}
	t, err := e.finish(ctx, id, StatusFailed, nil, nil)
	e.mu.Lock()
	e.active--
	delete(e.handles, id)
	e.mu.Unlock()
	e.pump()
	return t, err
}

func (e *Engine) runLoop(id string, h adapter.RunHandle, speaker, model string, exec adapter.ExecutionRef) {
	ctx := context.Background()
	var sawResult bool
	var sawUsage bool
	var resultIsError bool
	if speaker == "" {
		speaker = "assistant"
	}

	for ev := range h.Events() {
		// Persist first, then broadcast (spec §3). Stamp speaker for chat UI.
		payload := stampSpeaker(ev.Payload, speaker, model, exec)
		var (
			stored            store.Event
			updatedTask       *store.Task
			missingPriceModel string
			accountingFailed  bool
		)
		// Canonical usage events are incremental. A result is only an accounting
		// fallback for legacy adapters that emitted no usage event in this run.
		shouldAccount := ev.Type == "usage" || (ev.Type == "result" && !sawUsage)
		w := e.eventWriter()
		if shouldAccount {
			record, usageErr := NormalizeUsage(speaker, model, payload)
			if usageErr == nil {
				missingPriceModel = e.populateEstimatedUsageCost(ctx, &record)
				if w == nil {
					accountingFailed = true
					e.notePersistFailure(id, ev.Type, payload, fmt.Errorf("event writer unavailable"))
				} else {
					usageEvent, taskAfterUsage, appendErr := w.AppendUsageEvent(ctx, id, ev.Type, payload, record)
					if appendErr != nil {
						accountingFailed = true
						e.notePersistFailure(id, ev.Type, payload, appendErr)
					} else {
						stored = usageEvent
						updatedTask = &taskAfterUsage
						if ev.Type == "usage" {
							sawUsage = true
						}
					}
				}
			}
		}
		if accountingFailed {
			continue
		}
		if stored.TaskID == "" {
			if w == nil {
				e.notePersistFailure(id, ev.Type, payload, fmt.Errorf("event writer unavailable"))
				continue
			}
			var err error
			stored, err = w.AppendEvent(ctx, id, ev.Type, payload)
			if err != nil {
				e.notePersistFailure(id, ev.Type, payload, err)
				continue
			}
		}
		e.bus.PublishEvent(stored)
		e.maybeEmitPersistDiagnostic(ctx, id)
		if updatedTask != nil {
			e.bus.PublishTask(*updatedTask)
		}
		if missingPriceModel != "" {
			note, _ := json.Marshal(map[string]string{
				"line": fmt.Sprintf("price_table has no entry for model %q; cost_usd left null", missingPriceModel),
			})
			if w != nil {
				if diagnostic, err := w.AppendEvent(ctx, id, "raw_output", note); err == nil {
					e.bus.PublishEvent(diagnostic)
				}
			}
		}

		switch ev.Type {
		case "task_started":
			if sid := adapter.SessionRefFromEvent(ev.Payload); sid != "" {
				_ = e.store.UpdateTask(ctx, id, store.TaskPatch{SessionRef: &sid})
				if t, err := e.store.GetTask(ctx, id); err == nil {
					e.bus.PublishTask(t)
				}
			}
		case "result":
			sawResult = true
			if parsed, ok := adapter.ParseResult(ev.Payload); ok {
				resultIsError = parsed.IsError
				if parsed.SessionRef != "" {
					sid := parsed.SessionRef
					_ = e.store.UpdateTask(ctx, id, store.TaskPatch{SessionRef: &sid})
				}
			} else {
				var resultMeta struct {
					IsError bool `json:"is_error"`
				}
				_ = json.Unmarshal(ev.Payload, &resultMeta)
				resultIsError = resultMeta.IsError
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
	if !sawResult || resultIsError || e.hasCriticalPersistFailure(id) {
		final = StatusFailed
		if !sawResult && !e.hasCriticalPersistFailure(id) {
			payload, _ := json.Marshal(map[string]string{"message": "process exited without result"})
			if w := e.eventWriter(); w != nil {
				if ev, err := w.AppendEvent(ctx, id, "error", payload); err == nil {
					e.bus.PublishEvent(ev)
				} else {
					e.notePersistFailure(id, "error", payload, err)
				}
			}
		} else if e.hasCriticalPersistFailure(id) && !sawResult {
			// Result was lost at the store; surface an explicit error event if possible.
			payload, _ := json.Marshal(map[string]string{"message": "failed to persist critical task event"})
			if w := e.eventWriter(); w != nil {
				if ev, err := w.AppendEvent(ctx, id, "error", payload); err == nil {
					e.bus.PublishEvent(ev)
				}
			}
		}
	}
	// Exit code if available.
	var exitCode *int
	type exitCoder interface{ ExitCode() *int }
	if ec, ok := h.(exitCoder); ok {
		exitCode = ec.ExitCode()
	}
	e.clearPersistTracking(id)
	_, _ = e.finish(ctx, id, final, exitCode, nil)
	e.pump()
}

func (e *Engine) populateEstimatedUsageCost(ctx context.Context, record *store.UsageRecord) string {
	if record == nil || record.CostUSD != nil {
		return ""
	}
	input := 0
	if record.InputTokens != nil {
		input = *record.InputTokens
	}
	output := 0
	if record.OutputTokens != nil {
		output = *record.OutputTokens
	}
	if input == 0 && output == 0 {
		return ""
	}
	model := ""
	if record.Model != nil {
		model = strings.TrimSpace(*record.Model)
	}
	// Adapters that report tokens without a model (or tasks with no model pin)
	// still get a price-table estimate when we know a stable agent default.
	if model == "" {
		model = defaultPriceModelForAgent(record.Agent)
		if model != "" {
			m := model
			record.Model = &m
		}
	}
	if model == "" {
		return ""
	}
	if cost, found := e.store.LoadPriceTable(ctx).ComputeCost(model, input, output); found {
		record.CostUSD = &cost
		record.CostSource = store.CostSourcePriceTable
		return ""
	}
	return model
}

// defaultPriceModelForAgent is a last-resort model name for price-table cost
// estimates when neither the usage event nor the host task pinned a model.
// Only agents with a documented CLI default are listed here.
func defaultPriceModelForAgent(agent string) string {
	switch strings.TrimSpace(agent) {
	case "codex":
		// Matches internal/adapter/codex.DefaultModel (avoid importing adapter).
		return "gpt-5-codex"
	default:
		return ""
	}
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

func (e *Engine) prepareWorkspace(ctx context.Context, taskID, cwd string, mode workspace.RequestedMode) (workspace.Metadata, error) {
	if mode == "" {
		mode = workspace.ModeAuto
	}
	if e.workspace == nil {
		return workspace.Metadata{
			Mode:  workspace.ResolvedShared,
			Root:  cwd,
			Cwd:   cwd,
			Scope: ".",
		}, nil
	}
	return e.workspace.Prepare(ctx, taskID, cwd, mode)
}

func workspaceMetadata(t store.Task) workspace.Metadata {
	return workspace.Metadata{
		Mode:       workspace.ResolvedMode(t.WorkspaceMode),
		SourceRoot: t.WorkspaceSourceRoot,
		Root:       t.WorkspaceRoot,
		Cwd:        t.ExecutionCwd,
		Scope:      t.WorkspaceScope,
		BaseOID:    t.WorkspaceBaseOID,
		Branch:     t.WorkspaceBranch,
	}
}

func storeCheckpoint(cp workspace.Checkpoint) store.TaskCheckpoint {
	return store.TaskCheckpoint{
		TaskID:    cp.TaskID,
		EventSeq:  cp.EventSeq,
		HeadOID:   cp.HeadOID,
		TreeOID:   cp.TreeOID,
		SizeBytes: cp.SizeBytes,
		CreatedAt: cp.CreatedAt,
	}
}

func runtimeCheckpoint(cp store.TaskCheckpoint) workspace.Checkpoint {
	return workspace.Checkpoint{
		TaskID:    cp.TaskID,
		EventSeq:  cp.EventSeq,
		HeadOID:   cp.HeadOID,
		TreeOID:   cp.TreeOID,
		SizeBytes: cp.SizeBytes,
		CreatedAt: cp.CreatedAt,
	}
}

func (e *Engine) captureCheckpoint(ctx context.Context, t store.Task, userSeq int) {
	if e.workspace == nil || t.WorkspaceMode != string(workspace.ResolvedWorktree) || userSeq < 1 {
		return
	}
	cp, err := e.workspace.Capture(ctx, workspaceMetadata(t), t.ID, userSeq)
	if err == nil {
		if putErr := e.store.PutCheckpoint(ctx, storeCheckpoint(cp)); putErr != nil {
			err = putErr
		}
	}
	if err == nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"event_seq": userSeq,
		"reason":    checkpointSkipReason(err),
	})
	if ev, appendErr := e.store.AppendEvent(ctx, t.ID, "checkpoint_skipped", payload); appendErr == nil {
		e.bus.PublishEvent(ev)
	}
}

func checkpointSkipReason(err error) string {
	switch {
	case errors.Is(err, workspace.ErrSnapshotTooLarge):
		return "too_large"
	case errors.Is(err, workspace.ErrCheckpointUnavailable),
		errors.Is(err, workspace.ErrNotIsolated),
		errors.Is(err, workspace.ErrGitUnavailable):
		return "unavailable"
	default:
		return "git_error"
	}
}

func (e *Engine) cleanupPreparedWorkspace(taskID string, meta workspace.Metadata) {
	if e.workspace == nil || meta.Mode != workspace.ResolvedWorktree {
		return
	}
	cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = e.workspace.CleanupPrepared(cctx, taskID, meta)
}

func applyWorkspaceMetadata(t *store.Task, meta workspace.Metadata) {
	if t == nil {
		return
	}
	t.WorkspaceMode = string(meta.Mode)
	if t.WorkspaceMode == "" {
		t.WorkspaceMode = string(workspace.ResolvedShared)
	}
	t.WorkspaceSourceRoot = meta.SourceRoot
	t.WorkspaceRoot = meta.Root
	t.ExecutionCwd = meta.Cwd
	t.WorkspaceScope = meta.Scope
	if t.WorkspaceScope == "" {
		t.WorkspaceScope = "."
	}
	t.WorkspaceBaseOID = meta.BaseOID
	t.WorkspaceBranch = meta.Branch
}
