# Agent Platform Gap-Closure Plan

**Status:** M0/M1 complete; M2 local implementation complete; M3-M8 pending
**Date:** 2026-09-17
**Goal:** Turn OpenKin from a strong local agent console into a reliable,
extensible agent control plane without giving up local-first ownership,
cross-provider routing, explicit authority, or recoverability.
**Reference products:** OpenAI Codex, Claude / Claude Code / Cowork, Factory
Droid.
**Related:** [PRINCIPLE.md](../../PRINCIPLE.md),
[SYSTEM_DESIGN.md](../../SYSTEM_DESIGN.md),
[Auto Model Routing](./2026-07-28-auto-model-routing.md),
[Routines ADR](../adr/0011-routines.md),
[Workspace Generations ADR](../adr/0014-workspace-generations-and-lazy-promotion.md),
[Continuous-Learning Eval ADR](../adr/0012-continuous-learning-eval.md).

## 1. Product Outcome

OpenKin should be the user-owned control plane that can:

1. keep work moving without a person waiting for a provider quota window;
2. run as many saved Routines as the user's machine can sustainably service,
   without an artificial product-count cap;
3. route each phase to the cheapest model likely to meet its quality target;
4. supervise Kin, Claude Code, Codex, Droid, and generic CLI workers through one
   task, approval, workspace, and audit contract;
5. expose that control plane to external agents through standard protocols;
6. acquire reusable Skills and tool connectors without turning every workflow
   into new schema and UI machinery;
7. run browser and remote/background work inside explicit safety boundaries;
8. measure whether routing and automation improve quality, latency, and cost.

The product is not another vendor-specific coding client. Its durable advantage
is:

> One local-first task system, one approval boundary, one audit history, and any
> compatible worker or model.

## 2. Baseline Audit

Several requested capabilities already exist. They must be hardened and made
obvious rather than rebuilt.

| Capability | Current state | Remaining gap |
|---|---|---|
| Quota wait and continue | Shipped. `limit_policy=wait` is the default; reset-aware timers retry automatically; durable waits survive daemon restart, unknown reset times probe, and claims prevent duplicate retries. | Notification thresholds and long-term wait analytics remain follow-up work. |
| Scheduled tasks | Shipped as Routines. Creation has no product-level count cap. Cursor/search listing, atomic claims, bounded background concurrency, explicit missed-run policy, and backlog health are implemented. | Queue watermark tuning and richer delay estimates remain follow-up work. |
| Auto model routing | Shipped for the local M1 scope. Profiles, adaptive complexity/quality floors, provider/model compatibility, usage-window preflight, same-agent fallback, previews, and route audit events exist. | Learned latency/quality weights, full savings simulation, and cross-agent fallback remain follow-up work. |
| Isolated workspaces | Shipped. Workspace generations, lazy promotion, durable diff review, fast-forward integration, and physical worktree release exist. | No first-class multi-worker mission view or optional GitHub/GitLab PR handoff. Parallel writers must remain serialized until merge semantics are explicit. |
| Mobile control | Shipped for iOS P0/P1. | Push/deep-link coverage and background-task summaries need product hardening. |
| MCP | Internal worker bridge and public control-plane MCP server now coexist. Public MCP supports bounded read tools, scoped writes/admin actions, stdio proxy, Streamable HTTP, audit, and idempotency. | External Claude/Codex/Droid conformance runs and the connector-host side remain follow-up work. |
| Skills | Agent discovery knows common skill directories. Prompt recipes and Routines exist. | No OpenKin-owned file-backed Skill registry, validation, permission manifest, installation flow, or invocation audit. |
| Eval/replay | Durable events, usage, checkpoints, and ADR 0012 exist. | No implemented eval service, suite runner, comparison report, or regression dashboard. |
| Browser/computer use | Can be delegated indirectly to capable external agents. | No OpenKin-owned, scoped browser worker with evidence capture and approval gates. |
| A2A | None. | No Agent Card or A2A task facade. |

### 2.1 Factory Droid lessons to adopt

Factory's useful patterns are:

- Alloy routes work across models to balance quality, latency, and cost.
- Complexity tiers can map subagents to lighter or stronger models.
- Background subagents have independent context and explicit result retrieval.
- Automations support scheduled, Slack, and GitHub triggers.
- Skills, plugins, MCP connectors, and headless execution are separate,
  composable surfaces.
- Missions separate planning, worker execution, and validation.

References:

- <https://docs.factory.ai/model-independence/factory-router>
- <https://docs.factory.ai/harness/subagents>
- <https://docs.factory.ai/web/automations>
- <https://docs.factory.ai/missions/reference>
- <https://docs.factory.ai/harness/skills>
- <https://docs.factory.ai/harness/connectors>

OpenKin should adopt the composability and routing discipline without adopting
Factory's hosted identity and organization control plane as a core dependency.

## 3. Locked Product Decisions

### 3.1 No artificial Routine count limit

- OpenKin does not impose a subscription-style count cap on saved Routines.
- Resource bounds apply to execution concurrency, queue depth, payload size,
  retention, and polling work, not to the number of definitions.
- The UI must use pagination/search rather than silently showing only the first
  100 Routines.
- When demand exceeds capacity, OpenKin shows backlog and estimated delay. It
  does not silently drop runs.

### 3.2 Quota waits are durable work, not UI reminders

- "Wait and auto-continue" remains the default.
- Waiting survives daemon restart, desktop restart, network loss, and a reset
  time more than 48 hours away.
- Unknown reset times use bounded provider-window probes with exponential
  backoff; they do not require the user to keep a task page open.
- Each retry is idempotent and tied to the failed turn/event epoch.
- Repeated quota failures re-arm the wait until policy or user intent changes.

### 3.3 Auto routing optimizes under an explicit quality floor

- `cost-min` means "lowest expected cost that still satisfies the configured
  quality floor", not "always choose the cheapest model."
- Routing may use metadata, local history, and provider limit status. Preview
  must not send task or workspace contents to every provider.
- Explicit `@agent[model]` and exact manual dispatch remain higher precedence.
- Every decision and fallback remains visible in task history.
- No opaque online self-modification: learned weights or score updates require
  reproducible eval evidence and a reviewable configuration change.

### 3.4 One task remains the user-visible aggregate

- Worker runs, routed phases, browser sessions, and protocol calls attach to a
  Task.
- Do not introduce "Mission", "Workflow", "Run", and "Job" as four competing
  top-level nouns. A complex task may have a plan and worker executions, but the
  default UI still presents one Task.
- Multiple read-only workers may run in parallel.
- Writable workers share one workspace generation and are serialized in the
  first release. Per-worker worktrees and automatic merge choreography remain
  deferred until evidence demands them.

### 3.5 Protocols do not bypass authority

- MCP and A2A calls use the same task engine, credential scopes, approvals,
  workspace policies, and audit events as first-party clients.
- Protocol endpoints never expose the daemon master token to a model.
- Read tools and write tools have separate scopes.
- Remote protocol access is opt-in and disabled by default.

## 4. Target Architecture

```text
External hosts
Claude / Codex / Droid / other MCP or A2A clients
                    |
          MCP server / A2A facade
                    |
          OpenKin application services
                    |
     Task + Approval + Workspace + Artifact
                    |
       Routing + Worker execution contract
          /          |             \
   local CLI     browser worker   optional remote worker
                    |
       Skills + MCP connectors + audit
```

The daemon remains the source of truth. Protocol adapters and client surfaces
must call application services rather than duplicating task policy in transport
handlers.

## 5. Delivery Sequence

### M0 — Contract and documentation convergence

**Goal:** Make the repository describe what is already shipped before adding
new machinery.

#### Work

1. Mark the implemented portions of the auto-routing plan as complete and list
   its real residual gaps.
2. Update `SYSTEM_DESIGN.md` and `SYSTEM_DESIGN.zh.md`:
   - automatic routing is no longer "later";
   - Routines have no definition-count cap;
   - quota waits auto-continue by default;
   - workspace generations are the current model;
   - internal MCP bridge is not the external control-plane MCP server.
3. Add an ADR only where this plan changes an accepted boundary:
   - durable quota wakeups;
   - Routine fairness/backlog semantics;
   - public MCP authority model.

#### Acceptance

- Architecture docs and code no longer contradict each other.
- Existing behavior is covered by links to tests, not claims based only on
  plans.

### M1 — Unattended execution reliability

**Goal:** A user can leave a task or a large Routine set unattended and trust
OpenKin to resume or report a durable reason why it cannot.

#### Slice 1: Durable quota wakeups

**Primary areas:** `internal/task`, `internal/store`, `internal/usagewindows`,
`internal/api`, Desktop/Web task detail, iOS task detail.

1. Add a narrow persisted `task_limit_waits` record:
   - `task_id` primary key;
   - failed turn identity (`event_epoch` and user-event sequence);
   - provider/agent/model;
   - `resume_at`;
   - state (`waiting|probing|retrying|canceled|completed|blocked`);
   - attempt count, last error, next probe time, timestamps.
2. Write the wait record before arming an in-memory timer.
3. Replace the startup `ListTasks(... Limit: 200)` recovery scan with a direct
   indexed query over due/open wait records.
4. Remove the semantic 48-hour cap. Long waits use the persisted deadline; the
   in-memory timer may wake in bounded chunks without changing `resume_at`.
5. For unknown reset times:
   - probe the provider window on an exponential schedule;
   - use a conservative minimum retry delay when no structured window exists;
   - stop only on explicit user action, permanent auth/config failure, or a
     configurable maximum elapsed wait.
6. Claim a due wait transactionally before retry so two wake paths cannot
   replay the same turn.
7. If retry hits quota again, update the same record with the new reset window
   and continue waiting.
8. Expose durable wait state, retry count, and next wake time in REST,
   WebSocket invalidation, Desktop/Web, and iOS.
9. Send notifications only for:
   - resumed successfully;
   - blocked permanently;
   - waiting longer than the user-configured threshold.

#### Slice 2: Routine scale without a count cap

**Primary areas:** `internal/routines`, `internal/store/routines.go`,
`internal/task` queueing, Routine API/UI/iOS.

1. Keep Routine creation unlimited at the product layer.
2. Add cursor pagination and search/filter to Routine definitions and run
   history. Remove UI assumptions that `limit=100` is the complete set.
3. Replace one fixed `LIMIT 50` due scan with bounded draining:
   - transactionally claim due Routines;
   - process pages until the tick time budget or queue watermark is reached;
   - leave unclaimed rows due and visible as backlog.
4. Add a background lane:
   - interactive tasks always receive at least one execution slot;
   - configurable Routine concurrency defaults to one;
   - total worker concurrency remains bounded;
   - no Routine is silently skipped.
5. Make missed-run behavior explicit:
   - default `coalesce`: one run after downtime, then advance;
   - optional `skip`;
   - no unbounded catch-up burst.
6. Add scheduler health:
   - due backlog count;
   - oldest due age;
   - running Routine count;
   - last scheduler error;
   - per-Routine next due and last outcome.
7. Add load tests with at least 10,000 Routine definitions and 1,000
   simultaneously due rows. Definition count must not cause linear work on
   ordinary ticks beyond indexed due queries.

#### Slice 3: Auto-routing efficiency convergence

**Primary areas:** `internal/routing`, `internal/task`, `internal/usagewindows`,
`internal/store/agent_limits.go`, routing UI.

1. Add a local complexity classifier with deterministic features:
   - prompt size and requested operation;
   - repository scope and changed-file estimate when available;
   - whether tools, images, browser, or long context are required;
   - phase role (`plan|execute|review|chat`);
   - Routine versus interactive priority.
2. Map complexity to a quality floor (`light|medium|heavy`) separately from
   model tier. Keep the mapping user-visible and configurable.
3. Feed candidate scoring with:
   - provider/model tier and cost label;
   - configured per-agent daily limit;
   - subscription-window utilization/reset time;
   - recent latency/error rate;
   - explicit profile/provider priority;
   - task objective.
4. Make the phase plan adaptive:
   - light tasks may execute once without separate plan/review calls;
   - medium tasks use plan or review only when useful;
   - heavy tasks retain plan/execute/review;
   - a user/profile may force phases.
5. Prefer free/local/Core-like candidates for Routine and read-only work when
   they meet the quality floor.
6. Preserve same-agent provider/model fallback first. Cross-agent fallback is
   opt-in and only allowed at a durable turn/phase boundary.
7. Extend route events with score components and the rejected candidate reason,
   without logging secrets or full prompts.
8. Add a routing simulator in Settings that evaluates saved task metadata
   offline and reports expected provider/model/phase choices and estimated
   savings.

#### M1 acceptance

- A quota-limited task resumes after daemon restart with no page open.
- More than 200 simultaneous waits recover correctly.
- Unknown reset time eventually probes and resumes or reaches a visible blocked
  state.
- 10,000 saved Routines are listable/searchable and do not create a count-limit
  error.
- A Routine backlog cannot consume every interactive worker slot.
- Trivial coding tasks no longer always pay for three model phases.
- Routing tests demonstrate lower cost at an unchanged configured quality
  floor on a fixed fixture set.

### M2 — Public OpenKin MCP server

**Goal:** Let Claude, Codex, Droid, and other MCP hosts operate OpenKin through a
stable, permissioned tool surface.

#### Slice 1: Application service boundary

1. Extract transport-neutral task operations from HTTP handlers where needed.
2. Keep handlers thin and reuse the same services from REST and MCP.
3. Define typed errors that map consistently to HTTP and MCP tool results.

#### Slice 2: Read-only MCP

Expose local stdio and optional Streamable HTTP transports:

```text
list_tasks
get_task
list_task_events
list_projects
list_artifacts
read_artifact
list_routines
get_usage
get_routing_status
```

Requirements:

- bounded pagination and response sizes;
- no raw secrets or unrestricted filesystem paths;
- resource URIs for task transcripts and artifacts;
- per-call audit principal and client identity.

#### Slice 3: Mutating MCP

Add:

```text
create_task
send_task_message
cancel_task
retry_task
continue_task
approve_task_action
answer_task_question
run_routine
```

Requirements:

- read/write/admin scopes;
- write tools disabled for device credentials unless explicitly allowed;
- task creation still applies workspace, routing, and permission policy;
- approval tools cannot approve their own originating high-risk action without
  the normal human gate;
- idempotency keys on task creation and retry-like operations.

#### M2 acceptance

- Claude Code, Codex CLI, and Droid can each connect to the same local MCP
  server and create/read a Kin task.
- A remote MCP client with read scope cannot mutate tasks or settings.
- Restart and duplicate-call tests prove idempotency.
- MCP and REST produce equivalent task/audit outcomes.

### M3 — Multi-worker task supervision and Git handoff

**Goal:** Match the useful part of Codex multi-agent and Factory Missions while
keeping one Task and one workspace ownership model.

#### Work

1. Formalize a task plan as persisted, append-only worker steps:
   - role, dependency, agent, provider/model, access (`read|write`), status;
   - execution identity and result summary;
   - no separate user-visible workflow product.
2. Allow parallel read-only worker steps with bounded fan-out.
3. Serialize writable steps against the task's active workspace generation.
4. Add coordinator controls:
   - pause/continue one worker;
   - retry a failed step;
   - replace route for the next attempt;
   - cancel remaining steps;
   - ask the coordinator to revise the remaining plan.
5. Render a compact worker timeline inside Task detail rather than a new
   dashboard.
6. Keep current immutable generation-aware diff review.
7. Add optional GitHub/GitLab connector actions:
   - publish branch;
   - open/update PR;
   - read CI/check status;
   - attach PR/check results to the Task.
8. Require explicit approval before push, PR creation, merge, or deployment.

#### Acceptance

- A heavy task can run two read-only investigations in parallel and one writer
  afterward.
- No two writers mutate the same generation concurrently.
- Route/provider changes affect only future attempts and remain audited.
- Local completion still works with no Git hosting account.
- PR integration is optional and never required for workspace finalization.

### M4 — Skills and connector ecosystem

**Goal:** Add reusable capability without adding a dedicated product subsystem
for every workflow.

#### Slice 1: File-backed Skills

1. Adopt a compatible `SKILL.md` package shape with:
   - instructions;
   - scripts/resources;
   - supported agents;
   - required tools/connectors;
   - declared permissions and network domains;
   - version/source metadata.
2. Support project, user, and bundled scopes with deterministic precedence.
3. Validate packages before activation:
   - path containment;
   - manifest/schema;
   - executable files;
   - declared permissions;
   - duplicate names and version conflicts.
4. Record which Skill/version influenced each task.
5. Start with local folders and explicit URL/Git imports. Marketplace discovery
   is read-only until signature/provenance policy is defined.

#### Slice 2: MCP connector host

1. Add an MCP client manager for local stdio and remote Streamable HTTP servers.
2. Store connector credentials in the OS secret store.
3. Implement OAuth where required without exposing tokens to task transcripts.
4. Add per-connector and per-tool allowlists, timeout, cancellation, and output
   bounds.
5. Present connector tools to Kin and supported managed workers through a
   normalized tool policy.
6. Ship a small reference set rather than a broad bespoke integration layer:
   GitHub, Linear/Jira, Sentry, and one document/communication connector.

#### Acceptance

- Installing a Skill changes behavior without a schema migration.
- Removing a Skill does not make historical task audit unreadable.
- A connector can be disabled or revoked immediately.
- Tool calls identify connector, tool, principal, task, arguments hash, result
  status, latency, and approval decision.

### M5 — Background and optional remote workers

**Goal:** Keep work running when the Desktop window is closed and make
additional compute user-owned and optional.

#### Work

1. Harden daemon lifecycle:
   - launch-at-login/service installation;
   - crash restart;
   - active-task sleep prevention;
   - clean shutdown and worker reconciliation.
2. Complete push/deep-link coverage for:
   - approval/question;
   - quota wait/resume/block;
   - Routine noteworthy/failure;
   - task completion;
   - worker offline.
3. Define a narrow worker protocol:
   - capability advertisement;
   - lease/heartbeat;
   - task assignment;
   - event/artifact streaming;
   - cancellation and loss recovery.
4. First remote target is a user-owned headless Kin daemon over the existing
   Relay/HTTPS path.
5. Do not add an official OpenKin account, mandatory Kin cloud, or silent source
   upload.
6. Add managed cloud execution only after a separate privacy, credential,
   billing, and data-lifecycle decision.

#### Acceptance

- Closing Electron does not stop a daemon-managed task.
- Host restart recovers durable task, wait, Routine, and workspace state.
- iOS can distinguish host offline, worker lost, quota waiting, and task
  completed.
- A user-owned remote worker can be revoked without rotating unrelated device
  credentials.

### M6 — Browser and computer-use worker

**Goal:** Let tasks inspect and operate web applications with evidence while
keeping browser authority narrower than daemon authority.

#### Browser P0

1. Use a proven browser engine/connector such as Playwright, not a custom
   automation protocol.
2. Run in an isolated browser profile per task or explicit reusable profile.
3. Add domain allowlists, download/upload boundaries, and bounded storage.
4. Require approval for:
   - login handoff;
   - sending messages/forms;
   - purchases;
   - destructive/admin actions;
   - downloading or uploading sensitive files.
5. Save screenshots, console/network errors, and key actions as task evidence
   or Artifacts.
6. Support human takeover for CAPTCHA, SSO, or judgment-heavy steps.

#### Desktop automation P1

- Optional macOS Accessibility plugin.
- Explicit per-application authorization and visible active-session indicator.
- No default access to password managers, terminal, system settings, or other
  applications outside the allowlist.

#### Acceptance

- A browser QA task can navigate, interact, capture evidence, and produce a
  reproducible report.
- Browser credentials never appear in events or export.
- External side effects cannot occur without the configured authority level.

### M7 — Replay, eval, and routing feedback

**Goal:** Establish a measurable quality loop before making routing adaptive.

#### Work

1. Implement ADR 0012 P0 on top of ordinary Tasks:
   - suite loader;
   - repeated runs;
   - deterministic checkers;
   - usage/latency/turn metrics;
   - result Artifact.
2. Add task replay modes:
   - inspect-only projection replay;
   - fork from checkpoint with current configuration;
   - controlled rerun against another route/profile.
3. Build routing comparisons:
   - same fixture/profile across candidate models;
   - pass rate, cost, latency, retries, and human corrections;
   - confidence interval/noise floor.
4. Update routing score inputs only from reviewed eval summaries.
5. Add a Routine that runs the routing regression suite and notifies only on a
   meaningful quality or cost regression.

#### Acceptance

- A saved suite can compare `balanced` and `cost-min` reproducibly.
- A cheaper route is promoted only when it meets the quality floor outside
  noise.
- Historical tasks retain the exact route and Skill/config versions used.

### M8 — A2A facade

**Goal:** Let other agent platforms delegate long-running work to Kin after the
task and authority contracts are stable.

#### Work

1. Publish an opt-in Agent Card describing Kin capabilities and authentication.
2. Map A2A task lifecycle to the existing Task state machine.
3. Stream normalized progress and return Artifacts as A2A artifacts.
4. Map input-required states to OpenKin approvals/questions.
5. Support cancel and follow-up without inventing a second task store.
6. Keep MCP for tool-level operations; use A2A only for agent-level delegation.

#### Acceptance

- An A2A client can create, observe, answer input, cancel, and receive the final
  Artifact for a Kin task.
- A2A cannot access internal tools or memory not declared by the Agent Card and
  granted scope.
- Loss/retry behavior remains idempotent.

## 6. Dependency Order

```text
M0 docs/contracts
  |
  v
M1 unattended reliability
  |
  +--> M2 public MCP --------> M8 A2A
  |
  +--> M3 multi-worker/Git
  |
  +--> M4 Skills/connectors --> M6 browser/computer use
  |
  +--> M5 background/remote workers
  |
  +--> M7 eval/replay --------> adaptive routing updates
```

M1 is the first implementation target because it directly removes daily
supervision cost and strengthens advantages OpenKin already has. M2 follows
because it makes the existing control plane useful from Claude, Codex, and
Droid immediately. A2A is intentionally last: its value depends on a stable
task contract, while MCP can deliver practical interoperability sooner.

## 7. Release Slices

Do not implement this document as one branch.

| Release | Included milestones | User-visible promise |
|---|---|---|
| R1 | M0 + M1 | "Leave it running: quotas resume, Routines scale, Auto uses the right budget." |
| R2 | M2 | "Control Kin from Claude, Codex, or Droid through MCP." |
| R3 | M3 | "Supervise parallel investigations, one safe writer, and optional PR handoff." |
| R4 | M4 | "Install reusable Skills and connect real work tools." |
| R5 | M5 + browser portion of M6 | "Run reliably in the background and verify work in a browser." |
| R6 | M7 | "Measure quality/cost and improve routing with evidence." |
| R7 | M8 | "Accept delegated work from A2A-compatible systems." |

Each release gets its own worktree, focused plan/checklist, tests, high-model
review, Conventional Commit, integration into `main`, and Desktop rebuild when
daemon/UI code changes.

## 8. Verification Strategy

### Required per slice

- Store migrations: fresh and populated upgrade coverage.
- Task/routing/scheduler concurrency: focused race tests.
- Protocols: conformance fixtures, malformed input, cancellation, timeout,
  duplicate request, scope denial, and reconnect tests.
- UI: English/Chinese i18n, loading/empty/error/disconnected states, desktop
  and narrow-width inspection.
- Security: secret redaction, path containment, SSRF/egress policy, tool output
  bounds, and authorization matrix.

### Repository gates

```bash
go test ./...
go test -race ./internal/task/... ./internal/routines/... ./internal/routing/...
go vet ./...

cd ui
npm test
npm run build
```

Additional gates:

- iOS simulator build/tests for task, Routine, routing, and notification
  contract changes.
- MCP Inspector/conformance checks for M2/M4.
- Load fixture for 10,000 Routines and 1,000 due entries.
- Failure-injection restart tests for quota wakeups and remote workers.
- Browser screenshots and evidence checks for M6.

## 9. Success Metrics

| Metric | Target |
|---|---|
| Quota waits needing manual continuation when reset is known | 0 |
| Waiting tasks lost across daemon restart | 0 |
| Routine definition product cap | None |
| Interactive slot availability during Routine backlog | At least 1 |
| Duplicate scheduled run from one due occurrence | 0 |
| Cost reduction from `cost-min` on accepted eval suite | At least 20% with no statistically meaningful quality regression |
| Route decisions with auditable reason | 100% |
| External mutating protocol calls with principal/scope audit | 100% |
| Browser side effects outside configured approval policy | 0 |
| Historical tasks readable after Skill/provider/profile deletion | 100% |

## 10. Explicit Non-Goals

- Mandatory OpenKin account or hosted control plane.
- Reimplementing Claude Code, Codex, or Droid model loops inside Kin.
- Unlimited execution concurrency; only saved Routine definitions are
  uncapped.
- A general visual DAG editor.
- Per-worker writable worktrees in the first multi-worker release.
- Silent provider, agent, or model changes that are absent from task history.
- Sending prompts to multiple providers merely to choose a route.
- Installing arbitrary marketplace code without provenance and permission
  review.
- Using desktop UI automation as the primary way to control Claude, Codex, or
  Droid.
- A2A before the MCP and task authority contracts are stable.

## 11. First Implementation Cut

Start with **M1 only**, split into three reviewed changes:

1. `fix(task): persist quota waits and resume durably`
2. `feat(routines): scale scheduling without definition caps`
3. `feat(routing): make auto routing budget and complexity aware`

Do not begin public MCP or additional platform surfaces until these checks are
green:

- restart recovery for known and unknown quota windows;
- Routine backlog fairness and 10,000-definition load test;
- routing fixture demonstrating lower usage without quality-floor regression;
- Desktop/Web and iOS show the same durable state.
