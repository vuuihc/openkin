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

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/routing"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
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
	StatusRetrying        = "retrying"
)

var ErrEngineNotStarted = errors.New("task engine has not completed startup")

// DefaultMaxConcurrent is the FIFO concurrency limit (spec §5) applied when
// the task.max_concurrent setting is unset or invalid. It bounds concurrent
// top-level tasks (not sub-agent fan-out within a single orchestrated task).
const DefaultMaxConcurrent = 16

// CreateRequest is the body for POST /api/tasks.
// Agent is optional: empty → engine picks default available agent.
type CreateRequest struct {
	// ID is reserved for durable schedulers that need crash-safe idempotency.
	// Normal callers leave it empty and the engine generates a ULID.
	ID             string                  `json:"-"`
	Agent          string                  `json:"agent"`
	Cwd            string                  `json:"cwd"`
	Prompt         string                  `json:"prompt"`
	Model          *string                 `json:"model,omitempty"`
	Title          *string                 `json:"title,omitempty"`
	PermissionMode string                  `json:"permission_mode,omitempty"` // default | accept_edits | yolo
	WorkspaceMode  workspace.RequestedMode `json:"workspace_mode,omitempty"`  // auto | shared | worktree
	ProjectID      string                  `json:"project_id,omitempty"`      // optional project link (ADR 0008)
	// RoutineID tags the task as a routine run (ADR 0011). Empty = interactive.
	RoutineID string `json:"routine_id,omitempty"`
	// UserPrompt is the original user text shown in the chat timeline when Prompt
	// has been wrapped with project context. Empty → use Prompt.
	UserPrompt string `json:"-"`
	// Dispatch is the optional dispatch selection for auto model routing.
	Dispatch json.RawMessage `json:"dispatch,omitempty"`
}

// FollowUpRequest is the body for POST /api/tasks/{id}/prompt.
// Agent optional: when set to a different agent, hand off (clear session, inject context).
// Model optional: when set, updates the task model for this and subsequent turns
// (same-agent resume uses the new model on the next adapter Start).
// PermissionMode optional: when set, updates the task permission mode for this and
// subsequent turns. Unlike a model switch it does not reset session continuity.
type FollowUpRequest struct {
	Prompt         string  `json:"prompt"`
	Agent          string  `json:"agent,omitempty"`
	Model          *string `json:"model,omitempty"`
	PermissionMode *string `json:"permission_mode,omitempty"`
}

// Notifier is optional fire-and-forget push for approvals / task finish (M3).
type Notifier interface {
	NotifyApproval(ctx context.Context, approvalID, taskID, title string)
	NotifyTaskTerminal(ctx context.Context, taskID, taskTitle, status string)
}

// TitleResolver optionally loads the cognition provider for async session naming.
// When unset or not configured, titles stay as the prompt truncation fallback.
type TitleResolver func(ctx context.Context) (provider.Client, provider.Config, error)

// ProviderEntryResolver resolves a routing provider ID to adapter runtime
// configuration.
type ProviderEntryResolver func(ctx context.Context, providerID string) (adapter.ProviderConfig, error)

// EngineConfig is the validated production construction path. Optional
// integrations such as notifications and title resolution may be nil, but
// execution, workspace, and routing dependencies must be complete before the
// Engine can be started.
type EngineConfig struct {
	Store                 *store.Store
	Agents                *agent.Registry
	Bus                   *Bus
	MaxConcurrent         int
	Workspace             WorkspaceRuntime
	DefaultPreference     DefaultPreference
	Notifier              Notifier
	TitleResolver         TitleResolver
	UsageWindows          UsageWindowProber
	RoutingResolver       RoutingResolver
	ProviderEntryResolver ProviderEntryResolver
	ExpiryInterval        time.Duration
}

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
	retryMu       sync.Mutex // serializes retry file and durable-state rewinds
	eventMu       sync.Mutex // serializes event append during parallel worker waves
	persistMu     sync.Mutex // disposable persist-gap bookkeeping
	maxConcurrent int
	active        int
	queue         []string // FIFO of task IDs waiting to run
	handles       map[string]adapter.RunHandle
	handleGroups  map[string][]adapter.RunHandle // parallel orchestration wave
	canceled      map[string]bool
	activeRuns    map[string]string // task id -> current top-level execution id
	// workspaceCommitting marks tasks past the last cancellable point before
	// an irreversible fast-forward.
	workspaceCommitting map[string]string
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

	// limitWaitCancel holds in-memory auto-continue timers after rate limits.
	limitWaitCancel map[string]context.CancelFunc
	// usageWindows optionally probes Claude/Codex subscription windows for preflight.
	usageWindows UsageWindowProber

	// defaultPreference optional; returns configured preferred agent id only.
	// Readiness/fallback is owned by the registry.
	defaultPreference agentDefaultPreference

	// routingResolver resolves provider/model for auto dispatch phases.
	routingResolver RoutingResolver

	// providerEntryResolver resolves a routing provider ID to its runtime
	// config (API key, base URL, model).
	providerEntryResolver ProviderEntryResolver

	startMu        sync.Mutex
	requiresStart  bool
	started        bool
	expiryInterval time.Duration
}

// tiny interface so tests can inject ULID entropy if needed.
type ioReader interface {
	Read([]byte) (int, error)
}

// NewConfiguredEngine validates and wires the complete production Engine.
// Call Start before exposing the Engine to request handlers or routines.
func NewConfiguredEngine(cfg EngineConfig) (*Engine, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	engine := newEngine(cfg.Store, cfg.Agents, cfg.Bus, cfg.MaxConcurrent)
	engine.workspace = cfg.Workspace
	engine.defaultPreference = cfg.DefaultPreference
	engine.notify = cfg.Notifier
	engine.titleFn = cfg.TitleResolver
	engine.usageWindows = cfg.UsageWindows
	engine.routingResolver = cfg.RoutingResolver
	engine.providerEntryResolver = cfg.ProviderEntryResolver
	engine.requiresStart = true
	engine.expiryInterval = cfg.ExpiryInterval
	if engine.expiryInterval <= 0 {
		engine.expiryInterval = time.Minute
	}
	return engine, nil
}

func (cfg EngineConfig) validate() error {
	var missing []string
	if cfg.Store == nil {
		missing = append(missing, "Store")
	}
	if cfg.Agents == nil {
		missing = append(missing, "Agents")
	}
	if cfg.Workspace == nil {
		missing = append(missing, "Workspace")
	}
	if cfg.DefaultPreference == nil {
		missing = append(missing, "DefaultPreference")
	}
	if cfg.RoutingResolver == nil {
		missing = append(missing, "RoutingResolver")
	}
	if cfg.ProviderEntryResolver == nil {
		missing = append(missing, "ProviderEntryResolver")
	}
	if len(missing) > 0 {
		return fmt.Errorf("invalid engine configuration: missing %s", strings.Join(missing, ", "))
	}
	return nil
}

// NewEngine is a compatibility constructor for tests and small embedders.
// Production assembly should use NewConfiguredEngine and Start.
func NewEngine(st *store.Store, agents *agent.Registry, bus *Bus, maxConcurrent int) *Engine {
	return newEngine(st, agents, bus, maxConcurrent)
}

func newEngine(st *store.Store, agents *agent.Registry, bus *Bus, maxConcurrent int) *Engine {
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
		activeRuns:          make(map[string]string),
		workspaceCommitting: make(map[string]string),
		pendingFollowUp:     make(map[string]pendingFollowUp),
		criticalPersistFail: make(map[string]error),
		persistGaps:         make(map[string]*persistGap),
		ctx:                 ctx,
		cancel:              cancel,
		entropy:             rand.Reader,
		approvalWaiters:     make(map[string][]chan store.Approval),
		userQuestionWaiters: make(map[string][]chan store.UserQuestion),
		approvalTTL:         store.DefaultApprovalTTL,
		limitWaitCancel:     make(map[string]context.CancelFunc),
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

// RoutingResolver resolves provider/model choices for automatic dispatch.
type RoutingResolver interface {
	Resolve(ctx context.Context, req routing.ResolveRequest) (routing.Decision, error)
	Next(ctx context.Context, previous routing.Decision, failure routing.Failure) (routing.Decision, bool)
	LookupProvider(ctx context.Context, providerID string) (routing.ProviderProfile, error)
	Defaults(ctx context.Context) (routing.RoutingDefaults, error)
}

// SetClock injects a clock for tests (approval expiry).
func (e *Engine) SetClock(fn func() time.Time) { e.clock = fn }

// SetApprovalTTL overrides the 1h default (tests).
func (e *Engine) SetApprovalTTL(d time.Duration) { e.approvalTTL = d }

// SetNotifier wires Bark/ntfy notifications (M3). Optional.
func (e *Engine) SetNotifier(n Notifier) { e.notify = n }

// WorkspaceRuntime prepares isolated task workspaces and (later) checkpoints.
// Optional: nil preserves shared cwd behavior for tests and headless paths.
type WorkspaceRuntime interface {
	ResolveSource(ctx context.Context, cwd string) (workspace.SourceMetadata, error)
	Prepare(ctx context.Context, taskID, cwd string, requested workspace.RequestedMode) (workspace.Metadata, error)
	PrepareGeneration(ctx context.Context, taskID string, generation int, source workspace.SourceMetadata) (workspace.Metadata, error)
	InspectGeneration(ctx context.Context, meta workspace.Metadata) (workspace.Inspection, error)
	CleanupPrepared(ctx context.Context, taskID string, meta workspace.Metadata) error
	Capture(ctx context.Context, meta workspace.Metadata, taskID string, eventSeq int) (workspace.Checkpoint, error)
	CapturePrepared(ctx context.Context, meta workspace.Metadata, taskID string) (workspace.Checkpoint, error)
	Restore(ctx context.Context, meta workspace.Metadata, taskID string, cp workspace.Checkpoint) error
	RestoreTreeOntoCurrent(ctx context.Context, meta workspace.Metadata, taskID string, cp workspace.Checkpoint) error
	PrepareFork(ctx context.Context, newTaskID string, source workspace.Metadata, cp workspace.Checkpoint) (workspace.Metadata, error)
	InspectFinalizable(ctx context.Context, meta workspace.Metadata) (workspace.FinalizeInspection, error)
	InspectIntegrationTarget(ctx context.Context, meta workspace.Metadata, targetBranch string) (string, error)
	IsAncestor(ctx context.Context, meta workspace.Metadata, ancestorOID, descendantOID string) (bool, error)
	CurrentBranch(ctx context.Context, cwd string) (string, error)
	FastForward(ctx context.Context, meta workspace.Metadata, targetBranch, expectedSourceOID, finalHeadOID string) (string, error)
	FinalizeFastForward(ctx context.Context, meta workspace.Metadata, targetBranch string) (string, error)
	Release(ctx context.Context, meta workspace.Metadata) error
	ReleaseAndPrune(ctx context.Context, meta workspace.Metadata, taskID string) error
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

// Start performs restart recovery before enabling task creation and starting
// background expiry work. It is idempotent after a successful startup.
func (e *Engine) Start(ctx context.Context) error {
	e.startMu.Lock()
	defer e.startMu.Unlock()
	if e.started {
		return nil
	}
	if err := e.Recover(ctx); err != nil {
		return fmt.Errorf("recover task engine: %w", err)
	}
	e.started = true
	e.StartExpiryLoop(e.ctx, e.expiryInterval)
	return nil
}

// Started reports whether the validated startup sequence has completed.
// Compatibility engines constructed with NewEngine do not require Start.
func (e *Engine) Started() bool {
	e.startMu.Lock()
	defer e.startMu.Unlock()
	return e.started || !e.requiresStart
}

func (e *Engine) requireStarted() error {
	if !e.Started() {
		return ErrEngineNotStarted
	}
	return nil
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
		if err := e.store.MarkWorkerStepsTerminal(ctx, id, StatusFailed, "daemon restarted", e.nowMilli()); err != nil {
			return err
		}
	}

	// Retry restore intents reserve their tasks as retrying, so they are not
	// failed as generic orphans above. Resolve every filesystem saga before
	// normal workspace reconciliation can observe its planned generation.
	if err := e.recoverRetryRestores(ctx); err != nil {
		return fmt.Errorf("recover retry restores: %w", err)
	}

	// Reconcile workspace generations after restart
	if err := e.reconcileWorkspaces(ctx); err != nil {
		// Log but don't fail - recovery should still proceed
		payload, _ := json.Marshal(map[string]string{"message": "workspace reconciliation: " + err.Error()})
		ev, _ := e.store.AppendEvent(ctx, "__system__", "error", payload)
		if ev.Seq > 0 {
			e.bus.PublishEvent(ev)
		}
	}

	// Re-arm Wait timers for failed tasks left in limit waiting state.
	e.recoverLimitWaits(ctx)
	e.pump()
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

// SetRoutingResolver sets the resolver used for auto dispatch routing.
func (e *Engine) SetRoutingResolver(rr RoutingResolver) {
	e.routingResolver = rr
}

// SetProviderEntryResolver sets a function that resolves a routing provider
// ID to its runtime config (API key, base URL, model).
func (e *Engine) SetProviderEntryResolver(fn func(ctx context.Context, providerID string) (adapter.ProviderConfig, error)) {
	e.providerEntryResolver = fn
}

// resolveProviderCfg resolves a provider ID to its runtime config.
func (e *Engine) resolveProviderCfg(ctx context.Context, providerID string) (adapter.ProviderConfig, error) {
	if e.providerEntryResolver == nil || providerID == "" {
		return adapter.ProviderConfig{}, nil
	}
	cfg, err := e.providerEntryResolver(ctx, providerID)
	if err != nil {
		return adapter.ProviderConfig{}, fmt.Errorf("resolve provider config for %q: %w", providerID, err)
	}
	return cfg, nil
}

// resolveAutoRoute resolves each phase (plan/execute/review) for an auto
// dispatch task using the routing resolver. It returns a DelegatePlan with
// team-configured agents and the route decisions for audit.
func (e *Engine) resolveAutoRoute(ctx context.Context, t store.Task) (DelegatePlan, []routing.RouteDecision, error) {
	sel := parseDispatch(t.Dispatch)
	defaults, err := e.loadRoutingDefaults(ctx)
	if err != nil {
		return DelegatePlan{}, nil, err
	}
	if sel.Mode != "auto" || sel.Team == "" {
		// When dispatch is absent, try routing.defaults.
		if !defaults.Enabled || defaults.DefaultTeam == "" {
			return DelegatePlan{}, nil, fmt.Errorf("not an auto dispatch")
		}
		sel.Mode = "auto"
		sel.Team = defaults.DefaultTeam
		sel.Objective = defaults.Objective
	} else if sel.Objective == "" {
		sel.Objective = defaults.Objective
	}
	if e.routingResolver == nil {
		return DelegatePlan{}, nil, fmt.Errorf("routing resolver not configured")
	}

	objective := sel.Objective
	if objective == "" {
		objective = string(routing.ObjectiveBalanced)
	}

	prompt := UserTurnPrompt(t.Prompt)
	complexity := routing.ClassifyPrompt(prompt, t.RoutineID != "")
	phases := routing.PhasesFor(complexity, defaults.ForcePhases)
	var steps []DelegateStep
	var decisions []routing.RouteDecision

	for _, phase := range phases {
		req := routing.ResolveRequest{
			TaskID:       t.ID,
			Team:         sel.Team,
			Objective:    objective,
			Phase:        phase,
			Prompt:       prompt,
			Routine:      t.RoutineID != "",
			QualityFloor: defaults.QualityFloor,
		}
		dec, err := e.routingResolver.Resolve(ctx, req)
		if err != nil {
			// PhaseExecute is required; fail immediately if it cannot be resolved.
			if phase == routing.PhaseExecute {
				return DelegatePlan{}, nil, fmt.Errorf("required phase %q failed to resolve for team %q: %w", phase, sel.Team, err)
			}
			// Plan and Review are optional; skip and continue.
			continue
		}

		instruction := phaseInstruction(phase, prompt)
		steps = append(steps, DelegateStep{
			Agent:       dec.Agent,
			Model:       dec.Model,
			Provider:    dec.Provider,
			Phase:       string(phase),
			Access:      inferStepAccess(string(phase), instruction),
			Instruction: instruction,
			Mention:     "auto-" + string(phase),
		})

		decisions = append(decisions, routing.RouteDecision{
			Type:         routing.RouteDecisionType,
			Team:         sel.Team,
			Objective:    objective,
			Phase:        phase,
			Agent:        dec.Agent,
			Provider:     dec.Provider,
			Model:        dec.Model,
			Tier:         dec.Tier,
			Reason:       dec.Reason,
			Skipped:      dec.Skipped,
			QualityFloor: dec.QualityFloor,
			Complexity: func() *routing.Complexity {
				c := dec.Complexity
				return &c
			}(),
			CostLabel:  dec.CostLabel,
			Score:      dec.Score,
			ScoreParts: dec.ScoreParts,
		})
	}

	if len(steps) == 0 {
		return DelegatePlan{}, nil, fmt.Errorf("no resolvable phases for team %q", sel.Team)
	}

	plan := DelegatePlan{
		Overview: prompt,
		Raw:      prompt,
		Steps:    steps,
	}
	return plan, decisions, nil
}

// phaseInstruction returns a default instruction for the given phase.
func phaseInstruction(phase routing.RoutePhase, prompt string) string {
	switch phase {
	case routing.PhasePlan:
		return "Create a concrete implementation plan only. Do not modify files or run commands. Output a clear step-by-step plan for: " + prompt
	case routing.PhaseExecute:
		return prompt
	case routing.PhaseReview:
		return "根据上一 agent 的工作结果做代码审查与验收：指出问题、确认是否完成用户目标，并给出简短总结。不要重复实现整套方案，除非发现严重缺陷必须修。"
	default:
		return prompt
	}
}

// emitRouteDecision appends a route_decision event to the task event log.
func (e *Engine) emitRouteDecision(ctx context.Context, taskID string, d routing.RouteDecision) {
	payload, err := json.Marshal(d)
	if err != nil {
		return
	}
	if w := e.eventWriter(); w != nil {
		if ev, err := w.AppendEvent(ctx, taskID, routing.RouteDecisionType, payload); err == nil {
			e.bus.PublishEvent(ev)
		}
	}
}

func (e *Engine) emitRouteDecisionForRun(
	ctx context.Context, taskID, executionID string, d routing.RouteDecision,
) {
	payload, err := json.Marshal(d)
	if err != nil {
		return
	}
	if ev, err := e.persistRunEvent(
		ctx, taskID, executionID, routing.RouteDecisionType, payload,
	); err == nil {
		e.bus.PublishEvent(ev)
	}
}

// emitRouteFallback appends a route_fallback event to the task event log.
func (e *Engine) emitRouteFallback(ctx context.Context, taskID string, f routing.Failure, next routing.Decision) {
	e.emitRouteFallbackWithExecution(ctx, taskID, "", f, next)
}

func (e *Engine) emitRouteFallbackForRun(
	ctx context.Context,
	taskID, executionID string,
	f routing.Failure,
	next routing.Decision,
) {
	e.emitRouteFallbackWithExecution(ctx, taskID, executionID, f, next)
}

func (e *Engine) emitRouteFallbackWithExecution(
	ctx context.Context,
	taskID, executionID string,
	f routing.Failure,
	next routing.Decision,
) {
	d := routing.RouteDecision{
		Type:         routing.RouteFallbackType,
		Team:         next.Team,
		Objective:    next.Objective,
		Phase:        next.Phase,
		Agent:        next.Agent,
		Provider:     next.Provider,
		Model:        next.Model,
		Tier:         next.Tier,
		Reason:       next.Reason,
		Skipped:      next.Skipped,
		QualityFloor: next.QualityFloor,
		Complexity: func() *routing.Complexity {
			c := next.Complexity
			return &c
		}(),
		CostLabel:  next.CostLabel,
		Score:      next.Score,
		ScoreParts: next.ScoreParts,
		FallbackFrom: &routing.FallbackSource{
			Provider: f.Provider,
			Model:    f.Model,
			Class:    string(f.Class),
			Message:  f.Message,
		},
	}
	payload, err := json.Marshal(d)
	if err != nil {
		return
	}
	if executionID != "" {
		if ev, err := e.persistRunEvent(
			ctx, taskID, executionID, routing.RouteFallbackType, payload,
		); err == nil {
			e.bus.PublishEvent(ev)
		}
		return
	}
	if w := e.eventWriter(); w != nil {
		if ev, err := w.AppendEvent(ctx, taskID, routing.RouteFallbackType, payload); err == nil {
			e.bus.PublishEvent(ev)
		}
	}
}

// startWorkerWithFallback starts a worker with provider/model fallback support.
// When the worker fails to start with a transient/quota error and the step has
// routing metadata (Phase, Provider), it calls routingResolver.Next() to find
// an alternative provider/model and retries up to maxAttempts times.
func (e *Engine) startWorkerWithFallback(
	ctx context.Context,
	taskID string,
	t store.Task,
	step DelegateStep,
	brief string,
	si int,
	runMeta adapter.RunMetadata,
) (adapter.RunHandle, adapter.ExecutionRef, []string, error) {
	ad, ok := e.runnerFor(step.Agent)
	if !ok {
		return nil, adapter.ExecutionRef{}, nil, fmt.Errorf("%s has no runner", step.Agent)
	}
	if ad == nil {
		return nil, adapter.ExecutionRef{}, nil, fmt.Errorf("agent %s is not available", step.Agent)
	}

	model := effectiveStepModel(t, step)
	provider := step.Provider
	phase := step.Phase

	defaults, err := e.loadRoutingDefaults(ctx)
	if err != nil {
		return nil, adapter.ExecutionRef{}, nil, err
	}
	maxAttempts := defaults.MaxAttemptsPerStep
	if maxAttempts <= 0 {
		maxAttempts = 3
	}

	var failedProviders []string

	var lastDecision routing.Decision
	attempt := 0

	for {
		if !e.runAcceptsWorker(taskID, runMeta.WorkspaceExecutionID) {
			return nil, adapter.ExecutionRef{}, nil, store.ErrConflict
		}
		attempt++
		execRef := adapter.ExecutionRef{
			Agent:      step.Agent,
			Model:      model,
			Step:       si + 1,
			ProviderID: provider,
		}
		eid, err := e.newID()
		if err != nil {
			return nil, adapter.ExecutionRef{}, nil, fmt.Errorf("execution id: %w", err)
		}
		execRef.ID = eid

		spec := adapter.TaskSpec{
			ID:             t.ID,
			Agent:          step.Agent,
			Cwd:            t.EffectiveCwd(),
			Prompt:         brief,
			Model:          model,
			SessionRef:     "",
			PermissionMode: adapter.NormalizePermissionMode(t.PermissionMode),
			Execution:      execRef,
			RunMeta:        runMeta,
		}
		if cfg, err := e.resolveProviderCfg(ctx, provider); err != nil {
			return nil, adapter.ExecutionRef{}, nil, err
		} else if cfg.BaseURL != "" {
			spec.ProviderCfg = &cfg
		}
		h, err := ad.Start(ctx, spec)
		if err == nil {
			if !e.runAcceptsWorker(taskID, runMeta.WorkspaceExecutionID) {
				_ = h.Cancel()
				return nil, adapter.ExecutionRef{}, nil, store.ErrConflict
			}
			return h, execRef, nil, nil
		}

		if e.routingResolver == nil || phase == "" || provider == "" {
			return nil, adapter.ExecutionRef{}, nil, fmt.Errorf("%s failed to start: %w", step.Agent, err)
		}

		if attempt >= maxAttempts {
			return nil, adapter.ExecutionRef{}, nil, fmt.Errorf("%s failed to start after %d attempts: %w", step.Agent, attempt, err)
		}

		failedProviders = append(failedProviders, provider)
		failure := routing.ClassifyFailure(err, provider, model)
		if !routing.IsFallbackSafe(failure.Class) {
			return nil, adapter.ExecutionRef{}, nil, fmt.Errorf("%s failed to start (non-retryable): %w", step.Agent, err)
		}

		prev := lastDecision
		if prev.Team == "" {
			sel := parseDispatch(t.Dispatch)
			prev = routing.Decision{
				Agent:    step.Agent,
				Provider: provider,
				Model:    model,
				Team:     sel.Team,
				Phase:    routing.RoutePhase(phase),
				Objective: func() string {
					if sel.Objective != "" {
						return sel.Objective
					}
					return "balanced"
				}(),
			}
		}

		next, ok := e.routingResolver.Next(ctx, prev, failure)
		if !ok {
			return nil, adapter.ExecutionRef{}, nil, fmt.Errorf("%s failed to start and no fallback available: %w", step.Agent, err)
		}

		e.emitRouteFallbackForRun(
			ctx, taskID, runMeta.WorkspaceExecutionID, failure, next,
		)

		model = next.Model
		provider = next.Provider
		lastDecision = next
	}
}

// HasAgent reports whether an agent is registered (not necessarily ready).
func (e *Engine) HasAgent(id string) bool {
	return e.agents.Has(id)
}

// AgentIDs returns registered agent ids in registry order.
func (e *Engine) AgentIDs() []string {
	return e.agents.IDs()
}

// dispatchSelection is a minimal parse of the raw dispatch JSON.
type dispatchSelection struct {
	Mode      string `json:"mode"`
	Team      string `json:"team,omitempty"`
	Agent     string `json:"agent,omitempty"`
	Provider  string `json:"provider,omitempty"`
	Model     string `json:"model,omitempty"`
	Objective string `json:"objective,omitempty"`
}

// shouldAutoRoute reports whether the task has a valid auto dispatch
// selection and the prompt looks like a coding task.
func (e *Engine) shouldAutoRoute(ctx context.Context, t store.Task) (bool, error) {
	var sel dispatchSelection
	if len(t.Dispatch) > 0 {
		if err := json.Unmarshal(t.Dispatch, &sel); err != nil {
			return false, fmt.Errorf("parse dispatch: %w", err)
		}
	}
	// When dispatch is absent or empty, fall back to routing.defaults.
	if sel.Mode == "" || sel.Team == "" {
		if e.routingResolver != nil {
			defaults, err := e.loadRoutingDefaults(ctx)
			if err != nil {
				return false, err
			}
			if defaults.Enabled && defaults.DefaultTeam != "" {
				sel.Mode = "auto"
				sel.Team = defaults.DefaultTeam
				sel.Objective = defaults.Objective
			}
		}
	}
	if !LooksLikeCodingTask(UserTurnPrompt(t.Prompt)) {
		return false, nil
	}
	return sel.Mode == "auto" && sel.Team != "", nil
}

func (e *Engine) loadRoutingDefaults(ctx context.Context) (routing.RoutingDefaults, error) {
	if e.routingResolver == nil {
		return routing.DefaultRoutingDefaults(), nil
	}
	defaults, err := e.routingResolver.Defaults(ctx)
	if err != nil {
		return routing.RoutingDefaults{}, fmt.Errorf("load routing defaults: %w", err)
	}
	return defaults, nil
}

// parseDispatch parses the raw dispatch JSON and returns the selection.
func parseDispatch(raw json.RawMessage) dispatchSelection {
	if len(raw) == 0 {
		return dispatchSelection{}
	}
	var sel dispatchSelection
	_ = json.Unmarshal(raw, &sel)
	return sel
}

// validateManualDispatch validates a manual dispatch selection against
// routing profiles. It checks that the provider exists, supports the agent,
// and lists the model.
func (e *Engine) validateManualDispatch(ctx context.Context, sel dispatchSelection, taskID string) error {
	if sel.Provider == "" || sel.Agent == "" {
		return fmt.Errorf("manual dispatch: provider and agent are required")
	}
	if e.routingResolver == nil {
		return nil
	}
	prof, err := e.routingResolver.LookupProvider(ctx, sel.Provider)
	if err != nil {
		return fmt.Errorf("manual dispatch: %w", err)
	}
	if !prof.Enabled {
		return fmt.Errorf("manual dispatch: provider %q is disabled", sel.Provider)
	}
	if !routing.ProviderSupportsAgent(prof, sel.Agent) {
		return fmt.Errorf("manual dispatch: provider %q does not support agent %q", sel.Provider, sel.Agent)
	}
	if sel.Model != "" {
		modelFound := false
		for _, m := range prof.Models {
			if m.ID == sel.Model {
				modelFound = true
				break
			}
		}
		if !modelFound {
			return fmt.Errorf("manual dispatch: model %q is not listed under provider %q", sel.Model, sel.Provider)
		}
	}
	// Emit route_decision for audit.
	e.emitRouteDecision(ctx, taskID, routing.RouteDecision{
		Type:     routing.RouteDecisionType,
		Agent:    sel.Agent,
		Provider: sel.Provider,
		Model:    sel.Model,
		Reason:   "manual dispatch",
	})
	return nil
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
	if err := e.resetAgentSessionStrict(ctx, id, taskID); err != nil {
		payload, _ := json.Marshal(map[string]string{
			"message": fmt.Sprintf("session reset for %s failed: %v", id, err),
		})
		if ev, err := e.store.AppendEvent(ctx, taskID, "error", payload); err == nil {
			e.bus.PublishEvent(ev)
		}
	}
}

func (e *Engine) resetAgentSessionStrict(ctx context.Context, id, taskID string) error {
	return e.agents.ResetSession(ctx, id, taskID)
}

// Create enqueues a new task and starts it if under the concurrency limit.
func (e *Engine) Create(ctx context.Context, req CreateRequest) (store.Task, error) {
	if err := e.requireStarted(); err != nil {
		return store.Task{}, err
	}
	if req.Cwd == "" {
		return store.Task{}, fmt.Errorf("cwd is required")
	}
	if req.Prompt == "" {
		return store.Task{}, fmt.Errorf("prompt is required")
	}

	// Parse dispatch selection and apply it to the request.
	sel := parseDispatch(req.Dispatch)
	switch sel.Mode {
	case "manual":
		// Manual dispatch: validate provider/agent/model matrix.
		if sel.Agent != "" {
			req.Agent = sel.Agent
		}
		if sel.Model != "" {
			req.Model = &sel.Model
		}
		if sel.Provider == "" {
			return store.Task{}, fmt.Errorf("manual dispatch requires a provider")
		}
	case "auto":
		// Auto dispatch: keep the existing agent selection; the team and
		// objective will be resolved by shouldAutoRoute at startOne time.
	default:
		// No dispatch or unknown mode: keep existing behavior.
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

	var err error
	id := strings.TrimSpace(req.ID)
	if id == "" {
		id, err = e.newID()
		if err != nil {
			return store.Task{}, err
		}
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
		RoutineID:      strings.TrimSpace(req.RoutineID),
		Dispatch:       req.Dispatch,
	}

	// Resolve workspace mode and policy.
	workspaceMode := req.WorkspaceMode
	if workspaceMode == "" {
		workspaceMode = workspace.ModeAuto
	}

	// Check if agent supports lazy workspace promotion.
	lazySupport := e.agents.LazyWorkspaceSupport(ctx, req.Agent)
	useLazy := workspaceMode == workspace.ModeAuto && lazySupport.Supported && e.workspace != nil

	var meta workspace.Metadata
	var turnAccess string

	if useLazy {
		// Lazy: resolve source metadata, no worktree, source_read_only turn.
		src, err := e.workspace.ResolveSource(ctx, req.Cwd)
		if err != nil {
			return store.Task{}, fmt.Errorf("resolve source: %w", err)
		}
		meta = workspace.Metadata{
			Mode:       workspace.ResolvedWorktree,
			SourceRoot: src.SourceRoot,
			Root:       src.SourceRoot,
			Cwd:        src.Cwd,
			Scope:      src.Scope,
			BaseOID:    src.HeadOID,
			Branch:     src.TargetBranch,
		}
		t.WorkspacePolicy = string(store.WorkspacePolicyAuto)
		turnAccess = string(adapter.AccessSourceReadOnly)
	} else if workspaceMode == workspace.ModeShared {
		meta, err = e.prepareWorkspace(ctx, id, req.Cwd, workspaceMode)
		if err != nil {
			return store.Task{}, err
		}
		t.WorkspacePolicy = string(store.WorkspacePolicyShared)
		turnAccess = string(adapter.AccessShared)
	} else {
		// Eager worktree (auto non-lazy or explicit worktree).
		meta, err = e.prepareWorkspace(ctx, id, req.Cwd, workspaceMode)
		if err != nil {
			return store.Task{}, err
		}
		t.WorkspacePolicy = string(store.WorkspacePolicyWorktree)
		turnAccess = string(adapter.AccessPendingIsolation)
	}
	applyWorkspaceMetadata(&t, meta)

	if err := e.store.InsertTask(ctx, t); err != nil {
		e.cleanupPreparedWorkspace(id, meta)
		return store.Task{}, err
	}
	// Validate manual dispatch against provider profiles after task ID is created.
	if sel.Mode == "manual" {
		if err := e.validateManualDispatch(ctx, sel, id); err != nil {
			e.cleanupPreparedWorkspace(id, meta)
			_ = e.store.DeleteTask(ctx, id)
			return store.Task{}, err
		}
	}
	var eagerWorkspace *store.WorkspaceGeneration
	if !useLazy && meta.Mode == workspace.ResolvedWorktree {
		targetBranch, err := e.workspace.CurrentBranch(ctx, meta.SourceRoot)
		if err != nil {
			e.cleanupPreparedWorkspace(id, meta)
			_ = e.store.DeleteTask(ctx, id)
			return store.Task{}, fmt.Errorf("resolve workspace target branch: %w", err)
		}
		targetBranch = strings.TrimSpace(targetBranch)
		if targetBranch == "" {
			e.cleanupPreparedWorkspace(id, meta)
			_ = e.store.DeleteTask(ctx, id)
			return store.Task{}, fmt.Errorf("source repository is in detached HEAD")
		}
		ws := store.WorkspaceGeneration{
			ID:              id + ":g1",
			TaskID:          id,
			Generation:      1,
			State:           store.WorkspaceActive,
			SourceRoot:      meta.SourceRoot,
			Scope:           meta.Scope,
			TargetBranch:    targetBranch,
			WorkspaceBranch: meta.Branch,
			PhysicalRoot:    meta.Root,
			ExecutionCwd:    meta.Cwd,
			BaseOID:         meta.BaseOID,
			CreatedAt:       now,
			UpdatedAt:       now,
		}
		workspaceEvent, err := e.store.InsertWorkspaceAsCurrent(ctx, ws)
		if err != nil {
			e.cleanupPreparedWorkspace(id, meta)
			_ = e.store.DeleteTask(ctx, id)
			return store.Task{}, fmt.Errorf("persist workspace generation: %w", err)
		}
		t.CurrentWorkspaceID = ws.ID
		eagerWorkspace = &ws
		e.bus.PublishEvent(workspaceEvent)
		turnAccess = string(adapter.AccessWritable)
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
	// Append user event with turn workspace binding.
	turn := store.TaskTurnWorkspace{
		TaskID: id,
		Access: turnAccess,
	}
	if eagerWorkspace != nil {
		turn.WorkspaceID = &eagerWorkspace.ID
	}
	ev, _, err := e.store.AppendUserEventWithTurnWorkspace(ctx, id, userPayload, turn)
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
	e.retryMu.Lock()
	defer e.retryMu.Unlock()
	return e.cancelTask(ctx, id)
}

func (e *Engine) cancelTask(ctx context.Context, id string) (store.Task, error) {
	e.cancelLimitWait(id)
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	switch t.Status {
	case StatusSucceeded, StatusFailed, StatusCanceled:
		return t, fmt.Errorf("task already terminal (%s)", t.Status)
	case StatusRetrying:
		return t, fmt.Errorf("%w: retry file restoration is in progress", ErrConflict)
	}
	e.mu.Lock()
	if e.workspaceCommitting[id] != "" {
		e.mu.Unlock()
		return t, fmt.Errorf("%w: workspace integration is already committing", ErrConflict)
	}
	e.canceled[id] = true
	e.mu.Unlock()
	_ = e.store.MarkWorkerStepsTerminal(ctx, id, StatusCanceled, "task canceled", e.nowMilli())

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

	// Workspace-aware cancel: handle provisioning and finalizing states.
	if e.workspace != nil {
		ws, wsErr := e.store.GetCurrentWorkspace(ctx, id)
		if wsErr == nil {
			meta := workspaceGenerationMetadata(ws)
			unlock := lockWorkspaceGeneration(e.workspace, meta)
			defer unlock()
			ws, wsErr = e.store.GetWorkspace(ctx, ws.ID)
			if wsErr != nil {
				return store.Task{}, fmt.Errorf("refresh current workspace: %w", wsErr)
			}
			switch ws.State {
			case store.WorkspaceProvisioning:
				// Cancel provisioning, clean up partial worktree, mark orphaned.
				reason := "canceled during provisioning"
				transition := store.WorkspaceTransition{
					WorkspaceID: ws.ID,
					TaskID:      id,
					FromStates:  []store.WorkspaceState{store.WorkspaceProvisioning},
					ToState:     store.WorkspaceOrphaned,
					Patch: store.WorkspacePatch{
						FailureReason: &reason,
					},
				}
				if _, err := e.transitionWorkspace(ctx, transition); err == nil {
					// Clean up partial worktree if it exists
					if meta.Root != "" {
						_ = e.workspace.Release(ctx, meta)
					}
				}

			case store.WorkspaceFinalizing:
				// Transition to finalize_blocked, clear completed_execution_id, retain worktree.
				reason := "canceled during finalization"
				transition := store.WorkspaceTransition{
					WorkspaceID: ws.ID,
					TaskID:      id,
					FromStates:  []store.WorkspaceState{store.WorkspaceFinalizing},
					ToState:     store.WorkspaceFinalizeBlocked,
					Patch: store.WorkspacePatch{
						FailureReason:        &reason,
						CompletedExecutionID: strPtr(""),
					},
				}
				_, _ = e.transitionWorkspace(ctx, transition)
			}
		}
	}

	e.mu.Lock()
	// Remove from queue if present.
	for i, qid := range e.queue {
		if qid == id {
			e.queue = append(e.queue[:i], e.queue[i+1:]...)
			delete(e.canceled, id)
			e.mu.Unlock()
			t, err := e.finishQueued(ctx, id, StatusCanceled, nil, nil)
			if err == nil {
				e.invalidateActiveRun(id)
			}
			return t, err
		}
	}
	h := e.handles[id]
	group := e.handleGroups[id]
	delete(e.pendingFollowUp, id) // pure cancel must not re-queue a steerable follow-up
	e.mu.Unlock()

	if h != nil || len(group) > 0 {
		if h != nil {
			_ = h.Cancel()
		}
		for _, gh := range group {
			_ = gh.Cancel()
		}
		now := e.nowMilli()
		status := StatusCanceled
		e.mu.Lock()
		updateErr := e.store.UpdateTask(ctx, id, store.TaskPatch{
			Status:     &status,
			FinishedAt: &now,
		})
		if updateErr == nil {
			delete(e.activeRuns, id)
			delete(e.handles, id)
			delete(e.handleGroups, id)
			delete(e.canceled, id)
		}
		e.mu.Unlock()
		if updateErr != nil {
			return store.Task{}, updateErr
		}
		t, err = e.store.GetTask(ctx, id)
		if err != nil {
			return store.Task{}, err
		}
		e.bus.PublishTask(t)
		return t, nil
	}

	// Not queued and no handle means startOne may be between its durable
	// queued-to-running claim and handle registration. Keep the cancellation
	// marker for startOne to consume once Adapter.Start returns.
	t, err = e.finishQueued(ctx, id, StatusCanceled, nil, nil)
	if err == nil {
		e.invalidateActiveRun(id)
	}
	return t, err
}

// Delete permanently removes a task and its history after canceling any
// in-flight work. Workspace generations are cleaned up before metadata cascade.
func (e *Engine) Delete(ctx context.Context, id string) error {
	e.retryMu.Lock()
	defer e.retryMu.Unlock()

	e.cancelLimitWait(id)
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return err
	}
	if t.Status == StatusRetrying {
		return fmt.Errorf("%w: retry file restoration is in progress", ErrConflict)
	}

	// Stop runners / dequeue so nothing rewrites the row while we delete.
	switch t.Status {
	case StatusSucceeded, StatusFailed, StatusCanceled:
		// already terminal
	default:
		if _, err := e.cancelTask(ctx, id); err != nil {
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
	delete(e.activeRuns, id)
	e.mu.Unlock()

	e.resetAgentSession(ctx, t.Agent, id)

	// Clean up workspace generations before deleting metadata.
	if e.workspace != nil {
		generations, listErr := e.store.ListTaskWorkspaces(ctx, id)
		if listErr == nil {
			for _, ws := range generations {
				meta := workspaceGenerationMetadata(ws)
				unlock := lockWorkspaceGeneration(e.workspace, meta)
				switch ws.State {
				case store.WorkspaceIntegrated:
					// Release integrated generations
					_ = e.workspace.Release(ctx, meta)
				case store.WorkspaceProvisioning, store.WorkspaceReady, store.WorkspaceActive,
					store.WorkspaceFinalizing, store.WorkspaceMergeBlocked, store.WorkspaceFinalizeBlocked:
					// Force-discard unintegrated Kin-contained generations
					_ = e.workspace.Release(ctx, meta)
				}
				unlock()
			}
		}
	} else {
		// Fallback: legacy cleanup
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
	}

	if err := e.store.DeleteTask(ctx, id); err != nil {
		return err
	}
	e.bus.PublishTaskDeleted(id)
	return nil
}

// Get returns a task by id.
// PublishTask re-broadcasts a task row (e.g. after out-of-band field updates).
func (e *Engine) PublishTask(t store.Task) {
	if e == nil || e.bus == nil {
		return
	}
	e.bus.PublishTask(t)
}

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

func (e *Engine) resolveRunWorkspace(ctx context.Context, t *store.Task) adapter.RunMetadata {
	runMeta := adapter.RunMetadata{}
	if t.CurrentWorkspaceID != "" {
		ws, err := e.store.GetCurrentWorkspace(ctx, t.ID)
		if err == nil {
			switch ws.State {
			case store.WorkspaceReady:
				transition := store.WorkspaceTransition{
					WorkspaceID: ws.ID,
					TaskID:      t.ID,
					FromStates:  []store.WorkspaceState{store.WorkspaceReady},
					ToState:     store.WorkspaceActive,
				}
				if activated, activateErr := e.transitionWorkspace(ctx, transition); activateErr == nil {
					ws = activated
					applyWorkspaceGeneration(t, ws)
					runMeta.WorkspaceID = ws.ID
					runMeta.WorkspaceAccess = adapter.AccessWritable
					runMeta.Generation = ws.Generation
				} else {
					payload, _ := json.Marshal(map[string]string{
						"message": "failed to activate ready workspace: " + activateErr.Error(),
					})
					if w := e.eventWriter(); w != nil {
						_, _ = w.AppendEvent(ctx, t.ID, "error", payload)
					}
				}
			case store.WorkspaceActive:
				applyWorkspaceGeneration(t, ws)
				runMeta.WorkspaceID = ws.ID
				runMeta.WorkspaceAccess = adapter.AccessWritable
				runMeta.Generation = ws.Generation
			}
		}
	}
	if runMeta.WorkspaceAccess == "" {
		switch t.WorkspacePolicy {
		case string(store.WorkspacePolicyAuto):
			runMeta.WorkspaceAccess = adapter.AccessSourceReadOnly
		case string(store.WorkspacePolicyShared):
			runMeta.WorkspaceAccess = adapter.AccessShared
		default:
			runMeta.WorkspaceAccess = adapter.AccessWritable
		}
	}
	return runMeta
}

func applyWorkspaceGeneration(t *store.Task, ws store.WorkspaceGeneration) {
	t.CurrentWorkspaceID = ws.ID
	t.WorkspaceSourceRoot = ws.SourceRoot
	t.WorkspaceRoot = ws.PhysicalRoot
	t.ExecutionCwd = ws.ExecutionCwd
	t.WorkspaceScope = ws.Scope
	t.WorkspaceBaseOID = ws.BaseOID
	t.WorkspaceBranch = ws.WorkspaceBranch
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
		executionID, err := e.newID()
		if err != nil {
			e.active++
			e.mu.Unlock()
			go func() {
				_, _ = e.failStart(e.ctx, id, fmt.Sprintf("execution id: %v", err))
			}()
			continue
		}
		// A prior start attempt may have observed a cancellation before it
		// claimed the queued row. A newly dequeued turn owns a fresh signal.
		delete(e.canceled, id)
		e.activeRuns[id] = executionID
		e.active++
		e.mu.Unlock()

		go e.startOne(id, executionID)
	}
}

func (e *Engine) setActiveRun(taskID, executionID string) {
	e.mu.Lock()
	e.activeRuns[taskID] = executionID
	e.mu.Unlock()
}

func (e *Engine) clearActiveRun(taskID, executionID string) {
	e.mu.Lock()
	if e.activeRuns[taskID] == executionID {
		delete(e.activeRuns, taskID)
	}
	e.mu.Unlock()
}

func (e *Engine) invalidateActiveRun(taskID string) {
	e.mu.Lock()
	delete(e.activeRuns, taskID)
	e.mu.Unlock()
}

func (e *Engine) isActiveRun(taskID, executionID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.activeRuns[taskID] == executionID
}

func (e *Engine) startOne(id, turnExecutionID string) {
	ctx := e.ctx
	if !e.isActiveRun(id, turnExecutionID) {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		e.clearActiveRun(id, turnExecutionID)
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}
	// May have been canceled while queued.
	if t.Status != StatusQueued {
		e.clearActiveRun(id, turnExecutionID)
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}

	if t.StartedAt != nil &&
		t.CurrentWorkspaceID == "" &&
		t.WorkspaceMode == string(workspace.ResolvedWorktree) {
		ws, requestErr := e.RequestWorkspace(ctx, WorkspaceIntentRequest{
			TaskID: id, ExecutionID: turnExecutionID, Agent: t.Agent,
		})
		if requestErr != nil {
			_, _ = e.failQueuedRunStart(ctx, id, turnExecutionID, fmt.Sprintf("prepare follow-up workspace: %v", requestErr))
			return
		}
		t.CurrentWorkspaceID = ws.ID
	}
	if !e.isActiveRun(id, turnExecutionID) {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}
	if err := e.claimCurrentWorkspaceExecution(ctx, id, turnExecutionID); err != nil {
		_, _ = e.failQueuedRunStart(ctx, id, turnExecutionID, fmt.Sprintf("claim workspace execution: %v", err))
		return
	}

	if !e.isActiveRun(id, turnExecutionID) {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}
	now := e.nowMilli()
	t, err = e.store.StartQueuedTask(ctx, id, now)
	if err != nil {
		e.clearActiveRun(id, turnExecutionID)
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}
	e.bus.PublishTask(t)
	runMeta := e.resolveRunWorkspace(ctx, &t)
	runMeta.WorkspaceExecutionID = turnExecutionID
	if !e.isActiveRun(id, turnExecutionID) {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}

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
		e.runOrchestrated(id, t, plan, runMeta)
		return
	}

	// Auto routing: when routing is enabled with a valid auto dispatch,
	// resolve each phase through the routing resolver and build a
	// DelegatePlan that uses the team's phase agents.
	autoRoute, routeErr := e.shouldAutoRoute(ctx, t)
	if routeErr != nil {
		_, _ = e.failRunningStart(ctx, id, turnExecutionID, fmt.Sprintf("auto routing configuration failed: %v", routeErr))
		return
	}
	if autoRoute {
		if e.routingResolver == nil {
			// No resolver configured: fall back to single-agent path.
		} else {
			plan, decisions, err := e.resolveAutoRoute(ctx, t)
			if err != nil {
				_, _ = e.failRunningStart(ctx, id, turnExecutionID, fmt.Sprintf("auto routing failed: %v", err))
				return
			}
			if len(plan.Steps) > 0 {
				for _, d := range decisions {
					e.emitRouteDecisionForRun(ctx, t.ID, turnExecutionID, d)
				}
				e.runOrchestrated(id, t, plan, runMeta)
				return
			}
		}
	}

	// Bare single-agent turn with NL "smart plan / cheap exec": expand into a
	// same-agent two-step plan (plan worker then exec worker) so models switch
	// without requiring explicit @mentions.
	if d, ok := e.resolveModelDirective(ctx, t); ok && d.WantsRoleSplit() {
		if split, ok := d.BuildRoleSplitPlan(t.Agent, UserTurnPrompt(t.Prompt), BuiltinCatalog()); ok {
			split.SessionContext = ExtractPriorContext(t.Prompt)
			e.runOrchestrated(id, t, split, runMeta)
			return
		}
	}

	ad, ok := e.runnerFor(t.Agent)
	if !ok {
		_, _ = e.failRunningStart(ctx, id, turnExecutionID, fmt.Sprintf("unknown agent %q", t.Agent))
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
		ID:    turnExecutionID,
	}
	cwd := t.EffectiveCwd()

	spec := adapter.TaskSpec{
		ID:    t.ID,
		Agent: t.Agent,
		Cwd:   cwd,
		// Language policy is runtime-only: store keeps the raw user prompt;
		// adapters receive a wrapped copy so Claude Code / etc. match the user.
		Prompt:         withReplyLanguage(t.Prompt, UserTurnPrompt(t.Prompt)),
		Model:          model,
		SessionRef:     sessionRef,
		PermissionMode: adapter.NormalizePermissionMode(t.PermissionMode),
		Execution:      execRef,
		RunMeta:        runMeta,
	}
	if sel := parseDispatch(t.Dispatch); sel.Provider != "" {
		if cfg, err := e.resolveProviderCfg(ctx, sel.Provider); err == nil && cfg.BaseURL != "" {
			spec.ProviderCfg = &cfg
		}
	}

	// Preflight: if subscription window is already exhausted, fail with limit_hit
	// instead of starting a doomed CLI process.
	if info, blocked := e.preflightUsageLimit(ctx, t.Agent); blocked {
		payload, _ := json.Marshal(map[string]any{
			"kind":     adapter.RateLimitKind,
			"message":  info.Message,
			"provider": info.Provider,
			"agent":    t.Agent,
			"reset_at": info.ResetAt,
			"window":   info.Window,
			"source":   "usage_window",
		})
		if w := e.eventWriter(); w != nil {
			if ev, err := w.AppendEvent(ctx, id, "error", payload); err == nil {
				e.bus.PublishEvent(ev)
			}
		}
		_, _ = e.finishRun(ctx, id, turnExecutionID, StatusFailed, nil, nil)
		e.handleNewLimitHit(ctx, id, t.Agent, info)
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}

	if !e.isActiveRun(id, turnExecutionID) {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}
	h, err := ad.Start(ctx, spec)
	if err != nil {
		_, _ = e.failRunningStart(ctx, id, turnExecutionID, err.Error())
		return
	}

	e.mu.Lock()
	if e.activeRuns[id] != turnExecutionID {
		e.mu.Unlock()
		_ = h.Cancel()
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return
	}
	e.handles[id] = h
	// If cancel raced, signal now.
	if e.canceled[id] {
		e.mu.Unlock()
		_ = h.Cancel()
	} else {
		e.mu.Unlock()
	}

	e.runLoop(id, h, t.Agent, model, execRef, runMeta)
}

func (e *Engine) failStart(ctx context.Context, id, msg string) (store.Task, error) {
	return e.failStartWithExecution(ctx, id, "", msg, true)
}

func (e *Engine) failRunningStart(
	ctx context.Context, id, executionID, msg string,
) (store.Task, error) {
	return e.failStartWithExecution(ctx, id, executionID, msg, false)
}

func (e *Engine) failQueuedRunStart(
	ctx context.Context, id, executionID, msg string,
) (store.Task, error) {
	return e.failStartWithExecution(ctx, id, executionID, msg, true)
}

func (e *Engine) failStartWithExecution(
	ctx context.Context, id, executionID, msg string, allowQueued bool,
) (store.Task, error) {
	if executionID != "" && !e.isActiveRun(id, executionID) {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
		e.pump()
		return store.Task{}, store.ErrConflict
	}
	m := map[string]any{"message": msg}
	m = adapter.EnrichErrorPayload(m)
	payload, _ := json.Marshal(m)
	if w := e.eventWriter(); w != nil {
		ev, err := w.AppendEvent(ctx, id, "error", payload)
		if err == nil {
			e.bus.PublishEvent(ev)
		}
	}
	var (
		t   store.Task
		err error
	)
	if executionID == "" {
		t, err = e.finishQueued(ctx, id, StatusFailed, nil, nil)
	} else if allowQueued {
		t, err = e.finishQueuedRun(ctx, id, executionID, StatusFailed, nil, nil)
	} else {
		t, err = e.finishRun(ctx, id, executionID, StatusFailed, nil, nil)
	}
	if info, ok := adapter.DetectRateLimitPayload(payload); ok {
		agentID := ""
		if err == nil {
			agentID = t.Agent
		}
		e.handleNewLimitHit(ctx, id, agentID, info)
	}
	e.mu.Lock()
	e.active--
	if executionID == "" || e.activeRuns[id] == executionID {
		delete(e.handles, id)
	}
	e.mu.Unlock()
	e.pump()
	return t, err
}

func (e *Engine) runLoop(id string, h adapter.RunHandle, speaker, model string, exec adapter.ExecutionRef, runMeta adapter.RunMetadata) {
	ctx := context.Background()
	var sawResult bool
	var sawUsage bool
	var resultIsError bool
	if speaker == "" {
		speaker = "assistant"
	}

	for ev := range h.Events() {
		if !e.isActiveRun(id, exec.ID) {
			continue
		}
		// Persist first, then broadcast (spec §3). Stamp speaker for chat UI.
		payload := stampSpeaker(ev.Payload, speaker, model, exec)
		semantic, semanticErr := adapter.DecodeEvent(adapter.Event{Type: ev.Type, Payload: payload})
		// Steer interrupt aborts the in-flight turn with a cancel error; that is
		// expected and must not surface as a red "已取消" bubble while the new guide runs.
		if semanticErr == nil && semantic.Error != nil && semantic.Error.Canceled {
			e.mu.Lock()
			_, steer := e.pendingFollowUp[id]
			e.mu.Unlock()
			if steer {
				continue
			}
		}
		var (
			stored            store.Event
			updatedTask       *store.Task
			missingPriceModel string
			accountingFailed  bool
		)
		// Canonical usage events are incremental. A result is only an accounting
		// fallback for legacy adapters that emitted no usage event in this run.
		shouldAccount := ev.Type == "usage" ||
			(ev.Type == "result" && !sawUsage && semanticErr == nil &&
				semantic.Usage != nil && semantic.Usage.HasAccountingValues())
		w := e.eventWriter()
		if shouldAccount {
			record, usageErr := NormalizeUsage(speaker, model, payload)
			if usageErr != nil {
				accountingFailed = true
				e.noteRunPersistFailure(id, exec.ID, ev.Type, payload, usageErr)
			} else {
				missingPriceModel = e.populateEstimatedUsageCost(ctx, &record)
				if w == nil {
					accountingFailed = true
					e.noteRunPersistFailure(id, exec.ID, ev.Type, payload, fmt.Errorf("event writer unavailable"))
				} else {
					usageEvent, taskAfterUsage, appendErr := e.persistRunUsageEvent(
						ctx, id, exec.ID, ev.Type, payload, record,
					)
					if appendErr != nil {
						if errors.Is(appendErr, store.ErrConflict) {
							continue
						}
						accountingFailed = true
						e.noteRunPersistFailure(id, exec.ID, ev.Type, payload, appendErr)
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
				e.noteRunPersistFailure(id, exec.ID, ev.Type, payload, fmt.Errorf("event writer unavailable"))
				continue
			}
			var err error
			stored, err = e.persistRunEvent(ctx, id, exec.ID, ev.Type, payload)
			if err != nil {
				if errors.Is(err, store.ErrConflict) {
					continue
				}
				e.noteRunPersistFailure(id, exec.ID, ev.Type, payload, err)
				continue
			}
		}
		e.bus.PublishEvent(stored)
		// Fast-path: surface rate-limit cards as soon as the adapter reports them.
		if stored.Type == "error" || stored.Type == "result" {
			agentID := ""
			if t, err := e.store.GetTask(ctx, id); err == nil {
				agentID = t.Agent
			}
			e.maybeEmitLimitHit(ctx, id, agentID, stored.Payload, stored.Type)
		}
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
			if semanticErr == nil && semantic.SessionRef != "" {
				sid := semantic.SessionRef
				e.mu.Lock()
				if e.activeRuns[id] == exec.ID {
					_ = e.store.UpdateTask(ctx, id, store.TaskPatch{SessionRef: &sid})
				}
				e.mu.Unlock()
				if t, err := e.store.GetTask(ctx, id); err == nil {
					e.bus.PublishTask(t)
				}
			}
		case "result":
			sawResult = true
			if semanticErr != nil || semantic.Result == nil {
				resultIsError = true
				break
			}
			resultIsError = semantic.Result.IsError
			if semantic.SessionRef != "" {
				sid := semantic.SessionRef
				e.mu.Lock()
				if e.activeRuns[id] == exec.ID {
					_ = e.store.UpdateTask(ctx, id, store.TaskPatch{SessionRef: &sid})
				}
				e.mu.Unlock()
			}
		}
	}

	// Process exited.
	e.mu.Lock()
	currentRun := e.activeRuns[id] == exec.ID
	if currentRun {
		e.workspaceCommitting[id] = exec.ID
	}
	wasCanceled := e.canceled[id]
	pf, hasFollowUp := e.pendingFollowUp[id]
	if currentRun {
		delete(e.handles, id)
		delete(e.canceled, id)
		delete(e.pendingFollowUp, id)
	}
	e.active--
	e.mu.Unlock()
	if !currentRun {
		e.pump()
		return
	}
	defer e.clearWorkspaceCompletion(id, exec.ID)
	defer e.clearActiveRun(id, exec.ID)
	workspaceStatus, workspaceErr, workspaceFinalized := e.finalizeRequestedWorkspace(ctx, id)

	// Interrupted with a steerable follow-up: re-queue instead of staying canceled.
	if hasFollowUp {
		if workspaceErr != nil {
			payload, _ := json.Marshal(map[string]string{
				"message": "workspace finalization failed before follow-up: " + workspaceErr.Error(),
			})
			if ev, err := e.persistRunEvent(ctx, id, exec.ID, "error", payload); err == nil {
				e.bus.PublishEvent(ev)
			}
			_, _ = e.finishRun(ctx, id, exec.ID, StatusFailed, nil, nil)
			e.pump()
			return
		}
		if _, err := e.applyPendingFollowUp(ctx, id, pf); err != nil {
			payload, _ := json.Marshal(map[string]string{"message": "follow-up after interrupt failed: " + err.Error()})
			if ev, err := e.store.AppendEvent(ctx, id, "error", payload); err == nil {
				e.bus.PublishEvent(ev)
			}
			_, _ = e.finishRun(ctx, id, exec.ID, StatusFailed, nil, nil)
		} else {
			e.clearActiveRun(id, exec.ID)
		}
		e.pump()
		return
	}

	// Lazy promotion: if a read-only turn created a ready workspace, re-queue
	// without adding a duplicate user event so the next run starts writable.
	if runMeta.WorkspaceAccess == adapter.AccessSourceReadOnly && !wasCanceled && !hasFollowUp {
		ws, wsErr := e.store.GetCurrentWorkspace(ctx, id)
		if wsErr == nil && ws.State == store.WorkspaceReady {
			// Re-queue: set status back to queued so pump picks it up.
			status := StatusQueued
			patch := store.TaskPatch{Status: &status, ClearExitCode: true, ClearFinishedAt: true}
			_ = e.store.UpdateTask(ctx, id, patch)
			e.mu.Lock()
			e.queue = append(e.queue, id)
			e.mu.Unlock()
			e.pump()
			return
		}
	}

	// Re-read status: Cancel may have already set canceled.
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		e.pump()
		return
	}
	if t.Status == StatusCanceled || wasCanceled {
		if t.Status != StatusCanceled {
			_, _ = e.finishRun(ctx, id, exec.ID, StatusCanceled, nil, nil)
		} else if t.FinishedAt == nil {
			now := store.NowMilli()
			_ = e.store.UpdateTask(ctx, id, store.TaskPatch{FinishedAt: &now})
		}
		e.clearActiveRun(id, exec.ID)
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
	// Surface rate-limit cards before finishing so UI sees them with the failed status.
	agentID := ""
	if t, err := e.store.GetTask(ctx, id); err == nil {
		agentID = t.Agent
	}
	if final == StatusFailed {
		e.scanAndEmitLimitHit(ctx, id, agentID)
	}
	e.clearPersistTracking(id)

	if workspaceFinalized {
		if workspaceErr != nil {
			payload, _ := json.Marshal(map[string]string{
				"message": "workspace finalization failed: " + workspaceErr.Error(),
			})
			if ev, err := e.persistRunEvent(ctx, id, exec.ID, "error", payload); err == nil {
				e.bus.PublishEvent(ev)
			}
			final = StatusFailed
		} else if workspaceStatus != StatusSucceeded {
			final = workspaceStatus
		}
	}

	_, _ = e.finishRun(ctx, id, exec.ID, final, exitCode, nil)
	e.clearWorkspaceCompletion(id, exec.ID)
	// After failed finish, apply default wait/switch policy on the open limit card.
	if final == StatusFailed {
		if info, _, ok := e.latestOpenLimitHit(ctx, id); ok {
			e.applyLimitPolicy(ctx, id, agentID, info)
		}
	}
	e.pump()
}

func (e *Engine) finalizeRequestedWorkspace(
	ctx context.Context,
	taskID string,
) (status string, err error, finalized bool) {
	if e.workspace == nil {
		return "", nil, false
	}
	ws, err := e.store.GetCurrentWorkspace(ctx, taskID)
	if errors.Is(err, store.ErrNotFound) {
		return "", nil, false
	}
	if err != nil {
		return StatusFailed, err, true
	}
	if ws.State != store.WorkspaceFinalizing {
		return "", nil, false
	}
	status, err = e.finalizeWorkspace(ctx, taskID)
	return status, err, true
}

func (e *Engine) clearWorkspaceCompletion(taskID, executionID string) {
	e.mu.Lock()
	if e.workspaceCommitting[taskID] == executionID {
		delete(e.workspaceCommitting, taskID)
	}
	e.mu.Unlock()
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
	return e.finishTask(ctx, id, status, exitCode, cost, false)
}

func (e *Engine) finishQueued(ctx context.Context, id, status string, exitCode *int, cost *float64) (store.Task, error) {
	return e.finishTask(ctx, id, status, exitCode, cost, true)
}

func (e *Engine) finishTask(
	ctx context.Context,
	id, status string,
	exitCode *int,
	cost *float64,
	allowQueued bool,
) (store.Task, error) {
	now := e.nowMilli()
	if err := e.store.FinishTask(ctx, id, status, now, exitCode, cost, allowQueued); err != nil {
		return store.Task{}, err
	}
	return e.publishFinishedTask(ctx, id, status)
}

func (e *Engine) publishFinishedTask(ctx context.Context, id, status string) (store.Task, error) {
	t, err := e.store.GetTask(ctx, id)
	if err != nil {
		return store.Task{}, err
	}
	e.bus.PublishTask(t)
	// Terminal statuses: succeeded | failed | canceled (spec §8).
	if t.RoutineID != "" {
		// Routines own their notify path (noteworthy / circuit-breaker only).
		e.onRoutineTerminal(ctx, t, status)
	} else if e.notify != nil && (status == StatusSucceeded || status == StatusFailed || status == StatusCanceled) {
		e.notify.NotifyTaskTerminal(ctx, t.ID, t.Title, status)
	}
	return t, nil
}

func (e *Engine) finishRun(
	ctx context.Context,
	id, executionID, status string,
	exitCode *int,
	cost *float64,
) (store.Task, error) {
	e.mu.Lock()
	if e.activeRuns[id] != executionID {
		e.mu.Unlock()
		return store.Task{}, store.ErrConflict
	}
	now := e.nowMilli()
	err := e.store.FinishTask(ctx, id, status, now, exitCode, cost, false)
	if err == nil && e.activeRuns[id] == executionID {
		delete(e.activeRuns, id)
	}
	e.mu.Unlock()
	if err != nil {
		return store.Task{}, err
	}
	return e.publishFinishedTask(ctx, id, status)
}

func (e *Engine) finishQueuedRun(
	ctx context.Context,
	id, executionID, status string,
	exitCode *int,
	cost *float64,
) (store.Task, error) {
	e.mu.Lock()
	if e.activeRuns[id] != executionID {
		e.mu.Unlock()
		return store.Task{}, store.ErrConflict
	}
	now := e.nowMilli()
	err := e.store.FinishTask(ctx, id, status, now, exitCode, cost, true)
	if err == nil && e.activeRuns[id] == executionID {
		delete(e.activeRuns, id)
	}
	e.mu.Unlock()
	if err != nil {
		return store.Task{}, err
	}
	return e.publishFinishedTask(ctx, id, status)
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
		Generation: 1,
		SourceRoot: t.WorkspaceSourceRoot,
		Root:       t.WorkspaceRoot,
		Cwd:        t.ExecutionCwd,
		Scope:      t.WorkspaceScope,
		BaseOID:    t.WorkspaceBaseOID,
		Branch:     t.WorkspaceBranch,
	}
}

func workspaceGenerationMetadata(ws store.WorkspaceGeneration) workspace.Metadata {
	return workspace.Metadata{
		Mode:         workspace.ResolvedWorktree,
		Generation:   ws.Generation,
		SourceRoot:   ws.SourceRoot,
		Root:         ws.PhysicalRoot,
		Cwd:          ws.ExecutionCwd,
		Scope:        ws.Scope,
		BaseOID:      ws.BaseOID,
		Branch:       ws.WorkspaceBranch,
		TargetBranch: ws.TargetBranch,
	}
}

func (e *Engine) claimCurrentWorkspaceExecution(
	ctx context.Context, taskID, executionID string,
) error {
	if e.workspace == nil {
		return nil
	}
	ws, err := e.store.GetCurrentWorkspace(ctx, taskID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	unlock := lockWorkspaceGeneration(e.workspace, workspaceGenerationMetadata(ws))
	defer unlock()
	return e.store.ClaimWorkspaceExecution(ctx, ws.ID, taskID, executionID)
}

func (e *Engine) workspaceMetadataForCheckpoint(
	ctx context.Context,
	task store.Task,
	checkpoint store.TaskCheckpoint,
) (workspace.Metadata, error) {
	if checkpoint.WorkspaceID == "" {
		return workspaceMetadata(task), nil
	}
	generation, err := e.store.GetWorkspace(ctx, checkpoint.WorkspaceID)
	if err != nil {
		return workspace.Metadata{}, fmt.Errorf("get checkpoint workspace: %w", err)
	}
	if generation.TaskID != task.ID {
		return workspace.Metadata{}, fmt.Errorf("checkpoint workspace does not belong to task")
	}
	return workspaceGenerationMetadata(generation), nil
}

type checkpointRestoreTarget struct {
	taskID      string
	meta        workspace.Metadata
	workspace   store.WorkspaceGeneration
	generation  *store.WorkspaceGeneration
	workspaceID string
	activate    bool
	unlock      func()
}

func (target checkpointRestoreTarget) generationValue() store.WorkspaceGeneration {
	if target.generation != nil {
		return *target.generation
	}
	return target.workspace
}

func (e *Engine) planRetryRestore(
	ctx context.Context, task store.Task,
) (checkpointRestoreTarget, store.TaskCheckpoint, func(), error) {
	if current, err := e.store.GetCurrentWorkspace(ctx, task.ID); err == nil {
		meta := workspaceGenerationMetadata(current)
		unlock := lockWorkspaceGeneration(e.workspace, meta)
		refreshed, refreshErr := e.store.GetWorkspace(ctx, current.ID)
		if refreshErr != nil {
			unlock()
			return checkpointRestoreTarget{}, store.TaskCheckpoint{}, func() {}, refreshErr
		}
		switch refreshed.State {
		case store.WorkspaceReady, store.WorkspaceActive,
			store.WorkspaceMergeBlocked, store.WorkspaceFinalizeBlocked:
		default:
			unlock()
			return checkpointRestoreTarget{}, store.TaskCheckpoint{}, func() {}, fmt.Errorf(
				"workspace %s is in state %s and cannot be restored",
				refreshed.ID, refreshed.State,
			)
		}
		meta = workspaceGenerationMetadata(refreshed)
		rollback, captureErr := e.workspace.CapturePrepared(ctx, meta, task.ID)
		if captureErr != nil {
			unlock()
			return checkpointRestoreTarget{}, store.TaskCheckpoint{}, func() {},
				fmt.Errorf("capture retry rollback: %w", captureErr)
		}
		return checkpointRestoreTarget{
			taskID: task.ID, meta: meta, workspace: refreshed,
			workspaceID: refreshed.ID, activate: refreshed.State != store.WorkspaceActive,
			unlock: unlock,
		}, storeCheckpoint(rollback), unlock, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return checkpointRestoreTarget{}, store.TaskCheckpoint{}, func() {}, err
	}

	source, err := e.workspace.ResolveSource(ctx, task.Cwd)
	if err != nil {
		return checkpointRestoreTarget{}, store.TaskCheckpoint{}, func() {}, err
	}
	generations, err := e.store.ListTaskWorkspaces(ctx, task.ID)
	if err != nil {
		return checkpointRestoreTarget{}, store.TaskCheckpoint{}, func() {}, err
	}
	nextGeneration := 1
	for _, generation := range generations {
		if generation.Generation >= nextGeneration {
			nextGeneration = generation.Generation + 1
		}
	}
	now := store.NowMilli()
	generation := store.WorkspaceGeneration{
		ID: fmt.Sprintf("%s:g%d", task.ID, nextGeneration), TaskID: task.ID,
		Generation: nextGeneration, State: store.WorkspaceProvisioning,
		SourceRoot: source.SourceRoot, Scope: source.Scope,
		TargetBranch: source.TargetBranch, BaseOID: source.HeadOID,
		CreatedAt: now, UpdatedAt: now,
	}
	return checkpointRestoreTarget{
		taskID: task.ID, generation: &generation, workspaceID: generation.ID,
		unlock: func() {},
	}, store.TaskCheckpoint{}, func() {}, nil
}

func (e *Engine) resolveRetryRestoreIntent(
	ctx context.Context, intent store.RetryRestoreIntent, alreadyLocked bool,
) (store.RetryMutationResult, bool, error) {
	target := intent.Target
	if intent.TargetIsNew && target.PhysicalRoot == "" {
		meta, err := e.workspace.PrepareGeneration(ctx, intent.TaskID, target.Generation, workspace.SourceMetadata{
			Cwd: target.SourceRoot, SourceRoot: target.SourceRoot, Scope: target.Scope,
			TargetBranch: target.TargetBranch, HeadOID: target.BaseOID,
		})
		if err != nil {
			if meta.Root != "" {
				target.WorkspaceBranch = meta.Branch
				target.PhysicalRoot = meta.Root
				target.ExecutionCwd = meta.Cwd
			}
			return e.compensateRetryRestore(intent, target, fmt.Errorf("prepare retry generation: %w", err))
		}
		target.SourceRoot = meta.SourceRoot
		target.Scope = meta.Scope
		target.TargetBranch = meta.TargetBranch
		target.WorkspaceBranch = meta.Branch
		target.PhysicalRoot = meta.Root
		target.ExecutionCwd = meta.Cwd
		target.BaseOID = meta.BaseOID
		if err := e.store.MarkRetryRestoreTargetPrepared(ctx, intent.TaskID, target); err != nil {
			return e.compensateRetryRestore(intent, target, fmt.Errorf("persist retry generation: %w", err))
		}
		intent.Target = target
	}
	if !intent.RestoreFiles {
		result, err := e.store.CompleteRetryRestore(ctx, intent.TaskID)
		if err != nil {
			return e.compensateRetryRestore(intent, target, fmt.Errorf("complete retry: %w", err))
		}
		return result, false, nil
	}

	meta := workspaceGenerationMetadata(target)
	unlock := func() {}
	if !alreadyLocked {
		unlock = lockWorkspaceGeneration(e.workspace, meta)
	}
	defer unlock()
	restoreTarget := checkpointRestoreTarget{
		taskID: intent.TaskID, meta: meta, workspace: target,
		workspaceID: target.ID, activate: intent.ActivateTarget,
	}
	if intent.TargetIsNew {
		restoreTarget.generation = &target
	}
	if err := e.restoreCheckpointIntoTarget(ctx, intent.TaskID, restoreTarget, intent.Checkpoint); err != nil {
		return e.compensateRetryRestore(intent, target, fmt.Errorf("restore retry checkpoint: %w", err))
	}
	result, err := e.store.CompleteRetryRestore(ctx, intent.TaskID)
	if err != nil {
		return e.compensateRetryRestore(intent, target, fmt.Errorf("complete retry restore: %w", err))
	}
	return result, false, nil
}

func (e *Engine) compensateRetryRestore(
	intent store.RetryRestoreIntent,
	target store.WorkspaceGeneration,
	cause error,
) (store.RetryMutationResult, bool, error) {
	rollbackCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	meta := workspaceGenerationMetadata(target)
	var compensationErr error
	if !intent.RestoreFiles && !intent.TargetIsNew {
		compensationErr = e.store.AbortRetryRestore(rollbackCtx, intent.TaskID)
	} else if intent.TargetIsNew {
		if target.PhysicalRoot != "" {
			compensationErr = e.workspace.CleanupPrepared(rollbackCtx, intent.TaskID, meta)
		}
	} else {
		compensationErr = e.workspace.Restore(
			rollbackCtx, meta, intent.TaskID, runtimeCheckpoint(intent.RollbackCheckpoint),
		)
	}
	if compensationErr == nil && (intent.RestoreFiles || intent.TargetIsNew) {
		compensationErr = e.store.AbortRetryRestore(rollbackCtx, intent.TaskID)
	}
	if compensationErr != nil {
		return store.RetryMutationResult{}, false,
			fmt.Errorf("%v; compensation failed: %w", cause, compensationErr)
	}
	return store.RetryMutationResult{}, true, cause
}

func (e *Engine) recoverRetryRestores(ctx context.Context) error {
	e.retryMu.Lock()
	defer e.retryMu.Unlock()
	intents, err := e.store.ListRetryRestoreIntents(ctx)
	if err != nil {
		return err
	}
	for _, intent := range intents {
		task, taskErr := e.store.GetTask(ctx, intent.TaskID)
		if taskErr != nil {
			return fmt.Errorf("task %s: %w", intent.TaskID, taskErr)
		}
		if task.EventEpoch == intent.ExpectedEventEpoch+1 {
			switch task.Status {
			case StatusQueued:
				if err := e.resetAgentSessionStrict(ctx, task.Agent, task.ID); err != nil {
					return fmt.Errorf("reset recovered retry session for task %s: %w", task.ID, err)
				}
				if !intent.RestoreFiles &&
					task.WorkspaceMode == string(workspace.ResolvedWorktree) {
					e.captureCheckpoint(ctx, task, intent.FromSeq)
				}
				e.mu.Lock()
				e.queue = append(e.queue, task.ID)
				e.mu.Unlock()
			default:
				if err := e.store.DeleteRetryRestoreIntent(ctx, task.ID); err != nil {
					return fmt.Errorf("clear consumed retry intent for task %s: %w", task.ID, err)
				}
			}
			continue
		}
		if task.EventEpoch != intent.ExpectedEventEpoch || task.Status != StatusRetrying {
			return fmt.Errorf(
				"task %s retry intent does not match status %s epoch %d",
				task.ID, task.Status, task.EventEpoch,
			)
		}
		result, compensated, err := e.resolveRetryRestoreIntent(ctx, intent, false)
		if err != nil && !compensated {
			return fmt.Errorf("task %s: %w", intent.TaskID, err)
		}
		if compensated {
			continue
		}
		if err := e.publishCompletedRetry(
			ctx,
			result,
			!intent.RestoreFiles &&
				result.Task.WorkspaceMode == string(workspace.ResolvedWorktree),
			false,
		); err != nil {
			return fmt.Errorf("resume retry task %s: %w", intent.TaskID, err)
		}
	}
	return nil
}

func (e *Engine) prepareCheckpointRestoreTarget(
	ctx context.Context,
	task store.Task,
	checkpoint store.TaskCheckpoint,
) (checkpointRestoreTarget, error) {
	if current, err := e.store.GetCurrentWorkspace(ctx, task.ID); err == nil {
		meta := workspaceGenerationMetadata(current)
		unlock := lockWorkspaceGeneration(e.workspace, meta)
		refreshed, refreshErr := e.store.GetWorkspace(ctx, current.ID)
		if refreshErr != nil {
			unlock()
			return checkpointRestoreTarget{}, refreshErr
		}
		switch refreshed.State {
		case store.WorkspaceReady:
			meta = workspaceGenerationMetadata(refreshed)
		case store.WorkspaceActive, store.WorkspaceMergeBlocked, store.WorkspaceFinalizeBlocked:
			// Writable target.
		default:
			unlock()
			return checkpointRestoreTarget{}, fmt.Errorf(
				"workspace %s is in state %s and cannot be restored",
				refreshed.ID,
				refreshed.State,
			)
		}
		return checkpointRestoreTarget{
			taskID: task.ID, meta: meta, workspace: refreshed, workspaceID: refreshed.ID,
			activate: refreshed.State != store.WorkspaceActive, unlock: unlock,
		}, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return checkpointRestoreTarget{}, err
	}

	source, err := e.workspace.ResolveSource(ctx, task.Cwd)
	if err != nil {
		return checkpointRestoreTarget{}, err
	}
	generations, err := e.store.ListTaskWorkspaces(ctx, task.ID)
	if err != nil {
		return checkpointRestoreTarget{}, err
	}
	nextGeneration := 1
	for _, generation := range generations {
		if generation.Generation >= nextGeneration {
			nextGeneration = generation.Generation + 1
		}
	}
	meta, err := e.workspace.PrepareGeneration(ctx, task.ID, nextGeneration, source)
	if err != nil {
		return checkpointRestoreTarget{}, err
	}
	unlock := lockWorkspaceGeneration(e.workspace, meta)
	now := store.NowMilli()
	generation := store.WorkspaceGeneration{
		ID:                    fmt.Sprintf("%s:g%d", task.ID, nextGeneration),
		TaskID:                task.ID,
		Generation:            nextGeneration,
		State:                 store.WorkspaceActive,
		SourceRoot:            source.SourceRoot,
		Scope:                 source.Scope,
		TargetBranch:          source.TargetBranch,
		WorkspaceBranch:       meta.Branch,
		PhysicalRoot:          meta.Root,
		ExecutionCwd:          meta.Cwd,
		BaseOID:               source.HeadOID,
		RequestedUserEventSeq: checkpoint.EventSeq,
		CreatedAt:             now,
		UpdatedAt:             now,
	}
	return checkpointRestoreTarget{
		taskID: task.ID, meta: meta, workspace: generation, generation: &generation,
		workspaceID: generation.ID, unlock: unlock,
	}, nil
}

func (e *Engine) commitCheckpointRestoreTarget(
	ctx context.Context,
	target checkpointRestoreTarget,
) error {
	if target.generation == nil {
		if !target.activate {
			return nil
		}
		empty := ""
		_, err := e.transitionWorkspace(ctx, store.WorkspaceTransition{
			WorkspaceID: target.workspaceID,
			TaskID:      target.taskID,
			FromStates: []store.WorkspaceState{
				store.WorkspaceReady,
				store.WorkspaceMergeBlocked,
				store.WorkspaceFinalizeBlocked,
			},
			ToState: store.WorkspaceActive,
			Patch: store.WorkspacePatch{
				ReviewBaseOID:        &empty,
				FinalHeadOID:         &empty,
				FinalTreeOID:         &empty,
				IntegratedOID:        &empty,
				CompletedExecutionID: &empty,
				FailureReason:        &empty,
			},
		})
		return err
	}
	ev, err := e.store.InsertWorkspaceAsCurrent(ctx, *target.generation)
	if err != nil {
		return err
	}
	e.bus.PublishEvent(ev)
	return nil
}

func (e *Engine) restoreCheckpointIntoTarget(
	ctx context.Context,
	taskID string,
	target checkpointRestoreTarget,
	checkpoint store.TaskCheckpoint,
) error {
	if target.generation != nil ||
		(checkpoint.WorkspaceID != "" && checkpoint.WorkspaceID != target.workspaceID) {
		return e.workspace.RestoreTreeOntoCurrent(
			ctx,
			target.meta,
			taskID,
			runtimeCheckpoint(checkpoint),
		)
	}
	return e.workspace.Restore(ctx, target.meta, taskID, runtimeCheckpoint(checkpoint))
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
	meta := workspaceMetadata(t)
	workspaceID := ""
	if ws, getErr := e.store.GetCurrentWorkspace(ctx, t.ID); getErr == nil {
		meta = workspaceGenerationMetadata(ws)
		workspaceID = ws.ID
	}
	cp, err := e.workspace.Capture(ctx, meta, t.ID, userSeq)
	if err == nil {
		stored := storeCheckpoint(cp)
		stored.WorkspaceID = workspaceID
		if putErr := e.store.PutCheckpoint(ctx, stored); putErr != nil {
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

// errorPayloadIsCancel reports whether an adapter error payload is a benign
// abort/cancel token (steer interrupt, user stop) rather than a real failure.
func errorPayloadIsCancel(payload json.RawMessage) bool {
	semantic, err := adapter.DecodeEvent(adapter.Event{Type: "error", Payload: payload})
	return err == nil && semantic.Error != nil && semantic.Error.Canceled
}
