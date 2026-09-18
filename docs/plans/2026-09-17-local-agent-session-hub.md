# M9 Local Agent Session Hub

**Status:** M9.1-M9.4 implemented; M9.5-M9.6 follow-up
**Date:** 2026-09-17
**Related:** [Agent Platform Gap-Closure Plan](./2026-09-17-agent-platform-gap-closure.md), [Pluggable Agent Runtime ADR](../adr/0007-pluggable-agent-runtime.md), [Session Context ADR](../adr/0002-context-management.md), [Workspace Generations ADR](../adr/0014-workspace-generations-and-lazy-promotion.md)

## 1. Intent

Make Kin Desktop the single user-facing entry point for local agent work.
Claude Code, Codex, Droid, WorkBuddy, and future local agents remain external
execution backends. Kin owns the user-visible task timeline, approvals,
workspace policy, audit trail, and artifacts.

The user should be able to:

1. discover sessions provided by installed local agents;
2. open and resume a native agent session from Kin Desktop;
3. keep one Kin conversation while switching the execution backend;
4. hand work from one agent to another without copying the transcript by hand;
5. see which agent produced each turn, event, approval, and artifact.

This is local orchestration. Remote A2A is not required for the first release.
An A2A driver may be added later for a provider that explicitly exposes a
compatible endpoint.

## 1.1 User Stories and Closed Loop

### First-time setup

As a user who already has Claude Code, Codex, Droid, or WorkBuddy sessions on
the Mac, I open `Settings -> Local Agents` and see which local integrations
Kin can detect.

For each provider the page shows:

- detected/not detected state;
- supported operations (`list`, `history`, `resume`, `attach`);
- last discovery time and source health;
- an explicit `Import sessions` action;
- an `Auto-import` preference, off by default.

The first time Kin discovers existing unlinked sessions, it asks whether to
enable auto-import and explains that only metadata is indexed. The user can
also import once without enabling future automatic discovery.

### Browse from the Kin Desktop sidebar

After import, the user remains in Kin Desktop and sees one unified session
library. A compact `Group by` control switches between:

- `Project`
- `Agent`

Project mode displays:

```text
Projects
└── OpenKin
    ├── Claude Code (3)
    │   ├── Fix relay recovery
    │   └── Update iOS client
    ├── Codex (2)
    │   └── Harden auth middleware
    └── Droid (1)
```

Agent mode displays the same canonical session records through another
projection:

```text
Agents
├── Claude Code (4)
│   ├── OpenKin
│   │   └── Update iOS client
│   └── Other project
├── Codex (2)
│   └── OpenKin
└── Droid (1)
    └── OpenKin
```

Switching the grouping does not duplicate data or create new sessions. A
session without a validated cwd appears under `Unassigned`; an indexed
session without a Kin binding is visibly marked `Unlinked` and `Read-only`.

### Open and continue

When the user opens an external session:

1. Kin reads the provider history page on demand and renders it with a source
   badge;
2. Kin shows whether the source supports native resume;
3. `Read-only` means the user can inspect the source but Kin will not send a
   prompt;
4. `Attach to Kin` links the source session to an existing or new Kin Task;
5. `Continue` resumes the native session when supported;
6. switching to another Agent creates an auditable handoff packet.

The user can therefore go from discovery to reading to execution without
leaving Kin Desktop. No transcript clone is created at any step.

### Failure and recovery

If a provider is unavailable, the tree keeps the last metadata with a stale
indicator and offers `Refresh`. If its history format is unsupported, Kin
shows metadata and the available attach/resume capability rather than an empty
or fabricated conversation. If a provider session disappears, its indexed
entry remains recoverable as a stale link until the user removes it.

## 2. Problem Statement

The current system has useful but separate pieces:

- `tasks` is already the durable user-visible conversation aggregate;
- `tasks.session_ref` stores one provider-owned resume identifier;
- adapters normalize process events and support same-agent resume;
- `FollowUpWith` already performs a bounded cross-agent handoff;
- the Agent Registry exposes `run` and `resume` capabilities;
- the console lists Kin tasks, but not provider-owned sessions.

`session_ref` cannot represent a durable history of several provider sessions
attached to one Kin conversation. Replacing it with a new opaque identifier
would lose provider-specific resume semantics. M9 therefore keeps it as a
compatibility projection and adds an explicit binding layer.

## 3. Terminology

### 3.1 Kin session

The existing user-visible `Task` is the logical Kin session aggregate. It owns
the durable timeline, lifecycle, approvals, workspace generations, costs, and
artifacts. M9 does not introduce a competing top-level `Mission`, `Run`, or
`Job` concept.

### 3.2 Native agent session

A provider-owned conversation/session identified by an opaque reference:

- Codex thread/session;
- Claude Code resume session;
- Droid session;
- WorkBuddy/ACP session;
- another local agent session.

Kin must not infer or rewrite the internal meaning of this identifier.

### 3.3 Agent session binding

A durable association between one Kin task and one native agent session. A task
may have several bindings over time, but only one host binding is active for a
direct user turn. Delegated worker bindings remain visible through the existing
worker-step/execution model.

### 3.4 Handoff packet

A bounded, auditable context package created when a turn moves between agent
identities. It contains the current user goal, recent decisions, task and
workspace state, relevant artifacts, worker digests, and unresolved questions.
It is not a claim that the target provider can import the source provider's
hidden context.

## 4. Proposed Design Decisions

### 4.1 Keep Task as the logical session source of truth

The task engine remains authoritative for:

- status transitions and queueing;
- cancellation and interruption;
- approvals and user questions;
- workspace access and workspace generations;
- event ordering and audit;
- cost and usage attribution.

External session catalogs are advisory integrations. An unavailable provider
must not make the Kin task unreadable or undeletable.

### 4.2 Keep provider session state opaque

The provider's native session reference is stored as a string with its agent
identity and provider kind. It is never treated as globally unique without the
agent namespace, exposed as a credential, or parsed by the task engine.

### 4.3 Resume natively when possible

When the target agent is unchanged and its binding declares resume support,
Kin sends only the live user turn through the native resume path. This
preserves the provider's own context and cache behavior.

If native resume is unavailable, Kin starts a fresh native session with a
deterministic Context Pack.

### 4.4 Switch agents through a sealed handoff

When the target agent changes:

1. finish or interrupt the current turn through the normal engine path;
2. persist a handoff event and bounded handoff packet;
3. clear the active `tasks.session_ref` projection;
4. create or attach the target binding;
5. start the target adapter with the handoff packet and the new user request;
6. persist the target session reference when the adapter reports it.

The target agent must not receive the source provider's raw hidden state as if
it were native context.

### 4.5 Discovery is capability-based, opt-in, and bounded

An adapter may expose session discovery, native resume, history reading,
context export, and session metadata independently. Unsupported operations
return a typed capability result, not a fabricated empty session list.

The default import preference is `prompt`. When Kin discovers unbound local
sessions during an explicit refresh, it shows:

> Found local Agent sessions that are not linked to Kin. Enable automatic
> import so they appear in the Kin session list?

The user can choose `Enable auto-import`, `Not now`, or `Don't ask again`.
`enabled` permits bounded background/on-demand indexing; `disabled` suppresses
provider session discovery; `prompt` requires confirmation before the first
indexing pass. Auto-import means indexing and linking metadata, not creating
duplicate Kin tasks or copying provider transcripts.

Discovery is never an unbounded full scan during daemon startup. Providers
must supply timeouts, pagination, modification cursors, and output bounds.

### 4.6 Workspaces remain independent from agent sessions

A native session may outlive a physical worktree, and a Kin task may have
several workspace generations. A binding records the workspace context used
by its turns, but it does not own the workspace lifecycle. All file access and
integration still go through the existing workspace contracts.

## 5. Proposed Data Model

Keep `tasks.session_ref` as a compatibility projection for the currently
active host binding. Add two durable tables in a later implementation slice.

### 5.1 `agent_sessions`

One cached pointer to a provider-owned session discovered or observed by Kin.
This table is an index, not a transcript mirror.

| Field | Meaning |
|---|---|
| `id` | Kin-generated opaque row ID |
| `agent_id` | Registry identity, e.g. `codex` or `droid` |
| `external_ref` | Provider-native session ID |
| `source_uri` | Provider-local file or endpoint reference, when safe to retain |
| `title` | Provider title when available; otherwise bounded fallback |
| `cwd` | Validated provider session working directory |
| `status` | `active`, `idle`, `ended`, `unavailable`, or `unknown` |
| `capabilities` | JSON capability snapshot |
| `metadata` | Bounded, non-secret provider metadata |
| `source_cursor` | Provider history/index cursor or revision marker |
| `content_digest` | Optional digest of the source revision, never the content |
| `first_seen_at` | First observation |
| `last_seen_at` | Last successful observation |
| `updated_at` | Row update timestamp |

Unique key: `(agent_id, external_ref)`.

The table must not contain provider transcript messages, prompts, model output,
tool payloads, or screenshots. Kin reads those through the provider adapter
when the user opens the session. A short-lived in-memory page cache may be
used for rendering and must not become durable session history.

### 5.2 `task_agent_sessions`

The association and lifecycle history between a Kin task and a native session.

| Field | Meaning |
|---|---|
| `id` | Binding row ID |
| `task_id` | Parent Kin task |
| `agent_session_id` | Native session catalog row |
| `role` | `host`, `worker`, or `previous_host` |
| `state` | `attached`, `detached`, `stale`, or `failed` |
| `workspace_id` | Workspace generation used by this binding, if any |
| `first_turn_seq` | First task user-event sequence using the binding |
| `last_turn_seq` | Last task user-event sequence using the binding |
| `attached_at` | Binding creation time |
| `detached_at` | Binding end time |
| `last_error` | Sanitized bounded error |

Constraints:

- at most one `attached` host binding per task;
- a native session can be attached to at most one active host task unless the
  provider explicitly declares sharing;
- deleting a task removes bindings but does not delete provider sessions;
- all foreign keys are local and do not make provider availability a database
  prerequisite.

### 5.3 Existing compatibility behavior

- On a native `task_started`/`result` event, upsert `agent_sessions` and update
  the active binding.
- Set `tasks.session_ref` to the active binding's `external_ref` only when the
  binding's `agent_id` equals `tasks.agent`.
- On cross-agent handoff, clear the projection before starting the target.
- Existing tasks with only `session_ref` are lazily backfilled when opened or
  continued; migration must not require reconstructing historical provider
  sessions.
- An unbound indexed session remains an external read-only entry until the user
  attaches it to a Kin task or starts a Kin turn from it.

### 5.4 Import preference

`auto_import_mode` is a local user preference stored with the existing Kin
settings/configuration, not in the provider-session catalog:

- `prompt` (default): discover only during an explicit refresh, then ask;
- `enabled`: perform bounded background/on-demand metadata indexing;
- `disabled`: do not discover or index provider sessions.

Changing this preference never deletes provider sessions or Kin tasks. It only
controls whether Kin maintains a lightweight index of sessions it can read.

## 6. Agent Contract Extension

Keep `adapter.Adapter.Start` as the execution contract. Extend the Agent
Registry with an optional session catalog contract rather than adding provider
branches to `task.Engine`.

```go
type SessionCatalog interface {
    List(context.Context, SessionQuery) ([]SessionInfo, error)
    Inspect(context.Context, string) (SessionInfo, error)
    ReadHistory(context.Context, string, HistoryQuery) (HistoryPage, error)
    ExportContext(context.Context, string, ExportOptions) (ContextExport, error)
}
```

`Start` remains responsible for resume, streaming, and cancellation through
`TaskSpec.SessionRef`. `SessionCatalog` is for discovery, inspection, direct
history reading, and bounded context export. A provider that can resume but
cannot list sessions is valid. A provider that can list sessions but cannot
read history is shown as metadata-only.

Proposed capability additions:

- `session_list`
- `session_inspect`
- `session_history_read`
- `session_attach`
- `session_context_export`

The existing `resume` capability remains the execution capability. Capability
names must be additive and normalized in the Registry.

`SessionInfo` must contain only API-safe fields:

```go
type SessionInfo struct {
    AgentID       string
    ExternalRef   string
    Title         string
    Cwd           string
    Status        string
    UpdatedAt     int64
    Capabilities  []string
}
```

`HistoryPage` is a normalized, paginated view over provider-owned data:

```go
type HistoryPage struct {
    Items      []HistoryItem
    NextCursor string
    SourceRev  string
}
```

History items carry the provider name, opaque external message ID, role,
timestamp, bounded text/content references, and source revision. The adapter
must not return secrets or unbounded tool payloads. The API may render this
page directly and merge it visually with Kin events without inserting the
items into SQLite.

No provider token, command-line secret, raw environment, or unbounded
transcript is returned from discovery or history reads.

## 7. Handoff Contract

M9 reuses `internal/sessionctx` and the existing `handoffContext` path. It does
not add an LLM call to every switch.

The baseline packet has stable sections:

```text
[Kin session]
[User goal]
[Recent decisions]
[Current state]
[Workspace and Git]
[Artifacts]
[Worker findings]
[Open questions]
[New request]
```

Rules:

- deterministic extraction is the default;
- full event payloads remain in SQLite and are addressable by task/event
  sequence;
- worker output uses the existing bounded `WorkerDigest`;
- artifacts are referenced by ID/path and never silently copied into prompts;
- provider history is read directly when available; it is not copied into Kin
  events merely to make the UI convenient;
- an optional reviewed LLM summary may be added later at explicit seal
  boundaries, never on every turn;
- the packet records source and target agent IDs and the event sequence range.

## 8. API and UI Shape

### 8.1 Read APIs

Proposed authenticated endpoints:

- `GET /api/agent-sessions`
  - filters: `agent`, `status`, `cwd`, `linked`, `query`;
  - cursor pagination;
  - bounded provider refresh, with stale metadata visible.
- `GET /api/agent-sessions/{id}`
- `GET /api/agent-sessions/{id}/history`
  - cursor-paginated normalized history read directly from the provider;
  - returns `source_rev` and `next_cursor`;
  - does not persist transcript items.
- `GET /api/tasks/{id}/agent-sessions`
- `GET /api/agent-session-preferences`
  - returns `auto_import_mode`: `prompt`, `enabled`, or `disabled`.

### 8.2 Mutation APIs

- `PATCH /api/agent-session-preferences`
  - changes the explicit auto-import preference;
  - enabling it starts only bounded provider indexing.
- `POST /api/agent-sessions/{id}/attach`
  - attach an idle native session to a new or existing Kin task;
  - validates cwd, ownership, workspace policy, and provider capability.
- `POST /api/tasks/{id}/switch-agent`
  - explicit user action; creates a handoff and starts the next turn.
- `POST /api/tasks/{id}/agent-sessions/{bindingID}/resume`
  - resumes a selected binding through the normal Task Engine.

Existing `POST /api/tasks/{id}/prompt` remains the canonical way to send a
normal follow-up. Its `agent` field may select the target host, but the server
must route through the same binding and handoff service.

### 8.3 Desktop behavior

The sidebar remains a task/session list, not a second provider-specific
dashboard. Kin merges task rows with indexed external-session rows without
creating transcript copies. Each row may show:

- Kin title and project;
- active agent badge;
- last provider/session status;
- native resume or handoff availability;
- pending approval/question state.

The session detail header shows the current host and a deliberate “switch
agent” action. Provider-owned sessions discovered but not attached appear in a
bounded “Available local sessions” picker, marked `Unlinked`, `Read-only`, or
`Resume available`.

On the first discovery of unlinked sessions, the UI shows the auto-import
prompt. `Not now` leaves the current view unchanged; `Don't ask again` writes
`disabled`; `Enable auto-import` writes `enabled` and indexes only metadata.
Opening an indexed session requests its history page from the provider and
renders it with a source badge. If the provider cannot read history, Kin shows
metadata and the attach/resume capability instead of fabricating a transcript.

All text is added to both English and Chinese locales. Existing task and
terminal session terminology remains distinct.

### 8.4 Sidebar tree and grouping contract

The provider API returns a canonical flat session summary with:

- `project_key` resolved from the validated `cwd`;
- `project_label`;
- `agent_id` and display name;
- `linked_task_id`, if any;
- `source_state` and supported actions.

The Desktop builds two views over the same records:

#### Group by Project

```text
Project
└── Agent
    └── Session
```

The project node uses the existing project sidebar behavior (pin, archive,
recent activity, new session). Agent nodes show counts and source health.

#### Group by Agent

```text
Agent
└── Project
    └── Session
```

The agent node shows whether the provider is detected, stale, or unavailable.
The project node still links to the existing Project cover. A session has one
canonical identity and must not appear as two records merely because the
grouping mode changed.

The grouping mode is a local UI preference and is independent from
`auto_import_mode`. It defaults to `project`, because workspace/project is the
primary context for coding work. The sidebar must preserve expanded nodes and
selection across a grouping toggle when the corresponding session remains
visible.

The Settings page gains a `Local Agents` section rather than a separate
provider-specific dashboard. It contains:

- `Import sessions` for an explicit one-time scan;
- `Auto-import` mode and the data policy explanation;
- provider rows with detection, capabilities, last scan, and refresh;
- a link to the session library when imported sessions exist.

The sidebar may show a compact import banner when unlinked sessions are
available, but the authoritative control remains in Settings. This avoids
making a background scan look like an implicit permission grant.

## 9. Delivery Slices

### M9.1 — Contract and storage

- add API-safe session capability types;
- add migrations and Store CRUD for the two tables;
- add the local `auto_import_mode` preference with default `prompt`;
- upsert observed `session_ref` values;
- preserve legacy `tasks.session_ref` behavior;
- add restart and migration tests.

### M9.2 — Unified session read surface

- add Registry session catalog hooks;
- implement provider adapters that can safely list sessions;
- implement direct, paginated provider history reads where supported;
- add auto-import preference and first-discovery prompt;
- add paginated REST endpoints and generated UI contract;
- add a read-only Desktop session picker backed by source data;
- add the Settings -> Local Agents import surface;
- add Project/Agent grouping toggle and three-level tree rendering;
- do not persist transcript copies or create wrapper tasks during indexing;
- stale/unavailable providers must not fail the main task list.

### M9.3 — Attach and native resume

- attach an existing provider session to a Kin task;
- resume through the normal engine;
- persist binding and event attribution;
- test duplicate attach, stale session, ownership, and restart recovery.

### M9.4 — Cross-agent handoff

- extract the existing handoff path into a binding-aware service;
- persist handoff packet metadata and bounded event;
- switch host through one canonical API;
- preserve workspace generation and approval semantics;
- test Claude → Codex → Droid style transitions with fake catalogs.

### M9.5 — Provider conformance

Priority order:

1. Codex native resume and session observation;
2. Droid JSON-RPC session list/resume;
3. Claude Code session list/resume where the installed CLI exposes it;
4. WorkBuddy ACP/HTTP session integration;
5. optional A2A driver for a provider that explicitly supports A2A.

A missing provider capability must produce an explicit “unsupported” state.
Kin must not fall back to GUI automation silently.

### M9.6 — Optional macOS GUI fallback

Only after protocol-backed drivers are useful:

- add an explicit `macos_ui` driver;
- require Screen Recording and Accessibility permissions;
- scope actions to an allowlisted application/window;
- route clicks, typing, and screenshots through approvals and artifacts;
- mark all GUI-backed sessions as non-native and lower confidence.

This is outside the M9 core acceptance bar unless a target provider has no
usable local protocol.

## 10. Security and Failure Boundaries

- Provider session IDs are opaque and redacted from user-facing URLs where
  practical.
- A local session cannot be attached merely because its ID is guessed.
- Attach requires the current authenticated principal and validated local
  ownership.
- Cwd must pass the existing containment and workspace policy.
- Provider discovery has timeouts, output bounds, and no arbitrary shell
  expansion.
- Stale provider records are retained as metadata, never treated as runnable.
- A provider crash marks its binding stale and leaves the Kin task recoverable.
- Cross-agent handoff never bypasses approval, workspace, or permission mode.
- Native session credentials remain in the provider's own store or OS secret
  store; Kin stores no provider bearer token in `agent_sessions`.

## 11. Acceptance Criteria

1. The default `auto_import_mode=prompt` causes an explicit user prompt before
   indexing unbound provider sessions.
2. Enabling auto-import creates only bounded metadata/index rows; it does not
   create wrapper Kin tasks or copy provider transcript messages.
3. Settings exposes provider detection, one-time import, auto-import policy,
   and refresh state.
4. The sidebar can group the same canonical sessions by Project or Agent,
   with Project -> Agent -> Session and Agent -> Project -> Session trees.
5. Kin Desktop can display indexed local sessions and direct provider history
   for at least two providers without duplicating transcript data.
6. A supported native session can be attached and resumed from Kin Desktop.
7. A Kin task can perform at least two consecutive turns on different Agent
   backends with an auditable handoff packet.
8. A daemon restart preserves bindings and does not create duplicate native
   sessions on the next follow-up.
9. Existing tasks that only have `tasks.session_ref` continue to resume.
10. Provider listing/history failure, stale sessions, and unsupported
   capabilities are
   visible but do not take down the task console.
11. Approvals, questions, cancellation, usage, artifacts, and workspace
   generation remain attributed to the parent Task and concrete execution.
12. No provider secret or unbounded transcript enters the session catalog or
    history API.
13. Go tests, migration tests, OpenAPI drift, UI tests/build, `git diff --check`,
   high-model review, commit/integration, and desktop rebuild pass.

## 12. Resolved Product Decisions

1. “Auto-import” means user-approved indexing/linking, not cloning a provider
   conversation into Kin.
2. Indexed sessions do not become new Kin tasks automatically.
3. Provider history is parsed and rendered on demand from the source Agent;
   Kin stores only metadata, cursors, and bounded references.
4. The first discovery displays a prompt, with `prompt` as the default
   preference.

## 13. Remaining Review Questions

1. Should one native session be allowed to attach to multiple Kin tasks as
   read-only history, while permitting only one active writer?
2. When a provider changes or rewrites history between page reads, should Kin
   show the source revision change inline or require a manual refresh?

## 14. Manual Experience Walkthrough

The completed feature should be testable without opening any provider Desktop
application:

1. Open Kin Desktop and go to `Settings -> Local Agents`.
2. Confirm detected providers and click `Import sessions` for a one-time scan,
   or enable `Auto-import`.
3. Return to the left sidebar and choose `Group by: Project`.
4. Expand a project, then an Agent, and open an imported external session.
5. Verify that the history appears with a provider badge and that no duplicate
   Kin task was created.
6. Click `Attach to Kin` and then `Continue`; verify native resume or an
   explicit unsupported state.
7. In the active Kin session, switch to another supported Agent and send a
   follow-up; verify the handoff event, target binding, and unchanged
   workspace.
8. Switch the sidebar to `Group by: Agent` and verify that the same session
   appears under the provider and project without a second copy.
9. Disable auto-import, refresh, and verify that existing indexed metadata
   remains visible while no new provider sessions are indexed.
