# Pluggable Agent Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `kin`, `claude-code`, `codex`, and future agents interchangeable first-class plugins, with no Kin-specific behavior in the task engine, orchestration coordinator, API, or UI.

**Architecture:** Keep `task.Engine` as the trusted execution kernel. Introduce an `internal/agent` registry that owns plugin metadata, readiness, run adapters, safe control-plane completion, and session lifecycle hooks. The task's selected `agent` is its user-facing host; the host may refine an explicit delegation plan and synthesize worker results, while the engine remains authoritative for validation, scheduling, cancellation, permissions, events, and persistence.

**Tech Stack:** Go 1.26, SQLite, existing `adapter.Adapter` process abstraction, React 18, TypeScript 5, Vite.

---

## 1. Decision

This refactor is feasible and should be implemented. The target is a **compiled plugin architecture**, not Go `.so` runtime loading and not arbitrary third-party executables loaded from disk.

After the refactor:

- Kin is one plugin, not a special engine identity.
- Claude Code and Codex can be selected as the session host in exactly the same way as Kin.
- Explicit `@agent` mentions identify workers. They do not silently replace the host.
- The selected host may perform control-plane planning and final synthesis when it declares `orchestrate` capability.
- An agent without `orchestrate` capability still works as a normal host; multi-agent turns use deterministic planning and summary fallback.
- The engine, not the host model, owns process creation, allowed agents, dependencies, concurrency, cancellation, approval policy, persistence, and terminal status.
- Adding an agent requires a new plugin factory and one bootstrap registration line. It must not require edits to engine selection logic, orchestration identity checks, API response construction, or UI speaker whitelists.

The first production version should not support hot-loading plugins, model-directed arbitrary agent spawning, cross-machine agent execution, or lossless hot-switching of an in-flight session.

## 2. Why the current code is not yet pluggable

The current adapter abstraction is useful but only covers process startup. Identity, capability, selection, orchestration, session behavior, and presentation remain distributed across hard-coded branches.

| Coupling | Current location | Consequence |
|---|---|---|
| Engine stores `map[string]adapter.Adapter` | `internal/task/engine.go` | No metadata, readiness, capability, or lifecycle contract |
| Default order is a literal ID list | `internal/task/engine.go` (`DefaultAgent`) | Adding an agent requires engine edits |
| Kin is forced as `MainAgent` when registered | `internal/task/orchestrate.go` | Selected Claude/Codex cannot truly replace Kin as host |
| Chat-host detection checks literal IDs | `internal/task/orchestrate.go` (`isChatHost`) | Behavior derives from names instead of capabilities |
| Follow-up context checks `targetAgent == "kin"` | `internal/task/approvals.go` | Kin transcript semantics leak into the engine |
| Engine imports Claude/Codex/Grok parsers | `internal/task/engine.go` | Normalized event contract is incomplete |
| Server constructs adapters with a switch | `internal/server/server.go` | Discovery and construction are centralized |
| API builds Kin separately | `internal/server/server.go`, `internal/api/api.go` | Agent availability has two sources of truth |
| Orchestrator retry emits speaker `kin` | `internal/task/orchestrate.go` | UI identity is wrong for a non-Kin host |
| User visibility uses `agent == "kin"` | `internal/task/orchestrate.go` | A Claude/Codex host can be hidden as a worker |
| UI whitelists known IDs and maps orchestrator to Kin | `ui/src/components/chat/ChatStream.tsx` | New plugins render incorrectly |
| UI labels Kin as main and all others as workers | `ui/src/pages/NewChatPage.tsx` | Product model contradicts interchangeability |

The existing `kin_messages` table is not itself a blocker. It can remain private storage owned by the Kin plugin in this refactor. The blocker is that task code knows when and how to clear it.

## 3. Requirements

### 3.1 Functional requirements

1. Every agent has a descriptor, readiness resolver, run adapter, declared capabilities, priority, and optional control/session hooks.
2. The registry is the only source of truth for available agents and their metadata.
3. The configured default (`agent.default`) wins when ready; otherwise the registry chooses the lowest-priority ready plugin.
4. `tasks.agent` means **session host** for both single-agent and multi-agent turns.
5. Creating or following up a multi-agent task must not rewrite `tasks.agent` to Kin or any other implicit host.
6. Any host can emit user-facing orchestration plan, progress, and summary events under its own speaker ID.
7. A host with `orchestrate` capability may refine dependencies/briefs and synthesize results through a read-only control-plane call.
8. A host model cannot add workers, remove explicitly requested workers, change permissions, change working directory, or directly launch processes.
9. If host planning or synthesis fails, the deterministic implementation must complete the turn when workers themselves can still run.
10. Same-agent resume and cross-agent handoff must be determined by declared capabilities and lifecycle hooks, never by literal agent IDs.
11. Engine event parsing must use canonical adapter event types and must not import concrete adapter packages.
12. API and UI must render unknown future agent IDs without code changes.

### 3.2 Non-functional requirements

- Existing single-agent tasks, follow-ups, cancellation, approvals, usage accounting, and stored events remain compatible.
- No database migration is required for the initial refactor.
- Agent readiness changes from Settings must be visible without daemon restart where technically possible (Kin/provider); CLI PATH discovery may still require restart.
- Control-plane calls are read-only, time-bounded, cancellation-aware, and limited in prompt size.
- Invalid model output falls back safely; it never corrupts task state.
- Existing event rows remain readable through UI compatibility fallbacks.
- Registry order and API output are deterministic.

### 3.3 Non-goals

- Dynamic Go plugins or third-party binary plugin protocol.
- Implicit autonomous delegation for prompts with no `@agent` mention.
- A host autonomously retrying workers, expanding scope, or changing the task graph.
- Persisting an orchestration graph as new relational tables.
- Renaming `tasks.agent`, `kin_messages`, or historical event payloads.
- Making Grok a model-driven orchestrator in the first release.

## 4. Target architecture

```text
HTTP / UI
   │  create/follow-up (host agent + prompt)
   ▼
task.Engine ──────────────── trusted lifecycle/state machine
   │
   ├── agent.Registry ───── descriptor, status, capabilities, priority
   │      ├── kin plugin ───────── Runner + Controller + SessionHooks
   │      ├── claude-code plugin ─ Runner + Controller
   │      ├── codex plugin ─────── Runner + Controller
   │      └── grok plugin ──────── Runner only (initially)
   │
   └── orchestration coordinator
          ├── parse explicit @workers deterministically
          ├── optionally ask selected host Controller to refine safe fields
          ├── validate immutable worker assignments
          ├── schedule workers through their Runner adapters
          ├── collect normalized results
          └── ask host Controller to synthesize, or deterministic fallback
```

The boundary is intentionally asymmetric:

- `Runner` is data-plane execution and may use tools according to the task permission mode.
- `Controller` is control-plane completion and must be read-only. It may propose a plan or write a summary, but cannot execute task tools through the engine.
- `task.Engine` is the authority. Models return proposals; the engine validates and executes.

## 5. Core contracts

Create `internal/agent/types.go` with these contracts. Names may be adjusted for Go style, but the semantics must remain unchanged.

```go
package agent

import (
    "context"
    "time"

    "github.com/vuuihc/kin/internal/adapter"
)

type Capability string

const (
    CapabilityRun         Capability = "run"
    CapabilityResume      Capability = "resume"
    CapabilityTools       Capability = "tools"
    CapabilityApprovals   Capability = "approvals"
    CapabilityOrchestrate Capability = "orchestrate"
)

type Kind string

const (
    KindBuiltin Kind = "builtin"
    KindCLI     Kind = "cli"
)

type Descriptor struct {
    ID           string       `json:"id"`
    Name         string       `json:"name"`
    Kind         Kind         `json:"kind"`
    Priority     int          `json:"-"`
    Capabilities []Capability `json:"capabilities"`
}

func (d Descriptor) Has(cap Capability) bool {
    for _, got := range d.Capabilities {
        if got == cap {
            return true
        }
    }
    return false
}

type Status struct {
    Installed bool   `json:"installed"`
    Available bool   `json:"available"`
    Reason    string `json:"reason,omitempty"`
    Binary    string `json:"binary,omitempty"`
}

type ControlPurpose string

const (
    ControlPlan      ControlPurpose = "orchestration_plan"
    ControlSynthesis ControlPurpose = "orchestration_synthesis"
)

type ControlRequest struct {
    TaskID  string
    Cwd     string
    Model   string
    Purpose ControlPurpose
    Prompt  string
    Timeout time.Duration
}

type ControlUsage struct {
    Model        string
    TokensIn     int
    TokensOut    int
    CachedTokens int
    CostUSD      *float64
}

type ControlResult struct {
    Text  string
    Usage ControlUsage
}

type Controller interface {
    Complete(ctx context.Context, req ControlRequest) (ControlResult, error)
}

type SessionHooks interface {
    Reset(ctx context.Context, taskID string) error
}

type Registration struct {
    Descriptor Descriptor
    Runner     adapter.Adapter
    Controller Controller
    Sessions   SessionHooks
    Status     func(context.Context) Status
}

type Factory interface {
    Descriptor() Descriptor
    Open(ctx context.Context) (Registration, error)
}
```

Validation rules in `internal/agent/registry.go`:

- IDs match `^[a-z][a-z0-9-]*$`.
- IDs are unique.
- names are non-empty.
- priority is non-negative.
- `run` requires a non-nil `Runner` when available.
- `orchestrate` requires a non-nil `Controller`.
- a nil `Status` is a registration error.
- capability slices are de-duplicated and returned in stable order.
- `Registry.Default(ctx, configuredID)` selects the configured ready agent first, then the ready agent with lowest `(Priority, ID)`.
- `Registry.GetRunnable(ctx, id)` rejects unknown, unavailable, and runner-less plugins with distinct errors.

The registry should expose:

```go
type Registry struct { /* private, immutable registrations */ }

func Build(ctx context.Context, factories ...Factory) (*Registry, error)
func (r *Registry) List(ctx context.Context, configuredDefault string) []Info
func (r *Registry) Get(id string) (Registration, bool)
func (r *Registry) GetRunnable(ctx context.Context, id string) (Registration, error)
func (r *Registry) Default(ctx context.Context, configuredID string) string
func (r *Registry) ResetSession(ctx context.Context, id, taskID string) error
```

`Info` is the API-safe combination of descriptor, status, and `Default`. Do not keep a duplicate `api.AgentInfo` type.

## 6. Plugin factories

Each concrete adapter package owns its discovery, construction, descriptor, readiness, and optional controller. `internal/server` only supplies dependencies and lists factories.

### 6.1 Kin

Add `internal/adapter/kinagent/plugin.go` and `controller.go`.

- Descriptor: `ID=kin`, `Kind=builtin`, priority `10`.
- Capabilities: `run`, `resume`, `tools`, `orchestrate`.
- Status dynamically reloads provider config; `Available` is true only when `base_url` and `model` are configured.
- Runner remains the current native loop.
- Controller calls the configured provider with no tools and a fixed control-plane system prompt.
- Session hook delegates to `StoreTranscript.Clear`, which wraps `store.ClearKinMessages`.
- The current `kin_messages` table and `StoreTranscript` implementation remain Kin-private.

The controller must not call `runAgentLoop`; it calls `provider.Client.Chat` directly with no `Tools` field.

### 6.2 Claude Code

Add `internal/adapter/claudecode/plugin.go` and `controller.go`.

- Descriptor: priority `20`; capabilities `run`, `resume`, `tools`, `approvals`, `orchestrate`.
- Factory resolves `KIN_CLAUDE_BIN` then `claude` on PATH.
- Runner is configured with daemon URL and rotating token exactly as today.
- Controller executes a one-turn, read-only process with a timeout and captures only the terminal answer.
- The initial command contract, verified against locally installed Claude Code `2.1.169`, is:

```text
claude -p <prompt> --output-format json --permission-mode plan --tools "" --no-session-persistence --safe-mode [--model <model>]
```

Before merging, verify these flags against the project's minimum supported Claude Code version. If `plan`, empty `--tools`, or the other isolation flags are unavailable on that version, do not silently run in write-capable mode: omit `orchestrate` capability and use deterministic fallback until a read-only command is available.

### 6.3 Codex

Add `internal/adapter/codex/plugin.go` and `controller.go`.

- Descriptor: priority `30`; capabilities `run`, `resume`, `tools`, `orchestrate`.
- Factory resolves `KIN_CODEX_BIN` then `codex` on PATH.
- Controller runs in read-only sandbox and parses the terminal answer from JSON events.
- Command contract, verified against locally installed Codex CLI `0.144.5`:

```text
codex exec --json --sandbox read-only --ephemeral --ignore-rules <prompt> [--model <model>]
```

The controller must not use `--dangerously-bypass-approvals-and-sandbox`, even if the parent task is in YOLO mode. Control calls never inherit the task permission mode.

### 6.4 Grok and raw PTY

- Grok initially declares `run`, `resume`, and `tools`; it has no Controller and no `orchestrate` capability.
- Raw PTY remains opt-in and declares only capabilities it can actually guarantee.
- A Grok/rawpty host can still run an explicit multi-agent turn using deterministic plan and summary fallback.

### 6.5 Bootstrap

Move adapter assembly out of `ServeWith` into `internal/server/agents.go`:

```go
func buildAgentRegistry(
    ctx context.Context,
    st *store.Store,
    daemonURL string,
    tokenFn func() string,
) (*agent.Registry, error) {
    factories := []agent.Factory{
        kinagent.NewPluginFactory(st),
        claudecode.NewPluginFactory(claudecode.PluginConfig{
            DaemonURL: daemonURL,
            TokenFunc: tokenFn,
        }),
        codex.NewPluginFactory(),
        grok.NewPluginFactory(),
    }
    if os.Getenv("KIN_ENABLE_RAWPTY") == "1" {
        factories = append(factories, rawpty.NewPluginFactory())
    }
    return agent.Build(ctx, factories...)
}
```

This file is the composition root. One registration line for a new built-in plugin is acceptable; behavioral switches elsewhere are not.

## 7. Canonical adapter events

Add `internal/adapter/events.go`. The engine must parse only these canonical shapes:

```go
type StartedPayload struct {
    SessionRef string `json:"session_ref,omitempty"`
    Model      string `json:"model,omitempty"`
}

type UsagePayload struct {
    Model        string   `json:"model,omitempty"`
    TokensIn     int      `json:"tokens_in,omitempty"`
    TokensOut    int      `json:"tokens_out,omitempty"`
    CachedTokens int      `json:"cached_tokens,omitempty"`
    CostUSD      *float64 `json:"cost_usd,omitempty"`
}

type ResultPayload struct {
    Text       string       `json:"text,omitempty"`
    IsError    bool         `json:"is_error"`
    SessionRef string       `json:"session_ref,omitempty"`
    Usage      UsagePayload `json:"usage,omitempty"`
}
```

Provide tolerant helpers that understand both the canonical fields and current legacy fields (`session_id`, top-level token counts, `result`, `total_cost_usd`). During the refactor, update each concrete parser to emit canonical payloads, but retain tolerant readers so historical events and partially migrated adapters continue to work.

Remove these concrete imports from `internal/task/engine.go`:

```go
internal/adapter/claudecode
internal/adapter/codex
internal/adapter/grok
```

Usage accounting becomes generic:

1. Parse canonical usage from every result.
2. Accumulate tokens for the task.
3. Use reported cost when present.
4. Otherwise compute cost from `price_table` when model and token counts are known, regardless of agent ID.
5. Leave cost null and append one diagnostic event when the model has no price entry.

Controller usage is recorded by the same helper so orchestration overhead is not invisible.

## 8. Generic selection and session policy

Change `task.NewEngine` to receive `*agent.Registry` instead of `map[string]adapter.Adapter`.

Replace `SetDefaultAgentFn` with a preference resolver that returns only the configured ID:

```go
type DefaultPreference func(context.Context) (string, error)

func (e *Engine) SetDefaultPreference(fn DefaultPreference)
func (e *Engine) DefaultAgent(ctx context.Context) string
```

`DefaultAgent` asks the resolver for `agent.default`, then delegates all readiness and fallback selection to `Registry.Default`. No agent IDs appear in task selection code.

Delete `MainAgent` and `isChatHost`. For a task:

- host = `task.Agent`;
- if request agent is empty, host = registry default;
- an explicit request agent is accepted only if `GetRunnable` succeeds;
- a multi-agent plan never overwrites the host;
- workers are the agents named by explicit `@` steps.

Follow-up logic must use capabilities:

```go
sameAgentResume :=
    !handoff &&
    !interrupted &&
    !orchestrate &&
    target.Descriptor.Has(agent.CapabilityResume)
```

When `sameAgentResume` is true, pass only the live user prompt and preserve `session_ref`. Otherwise build the sealed handoff context and clear `session_ref`.

On handoff, interruption, orchestration boundary, retry rewind, or fork reset:

- call `Registry.ResetSession` for the old host if it has session hooks;
- call it for the target host when a stale managed session could exist;
- treat reset errors as diagnostics, not as permission to resume stale state;
- always clear the engine `session_ref` when crossing agent identity.

This removes all `targetAgent == "kin"`, `agent == "kin"`, and direct `ClearKinMessages` calls from `internal/task`.

## 9. Orchestration protocol

### 9.1 Trigger and host

Keep the current explicit-mention trigger: at least one available non-host `@agent` step in the live user turn. Historical context must not re-trigger orchestration.

`@agent` means worker assignment. The host is selected independently by the session's agent picker/default. If a user wants Codex to host and Claude to work, the request is represented as:

```text
host = codex
prompt = "@claude-code implement the cache; then review the result"
```

Do not infer host identity from the first mention.

### 9.2 Safe model-refined plan

The deterministic parser first creates immutable required steps:

```go
type RequiredStep struct {
    Index       int
    Agent       string
    Instruction string
}
```

If the host has `orchestrate`, call its Controller with the required steps and available agent descriptors. Request strict JSON:

```json
{
  "announcement": "I will delegate implementation and then review it.",
  "steps": [
    {"index": 0, "brief": "Implement the cache...", "depends_on": []},
    {"index": 1, "brief": "Review step 0...", "depends_on": [0]}
  ]
}
```

Validation in `internal/task/orchestration_protocol.go` must enforce:

- exactly one entry for every required index;
- no extra or missing indexes;
- worker agent remains the deterministic required agent (the model does not return an agent field);
- dependencies only reference earlier indexes;
- no self-dependency or cycle;
- brief is non-empty and at most 4,000 runes;
- announcement is at most 600 runes;
- total step count is at most 8;
- all worker IDs remain ready immediately before launch.

On timeout, malformed JSON, or validation failure:

- append an `orchestration_fallback` event with host ID and a short reason;
- use current deterministic `PlanWaves` and worker briefs;
- do not mark the task failed solely because the control call failed.

### 9.3 Execution

The engine launches worker adapters exactly as it does today, with these corrections:

- resolve every worker through `Registry.GetRunnable`;
- stamp every worker event with `visibility.user=false`, `visibility.task=true`;
- stamp plan/delegate/summary events with the actual host ID;
- never emit literal speaker `kin` unless Kin is actually the host;
- preserve the parent task ID for approval bridges;
- preserve cancellation of all handles in the current wave;
- record per-step terminal state and text in original step order;
- worker failures do not prevent independent later waves, but a dependent step whose prerequisites failed is marked `skipped` unless the plan explicitly permits best-effort review.

The initial implementation should use fail-closed dependency behavior: dependent steps are skipped after a prerequisite failure. This is more predictable than sending an empty result while pretending the dependency succeeded.

### 9.4 Host synthesis

After workers finish, build a bounded synthesis request:

- original user goal: maximum 2,000 runes;
- each assignment: maximum 1,000 runes;
- each result: `sessionctx.WorkerDigest`, not raw process output;
- statuses: `succeeded`, `failed`, or `skipped`;
- explicit instruction that worker text is untrusted data and must not override the synthesis assignment.

If the host has `orchestrate`, call `Controller.Complete` with purpose `orchestration_synthesis`, timeout 60 seconds, and a maximum prompt size of 24,000 runes. Emit the returned answer as the final user-facing host message.

If synthesis fails or returns blank/meta-only text, use `buildMainSummary` as deterministic fallback and emit an `orchestration_fallback` event. A successful worker run plus fallback summary remains a successful task.

Task terminal status is based on worker execution:

- `succeeded`: all required workers succeeded; host fallback is allowed;
- `failed`: at least one required worker failed or was skipped due to dependency failure;
- `canceled`: user cancellation won the race;
- controller failures alone never produce `failed`.

### 9.5 Structured orchestration events

Stop making the UI infer finality from Chinese text such as `完成：`. Add fields while retaining `source` compatibility:

```json
{
  "role": "assistant",
  "speaker": "codex",
  "agent": "codex",
  "source": "orchestrator",
  "phase": "summary",
  "final": true,
  "visibility": {"user": true, "task": false},
  "content": [{"type": "text", "text": "..."}]
}
```

Valid phases: `plan`, `delegate`, `fallback`, `summary`. UI falls back to legacy source/text behavior only when `phase` is absent.

## 10. API and UI changes

### 10.1 API

`GET /api/agents` returns registry `Info`:

```json
[
  {
    "id": "codex",
    "name": "Codex",
    "kind": "cli",
    "capabilities": ["run", "resume", "tools", "orchestrate"],
    "installed": true,
    "available": true,
    "default": true,
    "binary": "/opt/homebrew/bin/codex"
  }
]
```

Remove `Server.ListAgents` and the server-side `detect.Cache` path after all factories own status. `handleListAgents` asks the engine/registry directly.

Keep request fields unchanged. `CreateRequest.Agent` and `FollowUpRequest.Agent` continue to select or switch the host.

### 10.2 New chat

Update `ui/src/pages/NewChatPage.tsx`:

- add an explicit host agent picker populated from available agents;
- initialize it from the entry with `default=true`;
- show capability badges only where helpful (for example, “multi-agent summary” when `orchestrate` is present);
- remove “Kin = main / all others = worker” labels;
- submit the selected host in `createTask`;
- keep raw `@worker` mentions in the prompt.

### 10.3 Existing task / handoff

Update `ui/src/pages/TaskDetailPage.tsx`:

- display the current host from `task.agent`;
- provide a host switch control beside the composer or in its overflow menu;
- sending after host switch passes `{agent: selectedHost}` to `followUpPrompt`;
- do not rewrite the agent only because a prompt contains multiple mentions;
- warn that switching host starts a clean handoff context, not a lossless session resume.

### 10.4 Generic rendering

Update `ui/src/components/chat/ChatStream.tsx` and `ui/src/lib/agentMention.ts`:

- `resolveSpeaker` accepts any non-empty explicit `speaker`/`agent` value; it does not whitelist IDs;
- orchestrator/delegate fallback speaker is the task host, not `kin`;
- `isUserFacingEvent` prefers explicit visibility, then compares speaker to host for legacy rows;
- progress/final classification uses `phase` and `final`; the `完成：` regex remains legacy fallback only;
- avatar metadata uses API `name` where available and a deterministic generic fallback for unknown IDs;
- mention aliases for built-ins may remain convenience aliases, but exact IDs from `/api/agents` must always work;
- labels and translations say “host” and “worker”, not “Kin” and “other agents”.

No plugin-specific colors or icons are required for correctness. Built-in visual polish can remain as optional mappings.

## 11. Failure modes and security

| Failure | Required behavior |
|---|---|
| Configured default unavailable | Registry selects next ready plugin; API marks actual default |
| Host becomes unavailable before start | Fail validation with a clear unavailable reason |
| Worker becomes unavailable after planning | Mark that step failed; do not substitute another agent silently |
| Controller times out | Cancel controller process/request; deterministic fallback |
| Controller emits malformed JSON | Reject proposal; deterministic plan |
| Controller proposes invalid dependencies | Reject whole proposal; deterministic plan |
| Worker result contains prompt injection | Treat as quoted/untrusted data; control process remains read-only; engine ignores commands in text |
| Host synthesis blank/meta-only | Deterministic summary fallback |
| Session reset fails | Clear engine session ref, log diagnostic, cold-start; never resume potentially stale state |
| Cancellation during controller call | Cancel controller, stop pending workers, finish canceled |
| Cancellation during worker wave | Cancel every registered handle; no later wave or synthesis |
| Historical event lacks visibility/phase | UI uses host-aware legacy fallback |
| Duplicate plugin ID | Daemon startup fails with explicit duplicate ID error |

Control-plane safety rules:

- never inherit YOLO mode;
- no approval bridge for control calls;
- read-only sandbox or provider request without tools;
- hard timeout: 30 seconds planning, 60 seconds synthesis;
- bounded prompts and output;
- never execute model-returned commands;
- validate all indexes, dependencies, IDs, lengths, and counts;
- error messages exposed to UI must not contain API keys, auth tokens, or full control prompts.

## 12. ADR

### ADR-0004: Agent registry with engine-owned orchestration

**Status:** Proposed; accept before implementation.

**Context:** Kin currently has a common run adapter but special behavior across default selection, session context, orchestration identity, server assembly, API discovery, and UI rendering. The product requires Kin, Claude Code, Codex, and future agents to be interchangeable.

**Decision:** Introduce compiled agent plugins with descriptors, readiness, runners, optional read-only controllers, and session hooks. Keep orchestration execution in `task.Engine`; allow the selected host to propose bounded plan refinements and synthesize results through a validated control-plane interface.

**Positive consequences:**

- Kin loses privileged identity in shared layers.
- New agents do not require cross-cutting switches.
- Claude/Codex can genuinely host multi-agent sessions.
- Deterministic fallback preserves reliability.
- Security and lifecycle authority remain centralized.

**Negative consequences:**

- More interfaces and characterization tests are required.
- Claude/Codex controllers need version-sensitive read-only CLI invocation.
- Host planning/synthesis adds latency and token cost.
- A compiled plugin still requires daemon rebuild/restart.

**Alternatives rejected:**

1. Keep the current adapter map and only rename UI labels: low cost but not real interchangeability.
2. Let Claude/Codex directly spawn and supervise other CLIs: higher apparent autonomy but duplicates cancellation, approvals, persistence, security, and recovery.
3. Build dynamic `.so` or out-of-process plugins now: unnecessary distribution, compatibility, and security complexity for the current product stage.
4. Make orchestration a completely separate global service: breaks the desired rule that the selected agent is the conversational host.

## 13. Implementation tasks

Execute in a clean worktree. The current workspace was dirty when this plan was written; do not reset or overwrite unrelated user changes. Rebase or recreate the worktree from the intended committed baseline before starting.

### Task 1: Add characterization tests around current behavior

**Files:**

- Modify: `internal/task/engine_test.go`
- Modify: `internal/task/approvals_test.go`
- Modify: `internal/task/orchestrate_summary_test.go`
- Modify: `internal/api/api_test.go`

**Step 1: Write tests that capture the compatibility surface**

Add tests for:

- explicit task agent remains the single-run speaker;
- multi-agent cancellation cancels all worker handles;
- historical event payloads with `session_id`, `result`, and top-level usage still parse;
- follow-up handoff clears `session_ref`;
- plain follow-up does not re-trigger historical mentions;
- `/api/agents` remains stable and marks exactly one ready default.

These tests should describe externally visible behavior, not current Kin-specific implementation.

**Step 2: Run the tests**

Run:

```bash
go test ./internal/task ./internal/api
```

Expected: PASS before structural changes.

**Step 3: Commit**

```bash
git add internal/task internal/api
git commit -m "test: characterize agent runtime behavior"
```

### Task 2: Implement agent contracts and registry

**Files:**

- Create: `internal/agent/types.go`
- Create: `internal/agent/registry.go`
- Create: `internal/agent/registry_test.go`

**Step 1: Write failing registry tests**

Cover:

- duplicate IDs fail;
- invalid IDs fail;
- configured ready default wins;
- unavailable configured default falls back by `(priority, id)`;
- unavailable agents remain in `List` with reason;
- `orchestrate` without Controller fails;
- unknown/unavailable/runnable errors are distinguishable;
- returned lists are stable and cannot mutate registry internals;
- session reset is a no-op when hooks are absent and calls hooks when present.

**Step 2: Verify failure**

```bash
go test ./internal/agent
```

Expected: FAIL because the package/contracts do not exist.

**Step 3: Implement the minimal registry**

Use immutable registrations after `Build`; call status resolvers on `List`, `Default`, and `GetRunnable` so provider readiness can change live.

**Step 4: Verify**

```bash
go test ./internal/agent
```

Expected: PASS.

**Step 5: Commit**

```bash
git add internal/agent
git commit -m "feat: add agent plugin registry"
```

### Task 3: Normalize adapter events

**Files:**

- Create: `internal/adapter/events.go`
- Create: `internal/adapter/events_test.go`
- Modify: `internal/adapter/claudecode/parse.go`
- Modify: `internal/adapter/codex/parse.go`
- Modify: `internal/adapter/grok/adapter.go`
- Modify: `internal/adapter/kinagent/loop.go`
- Modify: `internal/task/engine.go`
- Modify: relevant parser tests in each adapter package

**Step 1: Write failing tolerant-parser tests**

Test canonical and legacy started/result payloads, including absent cost, nested result text, session IDs, and malformed JSON.

**Step 2: Verify failure**

```bash
go test ./internal/adapter/...
```

Expected: FAIL for missing canonical helpers.

**Step 3: Implement canonical payloads and tolerant readers**

Update adapter emitters to canonical fields. Preserve extra raw fields only when useful for diagnosis.

**Step 4: Remove concrete adapter parsing from the engine**

Use `adapter.ParseStarted` and `adapter.ParseResult`. Generalize price-table cost computation to every agent.

**Step 5: Verify**

```bash
go test ./internal/adapter/... ./internal/task ./internal/store
```

Expected: PASS, and `rg 'adapter/(claudecode|codex|grok)' internal/task` returns no matches.

**Step 6: Commit**

```bash
git add internal/adapter internal/task/engine.go
git commit -m "refactor: normalize agent runtime events"
```

### Task 4: Move built-ins behind plugin factories

**Files:**

- Create: `internal/adapter/kinagent/plugin.go`
- Create: `internal/adapter/kinagent/plugin_test.go`
- Create: `internal/adapter/claudecode/plugin.go`
- Create: `internal/adapter/claudecode/plugin_test.go`
- Create: `internal/adapter/codex/plugin.go`
- Create: `internal/adapter/codex/plugin_test.go`
- Create: `internal/adapter/grok/plugin.go`
- Create: `internal/adapter/rawpty/plugin.go`
- Create: `internal/server/agents.go`
- Create: `internal/server/agents_test.go`
- Modify: `internal/server/server.go`
- Modify or retire: `internal/adapter/detect/detect.go`
- Modify or retire: `internal/adapter/detect/detect_test.go`

**Step 1: Write factory tests**

Inject PATH lookup and provider settings. Assert descriptor, capabilities, status reason, binary resolution, and configured adapter fields.

**Step 2: Implement factories**

Move package-specific construction out of `ServeWith`. Keep environment override semantics unchanged.

**Step 3: Build registry in the composition root**

Replace the large discovery/construction switch with `buildAgentRegistry`.

**Step 4: Verify**

```bash
go test ./internal/adapter/... ./internal/server
```

Expected: PASS. `server.go` contains no switch over agent IDs.

**Step 5: Commit**

```bash
git add internal/adapter internal/server
git commit -m "refactor: register built-in agents as plugins"
```

### Task 5: Convert Engine selection and sessions to registry capabilities

**Files:**

- Modify: `internal/task/engine.go`
- Modify: `internal/task/approvals.go`
- Modify: `internal/task/approvals_test.go`
- Modify: `internal/task/kin_resume_test.go`
- Modify: `internal/task/fork_retry_test.go`
- Modify: `internal/adapter/kinagent/store_bridge.go`
- Modify: all `task.NewEngine` call sites and test helpers

**Step 1: Write failing arbitrary-ID tests**

Register fake plugins named `host-a` and `worker-b`. Prove that default selection, single run, resume, handoff, reset hooks, and usage work without any built-in IDs.

**Step 2: Change `NewEngine` and selection APIs**

Make Engine depend on `*agent.Registry`; add context-aware default preference; delegate list/get/readiness to registry.

**Step 3: Replace ID-specific session rules**

Use `CapabilityResume` and `SessionHooks`. Move Kin transcript clearing behind Kin session hooks.

**Step 4: Verify no shared-layer identity checks**

Run:

```bash
rg '== "kin"|!= "kin"|HasAgent\("kin"\)|ClearKinMessages' internal/task internal/api internal/server
```

Expected: no matches in `internal/task` or `internal/api`. The composition root may mention the Kin factory package, but must not branch behavior on the ID.

**Step 5: Run tests**

```bash
go test ./internal/task ./internal/api ./internal/server
```

Expected: PASS.

**Step 6: Commit**

```bash
git add internal/task internal/api internal/server internal/adapter/kinagent
git commit -m "refactor: select agents through capabilities"
```

### Task 6: Make orchestration host-neutral with deterministic fallback

**Files:**

- Modify: `internal/task/plan.go`
- Modify: `internal/task/orchestrate.go`
- Create: `internal/task/orchestration_protocol.go`
- Create: `internal/task/orchestration_protocol_test.go`
- Modify: `internal/task/plan_test.go`
- Modify: `internal/task/orchestrate_summary_test.go`
- Modify: `internal/task/permission_mode_test.go`

**Step 1: Write failing host-neutral tests**

Cover:

- a `host-a` task remains hosted by `host-a` during explicit delegation;
- plan/delegate/summary speakers are `host-a`;
- worker events are task-only;
- no Controller uses deterministic waves and summary;
- failed prerequisite skips dependents;
- controller failure is a fallback, not task failure;
- controller output cannot add/remove/reassign required steps;
- step and prompt limits are enforced;
- cancellation during orchestration produces no summary.

**Step 2: Delete `MainAgent` and `isChatHost`**

Use `t.Agent` as the host everywhere. Resolve workers through registry.

**Step 3: Add structured phases and explicit visibility**

Every emitted message must carry speaker, source, phase where relevant, and visibility. Remove `agent == "kin"` visibility logic.

**Step 4: Implement deterministic dependency failure handling**

Track `succeeded/failed/skipped`; do not launch a dependent whose prerequisite failed.

**Step 5: Verify**

```bash
go test ./internal/task
```

Expected: PASS.

**Step 6: Commit**

```bash
git add internal/task
git commit -m "refactor: make orchestration host neutral"
```

### Task 7: Add read-only controllers and host synthesis

**Files:**

- Create: `internal/adapter/kinagent/controller.go`
- Create: `internal/adapter/kinagent/controller_test.go`
- Create: `internal/adapter/claudecode/controller.go`
- Create: `internal/adapter/claudecode/controller_test.go`
- Create: `internal/adapter/codex/controller.go`
- Create: `internal/adapter/codex/controller_test.go`
- Modify: corresponding `plugin.go` files
- Modify: `internal/task/orchestrate.go`
- Modify: `internal/task/orchestration_protocol.go`
- Modify: `internal/task/orchestrate_summary_test.go`

**Step 1: Write command/controller tests**

Use fake binaries/clients. Assert:

- Kin sends no tools;
- Claude command disables tools and session persistence and uses plan/safe mode;
- Codex command uses read-only sandbox;
- parent YOLO mode is never passed;
- timeout/cancel kills the process;
- terminal text and usage are extracted;
- blank output is an error.

**Step 2: Implement controllers**

Share parsing helpers with the run adapter where possible; do not duplicate event semantics.

**Step 3: Integrate plan refinement and synthesis**

Validate plans before use, digest worker outputs before synthesis, record controller usage, and fall back on every controller error path.

**Step 4: Run automated tests**

```bash
go test ./internal/agent ./internal/adapter/... ./internal/task
```

Expected: PASS.

**Step 5: Run CLI smoke tests on supported versions**

In a throwaway repository and with no write permission required:

```bash
claude -p 'Reply with exactly OK' --output-format json --permission-mode plan --tools "" --no-session-persistence --safe-mode
codex exec --json --sandbox read-only --ephemeral --ignore-rules 'Reply with exactly OK'
```

Expected: each exits zero, produces parseable terminal text, and creates/modifies no workspace files. If Claude fails because flags are unsupported, remove its `orchestrate` capability rather than weakening read-only guarantees.

**Step 6: Commit**

```bash
git add internal/agent internal/adapter internal/task
git commit -m "feat: let capable host agents synthesize delegation"
```

### Task 8: Expose registry metadata through API

**Files:**

- Modify: `internal/api/api.go`
- Modify: `internal/api/api_test.go`
- Modify: `internal/api/settings_test.go`
- Modify: `internal/server/server.go`
- Modify: `ui/src/api/client.ts`

**Step 1: Write failing API tests**

Assert capabilities/kind/status/default, dynamic Kin readiness after settings save, stable order, and exactly one default when any runnable agent exists.

**Step 2: Remove duplicate API discovery**

Delete `api.AgentInfo`, `Server.ListAgents`, and the server cache callback. Return registry `Info` directly.

**Step 3: Update TypeScript type**

Add `kind` and `capabilities`; preserve existing fields.

**Step 4: Verify**

```bash
go test ./internal/api ./internal/server
npm --prefix ui run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add internal/api internal/server ui/src/api/client.ts
git commit -m "feat: expose agent plugin capabilities"
```

### Task 9: Make host selection and rendering generic in UI

**Files:**

- Modify: `ui/src/pages/NewChatPage.tsx`
- Modify: `ui/src/pages/TaskDetailPage.tsx`
- Modify: `ui/src/components/chat/Composer.tsx`
- Modify or create: `ui/src/components/chat/AgentPicker.tsx`
- Modify: `ui/src/components/chat/ChatStream.tsx`
- Modify: `ui/src/lib/agentMention.ts`
- Modify: `ui/src/i18n/locales/en.ts`
- Modify: `ui/src/i18n/locales/zh.ts`

**Step 1: Add the reusable host picker**

It accepts registry `AgentInfo[]`, selected ID, disabled state, and change callback. It lists only available `run` agents and displays the registry name.

**Step 2: Use the picker for new tasks and handoffs**

Submit selected host explicitly. Do not derive host from worker mentions.

**Step 3: Remove fixed-ID rendering assumptions**

Pass task host and agent metadata to ChatStream; use structured phase/finality/visibility first and legacy fallbacks second.

**Step 4: Update copy**

Describe “host agent” and “worker agents”. Do not imply Kin is permanently main.

**Step 5: Verify**

```bash
npm --prefix ui run typecheck
npm --prefix ui run build
```

Expected: PASS.

Manual checks:

- unknown fake agent ID renders a readable generic avatar/name;
- Codex host summary appears as Codex;
- worker output stays in progress/task detail;
- old stored Kin orchestration events still render;
- switching host shows handoff feedback and updates `task.agent`.

**Step 6: Commit**

```bash
git add ui
git commit -m "feat: support interchangeable session hosts"
```

### Task 10: Documentation, cleanup, and end-to-end verification

**Files:**

- Create: `docs/adr/0004-pluggable-agent-runtime.md`
- Modify: `SYSTEM_DESIGN.md`
- Modify: `SYSTEM_DESIGN.zh.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `docs/IMPL_NOTES.md`
- Modify: any obsolete comments in `internal/task` and `ui/src`

**Step 1: Record ADR-0004**

Copy the decision from this plan and mark Accepted after review.

**Step 2: Update architecture language**

Document Kin as the default built-in plugin, not the permanent orchestrator. State that host selection and worker delegation are independent.

**Step 3: Run static coupling checks**

```bash
rg 'MainAgent|isChatHost|SetDefaultAgentFn' internal ui/src
rg '== "kin"|!= "kin"|speaker.*kin|return "kin"' internal/task internal/api
rg 'source === "orchestrator".*kin|speaker === "kin"' ui/src/components/chat
```

Expected: no shared-layer behavioral coupling. Compatibility mappings or built-in visual styling must be individually justified.

**Step 4: Run full verification**

```bash
go test ./...
npm --prefix ui run typecheck
npm --prefix ui run build
git diff --check
```

Expected: all commands PASS.

**Step 5: Manual end-to-end matrix**

Run these in a throwaway workspace:

| Host | Prompt | Expected |
|---|---|---|
| Kin | plain question | Kin single run/resume |
| Claude Code | plain coding task | Claude single run/resume |
| Codex | plain coding task | Codex single run/resume |
| Kin | `@claude-code implement @codex review prior result` | Kin plan/synthesis, dependent waves |
| Claude Code | `@codex investigate` | Claude host identity and summary |
| Codex | `@claude-code investigate` | Codex host identity and summary |
| Grok | `@codex investigate` | deterministic fallback under Grok identity |
| Any | controller forced timeout | workers continue, fallback summary |
| Any | cancel during parallel wave | all handles canceled, no synthesis |
| Claude → Codex | host switch follow-up | clean handoff, no Claude session resume |

Inspect task events and verify speaker, visibility, phase, status, session ref, and accumulated usage.

**Step 6: Commit**

```bash
git add docs README.md README.zh.md SYSTEM_DESIGN.md SYSTEM_DESIGN.zh.md internal ui
git commit -m "docs: describe pluggable agent runtime"
```

## 14. Acceptance criteria

The refactor is complete only when all of the following are true:

- [ ] `task.Engine` receives an agent registry, not a raw adapter map.
- [ ] No shared task/API code branches on `kin`, `claude-code`, `codex`, or `grok` IDs.
- [ ] `tasks.agent` remains the chosen host during multi-agent turns.
- [ ] Kin, Claude Code, and Codex each register through the same factory/registry contract.
- [ ] Kin, Claude Code, and Codex can each host a session.
- [ ] Capable hosts can produce final synthesis through a read-only Controller.
- [ ] Controller failure always has deterministic fallback.
- [ ] Models cannot alter the explicit worker set or engine-owned execution fields.
- [ ] Kin transcript reset occurs through plugin hooks, not engine knowledge.
- [ ] Engine parses canonical adapter events without concrete adapter imports.
- [ ] `/api/agents` exposes descriptor, capabilities, readiness, and actual default from one source.
- [ ] UI host selection is explicit and independent of `@worker` mentions.
- [ ] Unknown future agent IDs render correctly.
- [ ] Old stored events still render acceptably.
- [ ] Cancellation, approvals, resume, handoff, retry/fork, usage, and cost tests pass.
- [ ] `go test ./...`, UI typecheck/build, and `git diff --check` pass.
- [ ] Manual Claude/Codex control calls are proven read-only on supported versions.

## 15. Rollout and rollback

Implement behind one temporary setting only if incremental merging is required:

```text
agent.plugin_runtime = 0 | 1
```

Prefer a short-lived flag removed after the end-to-end matrix passes. Do not maintain two orchestration implementations long-term.

Recommended merge sequence:

1. Contracts, registry, and canonical events with no UX change.
2. Plugin factories and engine registry migration.
3. Host-neutral deterministic orchestration.
4. Controllers and host synthesis.
5. API/UI host selection and generic rendering.
6. Remove compatibility flag and obsolete discovery code.

Rollback before step 4 is straightforward because no schema changes are required. After deployment, rollback must preserve existing task/event rows; the new event fields are additive and older code should ignore them. Do not write a database migration solely for this refactor.

## 16. Cost estimate

For one engineer/model with review after each milestone:

| Scope | Estimate |
|---|---:|
| Registry, factories, canonical events | 3–5 days |
| Engine/session decoupling | 2–4 days |
| Host-neutral orchestration and fallback | 3–4 days |
| Kin/Claude/Codex controllers | 3–5 days |
| API/UI and compatibility | 2–4 days |
| End-to-end hardening and docs | 2–3 days |
| **Total production-ready refactor** | **15–25 engineer-days** |

A reduced MVP that stops after host-neutral deterministic orchestration is approximately 7–10 engineer-days. It makes Kin structurally replaceable, but Claude/Codex would only carry host identity; they would not yet reason over the final worker synthesis. The full plan above is the recommended target because it delivers the product value implied by “interchangeable agent,” not only cleaner labels.

## 17. Review checkpoints

The reviewer should stop execution and review after Tasks 3, 6, 7, and 9.

At each checkpoint inspect:

1. **Boundary:** did any new shared-layer ID switch appear?
2. **Authority:** can model output cause unvalidated execution or permission changes?
3. **Fallback:** does control failure preserve a deterministic useful result?
4. **Identity:** do event speaker and visibility match the actual host/worker role?
5. **Session:** can stale provider/CLI context leak across host switch or retry?
6. **Compatibility:** do legacy payloads and stored events still work?
7. **Accounting:** are host control tokens/cost included?
8. **Read-only guarantee:** do CLI controller flags match the supported installed versions?
9. **Scope:** did the implementation avoid dynamic plugins, implicit delegation, and schema work?

Any implementation that merely changes `MainAgent()` or UI labels without removing capability/session/event coupling does not satisfy this plan.
