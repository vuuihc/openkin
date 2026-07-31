# Auto Model Routing Plan

**Status:** Draft
**Date:** 2026-07-28
**Owner:** Implementation by dpsk v4, review by Kin maintainer

## Executive Summary

Kin should support a practical `auto` routing mode for users who have a mix of
paid subscriptions, BYOK providers, company models, and free providers.

The target behavior is:

- smart models plan and review;
- cheaper or free models execute when the selected profile allows it;
- provider/model fallback happens inside the configured phase agent first;
- the first implementation does not automatically switch agents on fallback;
- every route decision is visible and auditable.

The feature is considered complete only when all user stories in this document
are covered by tests. The main acceptance path is:

1. configure agents, providers, and routing profiles;
2. start tasks with `Auto -> Profile -> Objective`;
3. start tasks with `Manual -> Agent -> Provider -> Model`;
4. persist and render dispatch selection, preview, decisions, and fallback;
5. keep old tasks readable after later provider/profile edits.

## Goals

- Make `auto` mean team/profile-aware routing, not "pick the default agent".
- Decouple execution agents from provider profiles where adapters support it.
- Allow a user to configure provider compatibility explicitly:

```text
providers:
  A: [claude-code, codex, kin]
  B: [claude-code, grok]
  C: [droid, pi]
```

- Let a profile choose the default agent per phase:

```text
plan    -> claude-code
execute -> kin
review  -> codex
```

- Let a selected phase agent switch between same-tier provider/model candidates:

```text
same provider same tier -> next provider same tier -> lower tier
```

- Keep task dispatch clear:

```text
Auto   -> Profile/Team -> Objective
Manual -> Agent -> Provider -> Model
```

## Non-Goals

- Do not turn Kin into a cloud scheduler or multi-tenant routing service.
- Do not require all inference traffic to pass through a Kin gateway.
- Do not broadcast task or workspace content to providers while previewing.
- Do not silently send sensitive context to every configured provider.
- Do not automatically switch execution agents in the first implementation.
- Do not replace explicit routing. Prompt-level `@agent[model]` stays highest
  priority.
- Do not build a full visual policy graph in the first UI. A structured form
  plus advanced JSON is enough.

## Current State

The codebase already has useful primitives, but they are not composed into one
routing policy.

- `AutoCodingPlan` exists in `internal/task/intent.go`, but is not called by the
  engine today. Plain coding tasks do not automatically become
  plan/execute/review work.
- Explicit `@agent[model]` routing works through
  `DelegateStep.Model -> adapter.TaskSpec.Model -> CLI flag`.
- Natural-language model directives exist in `internal/task/modeldirective.go`,
  including `smart`, `balanced`, and `fast` tiers.
- `BuiltinCatalog` has static model tiers for Claude Code, Codex, and Grok.
- Provider registry exists in `internal/provider`, but runtime callers use only
  the active provider. There is no provider-agent support matrix or provider
  fallback.
- Claude/Codex usage windows exist in `internal/usagewindows`; the engine can
  preflight an exhausted CLI window.
- `limit_policy=wait|ask|switch` exists, but `switch` picks fallback agents by
  order, not by team, phase, provider, model, or tier equivalence.
- Per-agent daily usage limits exist and are display-oriented; they are not
  routing inputs yet.

The missing decision point is:

```text
For this team and phase, which compatible provider/model should this phase's
agent use now?
```

## Product Contract

When routing is enabled and a user starts a task without explicit routing, Kin
should:

1. classify whether the prompt is a coding task;
2. build a conservative phase plan;
3. load the selected team/profile;
4. use the team's configured agent for each phase;
5. resolve provider/model candidates by objective, provider priority, tier, and
   availability;
6. launch each step with the selected agent/provider/model;
7. on rate limit or exhausted window, retry the phase on the next compatible
   same-agent candidate;
8. persist the dispatch selection, preview, route decisions, and fallback events.

Precedence:

```text
prompt @agent[model]
  > follow-up selected agent/model
  > natural-language directive
  > dispatch selection
  > team phase policy
  > provider priority
  > existing default agent/model
```

Manual dispatch is exact by default. It must not silently change provider/model
unless a future manual fallback setting explicitly allows it.

## User Stories

### US1: First-Time Setup

As a user with Claude Code Pro, Codex, company Grok, and OpenRouter/free
channels, I want to configure all usable backends once and reuse them when
dispatching tasks.

Flow:

1. Open Agents page.
2. See installed agents and missing setup.
3. Open Settings -> Providers.
4. Create provider profiles:
   - `claude-sub`: subscription, supports `claude-code`;
   - `anthropic-byok`: Anthropic-compatible BYOK, supports `claude-code` and
     optionally `kin`;
   - `company-grok`: Grok-compatible, supports `grok` and optionally `kin`;
   - `openrouter-free`: OpenAI-compatible, supports `kin`.
5. Test provider profiles without sending task or workspace content.
6. Open Settings -> Routing Profiles.
7. Create:
   - `A / claude-first`;
   - `B / mixed-cheap`.
8. Set defaults:
   - auto routing enabled;
   - default profile `A`;
   - default objective `balanced`.

Acceptance:

- setup is possible without editing JSON manually;
- invalid provider/agent/model relationships fail before task launch;
- secrets are write-only from the UI perspective;
- disabled providers and agents stay visible with reasons.

### US2: Start a Normal Auto Task

As a user starting a coding task, I want one compact selector that previews what
will happen before submit.

Flow:

1. Type a coding prompt.
2. Dispatch selector defaults to `Auto`.
3. Choose profile `A` and objective `intelligent-max`.
4. Preview shows phase, agent, provider, model, tier, and fallback order.
5. Submit.
6. Task stores canonical dispatch selection.
7. Runtime emits actual `route_decision` events.

Acceptance:

- preview is explainable, not a black box;
- runtime decisions may differ from preview, but the final decision explains why;
- task audit survives later profile edits.

### US3: Start a Cheap Task

As a user doing routine edits, I want to minimize cost without changing global
defaults.

Flow:

1. Keep `Auto`.
2. Choose profile `B / mixed-cheap`.
3. Choose objective `cost-min`.
4. Preview keeps plan/review smart but routes execute to cheap/free candidates.
5. If the cheap route is unavailable, preview explains fallback or blocking.

Acceptance:

- `cost-min` reorders candidates only inside the selected profile;
- it does not expand to providers outside the team;
- unavailable cheap routes are explained before submit.

### US4: Manual Override

As a user who wants Claude Code with a specific BYOK provider, I want to choose
the exact route.

Flow:

1. Switch dispatch mode to `Manual`.
2. Select `Claude Code`.
3. Provider selector shows only Claude Code-compatible provider profiles.
4. Select `anthropic-byok`.
5. Model selector shows only models under `anthropic-byok`.
6. Submit.

Acceptance:

- manual route is exact;
- unhealthy manual routes block or ask instead of silently changing;
- prompt-level `@agent[model]` override is visibly explained.

### US5: Runtime Limit or Provider Failure

As a user, I want rate-limit fallback to continue work without unexpectedly
changing the phase agent.

Flow:

1. Task starts with phase agent `Claude Code` and provider `claude-sub`.
2. Claude subscription window is exhausted.
3. Resolver retries with the next compatible Claude Code provider/model, such as
   `anthropic-byok`.
4. Kin emits `route_fallback` with source, destination, failure class, and reason.
5. If no same-agent candidate remains, Kin applies terminal `limit_policy`.

Acceptance:

- first implementation does not switch from Claude Code to Codex/Grok
  automatically;
- auth/config failures mark only the failed provider/profile unhealthy;
- repeated fallback has a hard attempt limit;
- task UI shows waiting, asking, retrying, or failed state.

### US6: Post-Task Review and Tuning

As a user, I want to understand spend, fallback behavior, and quality tradeoffs
so I can tune profiles.

Flow:

1. Open task detail.
2. See dispatch selection, preview, actual route decisions, and fallback events.
3. Open usage page.
4. Usage is grouped by provider, model, team, objective, and phase.
5. Edit routing profile based on observed cost or failures.

Acceptance:

- usage attribution uses actual runtime provider/model;
- profile edits do not rewrite old task history;
- route events contain enough fields for aggregation.

### US7: Broken or Changed Configuration

As a user, I need clear behavior when a provider is deleted, a model is renamed,
or an agent is disabled.

Flow:

1. Disable a provider used by profile `A`.
2. Settings shows impacted teams/phases.
3. Existing tasks remain readable from persisted dispatch and route decisions.
4. New tasks using profile `A` are blocked or preview unresolved phases until
   the profile is fixed.

Acceptance:

- disabling/deleting referenced config requires reference checks;
- disabling is preferred over deletion in the first implementation;
- deleted or renamed ids do not break old task detail rendering.

## User Story Coverage Matrix

This matrix is the review contract. A PR that claims feature completion must
cover every row with tests or an explicit documented deferral.

| Story | Required capability | Primary tests | Extra verification |
| --- | --- | --- | --- |
| US1 | Configure agents, providers, profiles, defaults | routing policy validation unit tests; provider form UI tests; settings round-trip tests | manually create `claude-first` and `mixed-cheap` profiles |
| US1 | Secret values are write-only/redacted | provider settings API tests | inspect network response for redacted fields |
| US2 | Auto selector previews phase route | preview resolver tests; selector UI tests | create Auto task and inspect preview |
| US2 | Runtime decision is persisted and visible | task creation/persistence tests; task detail UI tests | reload task detail after route decision |
| US3 | `cost-min` stays inside selected team | resolver ordering tests | verify no out-of-team provider appears in preview |
| US4 | Manual cascade filters options | UI tests for `Agent -> Provider -> Model`; backend validation tests | try unsupported provider/model and confirm block |
| US4 | Manual route does not silently fallback | resolver/task tests | force unhealthy manual provider and confirm ask/fail |
| US5 | Same-agent provider/model fallback | resolver `Next` tests; failure classifier tests | simulate Claude window exhausted -> BYOK fallback |
| US5 | No automatic agent switch | resolver tests | confirm candidate agent remains unchanged |
| US6 | Usage and route audit use runtime decisions | task event tests; usage aggregation tests | compare preview vs actual route in task detail |
| US7 | Reference-stable history | config mutation tests; task detail reload tests | disable provider and verify old task still renders |
| US7 | Impacted profile warnings | settings API/UI tests | disable referenced provider and inspect warning |

## Domain Model

### Phase

```go
type RoutePhase string

const (
    PhasePlan    RoutePhase = "plan"
    PhaseExecute RoutePhase = "execute"
    PhaseReview  RoutePhase = "review"
    PhaseChat    RoutePhase = "chat"
)
```

### Provider Profile

A provider profile is a backend account/configuration plus a user-configured
allowlist of agents that can use it.

```go
type ProviderProfile struct {
    ID             string      `json:"id"`
    Name           string      `json:"name"`
    Kind           string      `json:"kind"`
    SupportsAgents []string    `json:"supports_agents"`
    Enabled        bool        `json:"enabled"`
    Models         []ModelSpec `json:"models"`
}

type ModelSpec struct {
    ID        string `json:"id"`
    Tier      string `json:"tier"`       // smart | balanced | fast | free
    CostLabel string `json:"cost_label"` // paid | company | free | unknown
}
```

Provider `kind` values for the first implementation:

- `subscription`;
- `anthropic-compatible`;
- `openai-compatible`;
- `grok-compatible`;
- `custom`.

Validation:

- provider id is unique and stable;
- `supports_agents` maps to known adapters;
- adapter capabilities support provider kind;
- every model has id and tier;
- secret fields are write-only and never returned as plaintext.

### Team/Profile

A team is a reusable task dispatch preset.

```go
type TeamProfile struct {
    ID               string                 `json:"id"`
    Name             string                 `json:"name"`
    Alias            string                 `json:"alias,omitempty"`
    DefaultObjective string                 `json:"default_objective,omitempty"`
    Enabled          bool                   `json:"enabled"`
    Phases           map[RoutePhase]PhasePolicy `json:"phases"`
}

type PhasePolicy struct {
    Agent            string   `json:"agent"`
    Tier             string   `json:"tier"`
    ProviderPriority []string `json:"provider_priority"`
    Fallback         []string `json:"fallback"`
}
```

Fallback values:

- `same_provider_same_tier`;
- `next_provider_same_tier`;
- `same_provider_lower_tier`;
- `next_provider_lower_tier`.

Validation:

- phase agent is known;
- every provider exists;
- every provider supports the phase agent;
- at least one model can satisfy target tier unless lower-tier fallback is
  explicitly allowed;
- aliases resolve to one team.

### Dispatch Selection

```go
type DispatchMode string

const (
    DispatchAuto   DispatchMode = "auto"
    DispatchManual DispatchMode = "manual"
)

type DispatchObjective string

const (
    ObjectiveBalanced       DispatchObjective = "balanced"
    ObjectiveCostMin        DispatchObjective = "cost-min"
    ObjectiveIntelligentMax DispatchObjective = "intelligent-max"
)

type DispatchSelection struct {
    Mode      DispatchMode      `json:"mode"`
    Team      string            `json:"team,omitempty"`
    Objective DispatchObjective `json:"objective,omitempty"`
    Agent     string            `json:"agent,omitempty"`
    Provider  string            `json:"provider,omitempty"`
    Model     string            `json:"model,omitempty"`
}
```

Validation:

- `mode=auto` requires a valid team; missing objective defaults to `balanced`;
- `mode=manual` requires agent, provider, and model;
- manual provider must support agent;
- manual model must exist under provider;
- old clients without `dispatch` keep working.

### Route Decision Event

Route decisions are task-visible audit records.

```json
{
  "type": "route_decision",
  "team": "claude-first",
  "objective": "balanced",
  "phase": "execute",
  "agent": "claude-code",
  "provider": "anthropic-byok",
  "model": "claude-sonnet-4",
  "tier": "balanced",
  "reason": "claude-sub exhausted; next compatible provider selected",
  "fallback_from": {
    "provider": "claude-sub",
    "model": "claude-sonnet-4-6"
  },
  "candidates_skipped": [
    {"provider": "claude-sub", "model": "claude-sonnet-4-6", "reason": "5h window exhausted"},
    {"provider": "company-grok", "model": "grok-code-fast-1", "reason": "provider does not support claude-code"}
  ]
}
```

Persist enough data to render old task history even if provider/profile ids are
later renamed or disabled.

## Configuration Surfaces

### Agents Page

The Agents page owns execution-agent status and capabilities.

It should show:

- installed/enabled agents;
- binary/auth/subscription health;
- adapter-declared supported provider kinds;
- compatible provider profiles;
- routing enabled/disabled state.

It may link to provider/profile settings, but it is not the primary editor for
provider secrets or team phase policy.

### Settings -> Providers

Provider settings own backend profiles.

Fields:

- id and display name;
- kind;
- secret reference or auth mode;
- base URL or command/env injection profile when relevant;
- `supports_agents`;
- models with tier and cost label;
- enabled/disabled flag;
- health/status summary.

Actions:

- create/edit provider profile;
- test configuration without task/workspace content;
- disable provider;
- show impacted teams/phases before disabling referenced providers.

Deletion can be deferred. Disable is safer for the first implementation.

### Settings -> Routing Profiles

Routing profile settings own teams.

Fields:

- team id, display name, alias;
- default objective;
- phase rows: phase, agent, tier, provider priority, fallback order;
- enabled/disabled flag.

Actions:

- create/edit profiles;
- preview each profile using the same resolver as task dispatch;
- show validation errors before save;
- keep advanced JSON editor as escape hatch.

### Settings -> Routing Defaults

Defaults apply when task creation omits dispatch selection.

Fields:

- auto routing enabled;
- default team/profile;
- default objective;
- max attempts per step;
- terminal limit behavior, reusing `limit_policy`;
- manual fallback policy: default `off`.

## Dispatch UI

The task creation selector has exactly two modes.

```text
Routing
├─ Auto
│  ├─ Profile/Team
│  ├─ Objective: balanced | cost-min | intelligent-max
│  └─ Preview
└─ Manual
   └─ Agent -> Provider -> Model
```

Auto mode:

- show Profile/Team first;
- show Objective second;
- update preview whenever either changes;
- block submit when preview has unresolved phases;
- show fallback summary in one line.

Manual mode:

- select Agent;
- filter Provider by `supports_agents` and adapter capability;
- filter Model by selected provider;
- block unsupported or unhealthy route unless user explicitly chooses an
  ask-first path;
- submit exact selected route.

Empty/error states:

- no configured teams: show "Configure routing profile first";
- no provider supports selected agent: disable provider/model selects with reason;
- selected model unavailable due to quota/window: block in first slice;
- options/preview API failure: block submit with clear error.

All new user-visible text must use the i18n layer in English and Chinese.

## Backend Architecture

Add a small routing layer instead of spreading policy across `task.Engine`.

```text
internal/task
  startOne / runOrchestrated
        |
        v
internal/routing
  PolicyStore
  OptionsBuilder
  Previewer
  Resolver
  AvailabilitySnapshot
  FailureClassifier
        |
        +-- internal/agent.Registry
        +-- internal/provider.Registry
        +-- internal/usagewindows.Service
        +-- adapter backend capabilities
        +-- store.AgentLimitStatuses
        +-- task.BuiltinCatalog
```

Resolver API:

```go
type Request struct {
    TaskID    string
    Team      string
    Objective string
    Phase     RoutePhase
    Agent     string
    Model     string
    Tier      string
    Prompt    string
}

type Decision struct {
    Agent    string
    Provider string
    Model    string
    Tier     string
    Reason   string
    Skipped  []SkippedCandidate
}

type Resolver interface {
    Resolve(ctx context.Context, req Request) (Decision, error)
    Next(ctx context.Context, previous Decision, failure Failure) (Decision, bool)
}
```

`Resolve` handles first selection. `Next` handles same-phase, same-agent
provider/model fallback.

## API Requirements

Exact routes can follow existing API conventions, but the UI needs equivalent
capabilities.

Options:

```text
GET /api/routing/options
```

Returns agents, providers, models, teams, objectives, aliases, defaults, and
availability reasons. It must not include plaintext secrets.

Preview:

```text
GET /api/routing/preview?mode=auto&team=claude-first&objective=balanced
GET /api/routing/preview?mode=manual&agent=claude-code&provider=anthropic-byok&model=claude-sonnet-4
```

Preview is local-only. It must not send task/workspace content to providers.

Task creation:

- accepts optional `dispatch`;
- persists canonical selection, not alias;
- records prompt-level override when `@agent[model]` wins.

## Runtime Flows

### Auto Task

1. Receive task create request.
2. Resolve dispatch selection:
   - request dispatch;
   - settings default;
   - existing default behavior if routing disabled.
3. If prompt has no explicit `@agent`, run coding-task classification.
4. If coding task and routing enabled, build plan/execute/review phases.
5. Load selected team phase policy.
6. Resolve provider/model for each phase agent.
7. Fill `DelegateStep.Agent`, `DelegateStep.Model`, and provider metadata.
8. Emit `route_decision`.
9. Run existing orchestration.

### Manual Task

1. Validate selected agent/provider/model.
2. Preserve exact selection.
3. If selected route is unavailable, block or ask; do not silently change it.
4. Emit route decision with reason `manual dispatch`.

### Fallback

1. Classify failure:
   - quota/rate limit;
   - auth/config;
   - transient transport;
   - model unavailable;
   - task failure.
2. If fallback-safe, call `Resolver.Next`.
3. Retry same phase with same agent and next compatible provider/model.
4. Emit `route_fallback`.
5. If no candidate remains, apply `limit_policy`.

## Provider and Agent Decoupling

Execution agent and backend profile are separate dimensions:

```text
phase -> agent -> provider profile -> model
```

Provider switching is allowed only when both conditions hold:

1. provider profile lists the current agent in `supports_agents`;
2. adapter declares support for the provider kind.

Examples:

- Claude Code can use `claude-sub` and, when configured, `anthropic-byok`;
- Kin can use OpenAI-compatible, Anthropic-compatible, local, or proxy profiles;
- Codex/Grok can use native subscription first, custom profiles only when adapter
  support exists.

## Implementation Plan

### Phase 0: Codebase Mapping

Map exact files and call sites before editing:

- task creation request/handler;
- settings storage;
- current agent/model selector UI;
- provider settings model;
- `AutoCodingPlan` call sites;
- adapter `TaskSpec` and per-run env/config injection;
- task event persistence/rendering;
- i18n files for UI text.

Deliverable: PR description includes touched files and rationale.

### Phase 1: Policy Model and Validation

Backend:

- add routing policy structs and validation;
- add provider support matrix;
- add team/profile model;
- add default team/objective/aliases;
- generate conservative seed policy for old installs;
- add adapter capability declarations;
- add reference checks for disabling/deleting providers, models, agents, aliases,
  and teams;
- define secret write-only behavior and redacted responses.

Tests:

- invalid provider id rejected;
- unsupported provider/agent combination rejected;
- missing default team rejected when routing enabled;
- alias resolves to canonical team id;
- referenced provider disable reports impacted teams/phases;
- secret values are not returned after save;
- settings round-trip preserves policy.

### Phase 2: Options and Preview

Backend:

- implement options builder;
- implement auto preview;
- implement manual preview;
- include skipped/unavailable reasons;
- include preview metadata for later drift explanation.

Tests:

- options filter providers by agent compatibility;
- `cost-min` orders cheaper allowed candidates first;
- `intelligent-max` prefers smart plan/review;
- unresolved phases return validation errors;
- exhausted subscription windows are skipped or marked unavailable.

### Phase 3: Configuration UI

Frontend:

- update Agents page with routing capabilities;
- add Settings -> Providers;
- add Settings -> Routing Profiles;
- add Settings -> Routing Defaults;
- add advanced JSON editor;
- show impacted profiles before disabling referenced config;
- use backend validation before save.

Tests:

- Agents page shows provider compatibility;
- provider form rejects unsupported combinations;
- profile form rejects invalid phase provider;
- alias editor rejects duplicates;
- default team/objective persists;
- English and Chinese i18n updated.

### Phase 4: Dispatch Selector UI

Frontend:

- add compact selector near submit controls;
- implement Auto mode;
- implement Manual cascade;
- call options and preview;
- block submit on unresolved preview or options error;
- submit dispatch with task create request;
- show explicit-route override hint when possible.

Tests:

- auto submits `{mode, team, objective}`;
- manual filters providers after agent selection;
- manual filters models after provider selection;
- missing preview blocks submit;
- stale options do not silently submit;
- i18n updated.

### Phase 5: Persist Dispatch and Route Decisions

Backend/UI:

- parse `DispatchSelection`;
- persist canonical dispatch selection;
- persist preview snapshot or decision ids when available;
- emit route decision events;
- render dispatch, preview, decisions, and fallback in task detail.

Tests:

- old clients without dispatch still work;
- task stores canonical team id, not alias;
- old task renders after provider/profile edit;
- explicit route override is recorded;
- route decision survives reload.

### Phase 6: Auto Orchestration

Backend:

- wire `AutoCodingPlan` into `Engine`;
- add phases to generated steps;
- use selected team phase agents;
- resolve provider/model by team and objective;
- keep fallback same-agent only.

Tests:

- bare coding task triggers plan/execute/review when enabled;
- selected team phase agent is used;
- explicit `@agent` bypasses auto team selection;
- pure chat stays single-agent;
- provider/model comes from selected team.

### Phase 7: Same-Agent Fallback

Backend:

- implement deterministic candidate expansion;
- implement fallback order;
- integrate usage windows and provider health;
- enforce max attempts;
- keep per-agent limits as opt-in soft skip.

Tests:

- first available candidate selected;
- exhausted subscription skipped;
- fallback does not switch agent;
- auth/config marks only failed profile unhealthy;
- max attempts honored.

### Phase 8: Provider-Aware Adapter Runtime

Backend:

- build selected provider client/config;
- pass provider id through adapter metadata;
- implement adapter injection:
  - `kin`: selected provider client/model;
  - `claude-code`: BYOK/base URL/env/config when supported;
  - `codex`/`grok`: only supported custom profiles;
- preserve active provider default;
- attribute usage to actual provider/model.

Tests:

- `kin` uses non-active provider;
- `claude-code` uses configured Claude-compatible BYOK profile;
- unsupported provider kind fails validation;
- active provider remains default for old behavior;
- usage ledger records actual provider/model.

### Phase 9: Observability and Cleanup

- aggregate usage by phase/team/objective/provider/model;
- add fixed-task eval or local runbook;
- add examples for `claude-first`, `mixed-cheap`, and manual Claude Code BYOK;
- remove dead hard-coded routing paths once resolver owns behavior.

## Test Strategy

### Unit Tests

Backend unit tests should cover:

- routing policy parsing and validation;
- adapter capability matching;
- provider/profile reference checks;
- dispatch validation;
- resolver candidate expansion and ordering;
- objective behavior;
- failure classification;
- same-agent fallback;
- route decision event shape.

### Integration Tests

Integration tests should cover:

- settings save/load round-trip;
- old client task creation without dispatch;
- task creation with auto dispatch;
- task creation with manual dispatch;
- route decision persistence and reload;
- provider/profile edits after task completion;
- usage attribution based on actual runtime route.

### UI Tests

UI tests should cover:

- Agents page capability display;
- Providers form validation and redaction;
- Routing Profiles form validation;
- Routing Defaults persistence;
- Auto selector preview;
- Manual cascade filtering;
- unresolved preview blocking submit;
- task detail route decision rendering.

### End-to-End Smoke Scenarios

At least these local smoke tests should be runnable manually or through a thin
script:

1. Configure `claude-first`, start Auto balanced task, inspect route events.
2. Configure `mixed-cheap`, start Auto cost-min task, confirm cheap execute.
3. Start Manual Claude Code BYOK task, confirm exact route.
4. Simulate exhausted subscription, confirm same-agent provider fallback.
5. Disable provider used by old task, confirm old task still renders and new
   task preview blocks.

### Required Verification Commands

Adjust package paths to actual touched files:

```bash
go test ./internal/task/...
go test ./internal/provider/...
go test ./internal/agent/...
go test ./internal/routing/...
cd ui && npm run build
```

If UI source changes affect the shipped console, regenerate and commit
`web/dist/` according to repository rules.

## Definition of Done

The feature is not done until:

- all rows in the User Story Coverage Matrix are covered or explicitly deferred;
- relevant Go tests pass;
- UI build passes;
- task creation is backward compatible;
- no provider secret is returned in plaintext;
- manual route does not silently fallback;
- same-agent fallback is verified;
- task detail shows dispatch, preview, decisions, and fallback;
- old task history survives provider/profile edits;
- route decisions are sufficient for usage aggregation.

## Review Checklist

Backend:

- invalid provider/team/support-matrix config is rejected before dispatch;
- manual dispatch cannot select unsupported provider/model;
- auto dispatch resolves from selected team/objective only;
- preview is local-only and sends no task content to providers;
- route decisions include team, objective, phase, agent, provider, model, tier,
  reason, skipped candidates, and fallback source when relevant;
- old clients without dispatch still work.

UI:

- Agents page shows capability and compatible provider profiles;
- Settings has Providers, Routing Profiles, and Routing Defaults surfaces;
- forms use backend validation before save;
- selector has exactly `Auto` and `Manual` modes;
- `Profile/Team` appears under Auto, not as a third mode;
- Manual cascade is `Agent -> Provider -> Model`;
- impossible options are filtered or disabled with reasons;
- submit blocks unresolved routing;
- English and Chinese strings are updated.

Runtime:

- explicit `@agent[model]` remains highest priority;
- fallback does not switch agents in first implementation;
- same-agent provider/model fallback follows configured order;
- exhausted Claude/Codex windows are skipped when known;
- auth/config failures do not trigger broad fallback loops;
- old default behavior still works when routing is disabled.

## Open Questions

- Should `free` be a tier or a cost label over `fast`?
- Should per-agent daily limits skip candidates by default or only warn?
- Should review always use smart tier, or only for high-risk tasks?
- Should provider health be persisted or derived from recent task events?
- Should routing policy become project-specific later?
- What exact Claude Code BYOK knobs are supported in each installed Claude Code
  version?
