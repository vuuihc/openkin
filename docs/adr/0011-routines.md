# ADR 0011: Routines (定时任务 = 一个会提醒你的收件箱)

**Status:** Accepted (implemented 2026-07-24)
**Date:** 2026-07-24
**Related:** [plan](../plans/2026-07-24-routines.md) · ADR 0008 (Project / One-Pager) · ADR 0003 (Artifacts) · [coaching-loop spec](../plans/project-coaching-loop-feature-spec.md) · PRINCIPLE §"Stable entrances" (Level 4 Routine Automation) · SYSTEM_DESIGN §3 (authority ladder)

## Context

Routines are the **last rung of the authority ladder** (`SYSTEM_DESIGN §3` ends at *user-defined routines*) and a pre-declared **Level-4 "Routine Automation" stable entrance** in `PRINCIPLE.md`, which already fixes the required elements: *triggers, bounds, permissions, last status, history, pause/delete*. This ADR is not scope expansion — it is the **first landing** of a contract the product already committed to.

The user's real need is **not an execution engine.** An agent can already write a self-rescheduling task inside a conversation. What is missing is a **home** that answers three questions at a glance:

> What routines do I have running? · What did they produce? · Which one needs me *now*?

Concretely: "review this repo's new PRs every morning", "analyze an OSS project's new commits daily." The value is **awareness + timely report + notification**, not orchestration. So the feature's center of gravity is a **reviewable inbox with push**, and execution is deliberately thin.

We rejected an earlier design that added a deterministic **probe** ("cheaply check if there's anything new before spending tokens"). Its complexity (command templates, `{{last_sha}}` variable injection, stdout-emptiness logic, circuit-breaking) outweighed the tokens it saved and broke the "small and beautiful" bar. The "is there anything new?" judgement belongs **inside the dispatched Task's own prompt**, where an agent already reads diffs and PR lists.

## Decision

A **Routine** is a saved, recurring Task whose entire reason to exist is the **result feed + notification**. Kin owns the trigger (so it can capture the output and notify) but adds no new execution concept — it reuses four existing subsystems: **Task engine, Artifacts, notify (Bark/ntfy), Projects.**

> **Routine** = `{cwd/project, agent, permission_mode, prompt, interval_secs, enabled}` + last-status/next-due bookkeeping.
> **Routine run** = a **normal Task** tagged with `routine_id`; its Artifact **is** the report.
> There is no probe, no DAG, no conditional branching, no workflow engine.

### Product rules (non-negotiable)

1. **The report is the product, not the run.** Config is secondary; the feed and the notification are the surface.
2. **Read/write separation.** A routine's *configuration* belongs to its project; a routine's *results* belong to a global inbox. (Drives the UI, below.)
3. **The agent decides whether to ring.** Each run ends with a self-reported signal — a one-line TL;DR and `noteworthy: true|false`. Kin uses it to choose **silent-into-feed** vs **push notification**. This is the only intelligence kept, and it lives in the prompt/agent, never in a probe engine.
4. **Background failure never blocks interactive work.** A run is a Task on the **shared FIFO queue** (`DefaultMaxConcurrent = 4`); any panic/error is recorded on the run and, at most, trips a circuit breaker — it does not touch user-initiated tasks.
5. **Permissions reuse the Task ladder.** A routine carries a `permission_mode`; dispatched runs go through the same approval chain. No new authority path.
6. **Pause and delete are first-class.** `enabled` toggle + CRUD; a paused routine keeps its history.
7. **Small by default (PRINCIPLE §5.11).** One primitive (recurring Task), one inbox, one push. No priority queue, no scheduling DSL, no cron-expression editor in v1 (plain `interval_secs` + catch-up).

### PRINCIPLE Level-4 contract mapping

| PRINCIPLE §Routine element | Where it lands |
|---|---|
| **triggers** | `interval_secs` + catch-up `next_due_at`, single ticker |
| **bounds** | shared-queue backpressure + per-trigger jitter + consecutive-failure circuit breaker |
| **permissions** | reuse Task `permission_mode` + approval chain |
| **last status** | `routines.last_run_at` + latest run status |
| **history** | runs feed (Tasks tagged `routine_id`) |
| **pause / delete** | `enabled` + CRUD |

### Execution shape

- **One ticker goroutine**, mounted next to `StartExpiryLoop` (the established "engine-hosted background ticker" precedent). Serial, single-threaded; no separate concurrency machinery.
- **Catch-up, not cron.** Store `next_due_at`; on tick, dispatch every routine whose `next_due_at ≤ now`, then `next_due_at += interval` (bounded catch-up, no thundering herd on restart). Add small per-routine jitter so many routines due at once do not all grab queue slots in the same instant.
- **Dispatch = `Engine.Create`** with the routine's fields + `routine_id`. From there the run is an ordinary Task: same lifecycle, same artifacts, same approvals.
- **On completion**, read the run's self-reported signal → append to the runs feed (always) → push notification (only if `noteworthy`).

### UI shape — read/write separation

Kin's nav is the left `Sidebar` footer (`NavLink`s to `/artifacts`, `/agents`, `/settings`); there is no horizontal tab bar. Routines get **both** entrances, split by read vs write:

| Surface | Role | Landing |
|---|---|---|
| **Global Routines tab** (read + alert) | Cross-project inbox: reverse-chron runs feed, unread badge, noteworthy pinned / silent folded | New `NavLink to="/routines"` in `Sidebar` footer, **parallel to Agents**, with an unread pill mirroring the Inbox pending-badge pattern |
| **Per-project button** (write + context) | Create a routine pre-scoped to this project's cwd; show "N routines on this project" | Button in `ProjectDetailPage` header action row (beside *Continue focus* / *Summarize*), optionally an icon in the sidebar project-group header |

Rationale: a routine's output is cross-time and needs a **fixed global home** — burying results inside a project detail page reproduces exactly today's "hidden entrance, low presence" problem. But *creating* a routine is naturally contextual ("watch this repo"), so the write path lives on the project. **Config belongs to the project; results belong to the global inbox.**

Routines is kept **parallel to Agents, not nested inside it**: Agents answers *who does the work*; Routines answers *when it auto-runs and where the results are* — orthogonal mental models. Nesting would dilute the inbox's presence, which is the whole point.

### Data model

- **`routines`** table: `id, project_id?, cwd, agent, permission_mode, prompt, interval_secs, enabled, last_run_at, next_due_at, consec_failures, created_at`.
- **Runs** reuse `tasks`: add `tasks.routine_id` (nullable FK) + a per-routine-run "unread/noteworthy" marker (small columns on the run or a thin `routine_runs` view). No separate execution table if `tasks` + a tag suffices.
- The **report** is the run's existing Artifact; the notification body is the agent's TL;DR line.

### Non-goals (this ADR)

- Any workflow / DAG / conditional-branch engine
- The rejected **probe** primitive (command templates, stdout-based change detection)
- Cron-expression editor, calendar UI, per-routine priority queue
- Dispatching to system cron/launchd (kin would lose visibility → no report → defeats the purpose)
- Multi-step routine chains, fan-out, or routine-triggers-routine

## Consequences

- The authority ladder reaches its final rung; PRINCIPLE's Level-4 entrance ships for the first time.
- Console IA gains a **Routines inbox** with a real unread signal — the first cross-project "attention" surface beyond per-session dots.
- Routine runs are just Tasks, so cost ledger, artifacts, approvals, and export all work unchanged.
- Risk: many routines due simultaneously can crowd interactive tasks on the shared FIFO queue. v1 mitigation is jitter + serial ticker; a dedicated low-priority lane is deferred (later).
- Risk: notification noise if agents over-report `noteworthy`. Mitigation is prompt discipline + the silent-feed default; no probe needed.

## Alternatives considered

1. **Probe-first scheduler** (cheap deterministic pre-check before dispatch) — rejected: complexity > token savings, and it re-implements judgement the agent already has. See Context.
2. **Per-project button only** (no global tab) — rejected: results are cross-time and go unseen unless the user opens that project; reproduces today's hidden-entrance complaint.
3. **Nest Routines inside the Agents tab** — rejected: orthogonal mental model; dilutes inbox presence.
4. **Hand execution to system cron / self-rescheduling in-conversation tasks** — rejected as the *product*: kin loses visibility, so it can neither aggregate history nor notify — which is the entire value.
5. **General workflow engine** — rejected: violates "small by default"; coaching-loop spec already forbids introducing a generic workflow engine.
