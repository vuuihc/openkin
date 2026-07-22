# Make task streams and delegated executions trustworthy

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This repository does not contain a root `PLANS.md`. Maintain this document according to the ExecPlan methodology supplied to the implementing agent. A contributor must be able to resume the work using only this file and the repository.

## Purpose / Big Picture

Kin is a local-first console that dispatches, watches, and approves work performed by multiple AI agents. After this change, a user watching a task will not silently lose persisted events during a burst, a newly registered agent will render correctly without adding its ID to the React console, and approval requests raised by delegated workers will identify the worker execution that requested them. Persistence failures that make a transcript or audit trail incomplete will be observable rather than silently reported as successful execution.

The behavior is visible in four ways. A slow WebSocket consumer eventually reconstructs the complete persisted event sequence. A synthetic plugin named something other than the built-in agent IDs appears under its real speaker identity. Two workers in one parent task produce distinguishable execution and approval metadata. A forced event-store failure causes an explicit degraded or failed outcome according to the policy below.

## Progress

- [x] (2026-07-22 21:30 +08) Reviewed the task engine, event bus, WebSocket client, transcript projection, orchestration, approvals, store, ADR 0006, ADR 0007, and ADR 0008.
- [x] (2026-07-22 21:30 +08) Confirmed the existing focused Go tests, 95 UI tests, and production UI build pass before implementation.
- [ ] Milestone 1: make stream delivery gap-aware and self-healing.
- [ ] Milestone 2: make transcript projection host-neutral for arbitrary registered agents.
- [ ] Milestone 3: add delegated execution identity and approval attribution.
- [ ] Milestone 4: make event persistence failures explicit and consolidate the canonical event contract.
- [ ] Run full repository verification, inspect the built UI, update this plan, and commit each coherent change.

## Surprises & Discoveries

- Observation: the durable event table already provides monotonic per-task sequence numbers and `GET /api/tasks/{id}/events?since_seq=N`, so recovery does not require a new message store.
  Evidence: `internal/store/store.go` assigns the next sequence before insert, and `internal/api/api.go` exposes `since_seq`.
- Observation: WebSocket overflow is silent and does not disconnect the subscriber.
  Evidence: `internal/task/bus.go` uses a 64-entry channel and a `default` case that drops messages.
- Observation: ADR 0007 explicitly forbids UI speaker whitelists, but `ui/src/components/chat/transcriptProjection.ts` still recognizes only the built-in IDs.
  Evidence: `resolveSpeaker` enumerates `kin`, `claude-code`, `codex`, and `grok`.
- Observation: delegated Claude workers must retain the parent task ID because the approval bridge looks up a real task row; worker identity therefore cannot be represented by replacing `task_id`.
  Evidence: the comment and `TaskSpec` construction in `internal/task/orchestrate.go` explain this constraint.

## Decision Log

- Decision: implement recovery over the existing durable event log; keep WebSocket as a low-latency notification adapter rather than a second source of truth.
  Rationale: this reuses the existing sequence and REST seam, avoids durable queue duplication, and preserves local-first simplicity.
  Date/Author: 2026-07-22 / Codex.
- Decision: retain parent `task_id` and add execution metadata for workers.
  Rationale: lifecycle, workspace, and approval lookup are task-scoped today, while attribution requires a distinct immutable identity beneath the task.
  Date/Author: 2026-07-22 / Codex.
- Decision: run Milestones 1, 2, and the additive portion of 3 in separate Kin-managed worktrees, then integrate under review. Do not parallelize canonical-contract cleanup with those changes.
  Rationale: the three slices initially touch separate files. Contract cleanup depends on their final shapes and would otherwise create avoidable merge conflicts.
  Date/Author: 2026-07-22 / Codex.
- Decision: preserve legacy event decoding in one compatibility path while making explicit `speaker` and `visibility` authoritative for new events.
  Rationale: stored local task history must remain readable after upgrade.
  Date/Author: 2026-07-22 / Codex.

## Outcomes & Retrospective

Implementation has not started. The baseline is green. Update this section after every milestone with observable behavior, remaining gaps, and any scope change.

## Context and Orientation

Kin consists of a Go daemon and task engine under `internal/`, a React/TypeScript console under `ui/`, and generated production console files under `web/dist/`. A Task is one persisted user work session. A task event is an append-only row with a task-local integer sequence. The browser initially reads events over HTTP and receives low-latency notifications over a global WebSocket.

`internal/task/bus.go` is the in-process WebSocket notification fan-out. `internal/api/api.go` writes bus messages to browser connections. `internal/store/store.go` persists events and assigns their sequence. `ui/src/pages/TaskDetailPage.tsx` merges initial, reconnect, and live events. These files form the stream path.

`internal/agent` and `internal/server/agents.go` define and register compiled agent plugins. `internal/task/orchestrate.go` plans worker waves and forwards worker events into their parent Task. `ui/src/components/chat/transcriptProjection.ts` converts raw persisted events into chat messages and progress steps. ADR 0007 requires a new agent to need only a factory and one registration line, not UI ID branches.

An execution means one concrete adapter run inside a Task. A single-agent Task normally has one host execution per turn. An orchestrated Task may have several worker executions, including parallel workers and a retry of a worker that returned only meta commentary. The current schema records only the parent Task, so approvals cannot identify the execution that raised them. `internal/task/approvals.go`, `internal/store/approvals.go`, `internal/adapter/adapter.go`, and the Claude approval bridge under `internal/adapter/claudecode/` are the relevant path.

A canonical event is the normalized meaning Kin presents independent of provider-specific payloads. New canonical events must explicitly state speaker identity, visibility to the user versus task-only progress, and, when applicable, execution identity. Historical rows may omit these fields and require compatibility decoding.

## Plan of Work

Milestone 1 makes stream delivery self-healing. First add a focused bus or API test that fills a subscriber beyond capacity and proves the old implementation can lose an event without notifying the consumer. Change overflow behavior so a subscriber cannot remain apparently healthy after losing data. The preferred small change is to mark or close only the slow subscriber, causing the existing browser reconnect flow to run. Then add client-side sequence-gap detection: when Task detail receives sequence N and its current contiguous sequence is below N-1, fetch from the last contiguous sequence before advancing the cursor. Do not use maximum received sequence as proof that all lower sequences exist. Cover duplicates and out-of-order delivery in tests. The final behavior must converge to the store's complete ordered event list without blocking the task engine.

Milestone 2 removes agent-ID knowledge from the presentation path. Change `resolveSpeaker` so an explicit canonical `speaker` or `agent` string is accepted regardless of its value. Continue excluding control-source labels such as `follow_up`, `create`, `orchestrator`, and `delegate` when they appear only as `source`. Make explicit `visibility.user` authoritative. Keep a narrowly documented compatibility rule for historical events without visibility. Add tests using an arbitrary ID such as `future-agent` both as host and worker, plus tests for stored legacy Kin and built-in worker events. Do not fetch the registry inside the pure projection function unless tests demonstrate that explicit metadata is insufficient.

Milestone 3 introduces immutable execution attribution without changing parent Task lifecycle. Define a compact execution reference containing an execution ID, optional orchestration step index, worker agent ID, and optional model. Generate a new execution ID for every adapter start, including meta-output retry. Carry the reference through `adapter.TaskSpec` and stamp it onto forwarded worker events. Extend approval creation and persistence additively so an approval may store and return execution ID, worker agent, step, and model while old approval callers remain valid. The Claude MCP configuration and request must propagate the execution reference without logging secrets. Migrations must upgrade both empty and populated databases. UI approval cards must display worker attribution when present and retain host-task fallback for historical approvals. Update English and Chinese locale files together.

Milestone 4 makes the event seam explicit and persistence failures observable. Introduce typed constants and typed envelope fields for origin, visibility, phase, and execution attribution in Go instead of adding more ad hoc maps. Keep provider payload details behind normalization helpers. In TypeScript, define discriminated canonical event metadata and isolate historical decoding in one compatibility function. Do not attempt a repository-wide rewrite in one patch: migrate orchestration and task projection first, then delete redundant wording and agent-ID heuristics once tests cover old rows. Change event append helpers to return errors. A failure to persist a final result, approval event, or canonical user-visible message must prevent a normal successful terminal state. Failure to persist disposable partial progress may degrade the live preview, but must produce an observable diagnostic if the store becomes writable again. Tests must inject store failure through a narrow internal seam rather than corrupting a real database.

After each milestone, run its focused tests, inspect the diff for unrelated changes, update this living plan, and create an atomic Conventional Commit. After all milestones, run the full Go suite, race tests for `internal/task`, `go vet`, UI tests, and UI build. Because UI source changes affect the shipped console, commit regenerated `web/dist/` with the corresponding source milestone or an immediately adjacent `build(web)` commit.

## Concrete Steps

All commands run from `/Users/YOU/works/study/kin` unless a command explicitly changes directory.

For the stream milestone, use:

    go test ./internal/task ./internal/api -run 'Test.*(Bus|WebSocket|Slow|Gap)' -count=1
    cd ui && npm test -- --run src/components/chat src/pages && cd ..

For host-neutral projection, use:

    cd ui
    npm test -- --run src/components/chat/transcriptProjection.test.ts
    npm run build
    cd ..

For execution and approval attribution, use:

    go test ./internal/adapter/... ./internal/task/... ./internal/store/... ./internal/api/...
    go test -race ./internal/task/...
    cd ui && npm test -- --run && npm run build && cd ..

For final verification, use:

    gofmt -w <every changed Go file>
    go test ./...
    go test -race ./internal/task/...
    go vet ./...
    cd ui && npm test -- --run && npm run build && cd ..
    git status --short

Expected successful output includes all Go packages reporting `ok`, all Vitest files passing, TypeScript emitting no errors, and Vite writing the production bundle to `web/dist/`. The pre-existing untracked `nohup.out` is unrelated and must never be staged.

## Validation and Acceptance

Stream acceptance is behavioral: publish more events than one subscriber can consume, allow the browser recovery path to run, and assert that every persisted sequence appears exactly once in ascending order. The task engine must never block on the slow subscriber. The connection indicator must not remain connected while its stream is known to have a hole.

Plugin acceptance is behavioral: pass canonical host and worker events with speaker `future-agent` through `buildChatItems`. The host message must appear as a normal agent message and the worker event with `visibility.user=false, task=true` must appear only as progress. No production file may enumerate `future-agent` or require adding it to a known-ID list.

Execution acceptance is behavioral: run two worker adapters for one parent Task and have each request an approval. The returned and persisted approvals must share the parent `task_id` but have different execution IDs and correct worker labels. A retry of one worker must receive a third execution ID. Historical approvals without execution fields must still load and render using the parent Task agent.

Persistence acceptance is behavioral: inject a failure while storing a final user-visible result. The Task must not finish as succeeded with an apparently complete audit trail. Existing normal execution tests must continue to pass without changing provider-specific adapters to know storage details.

No acceptance criterion permits silently rewriting One-Pager goals, changing workspace isolation semantics, introducing per-worker worktrees, or adding a new user-facing project-management entity.

## Idempotence and Recovery

Tests and builds are repeatable. Database schema changes must be additive and ordered through the existing migration mechanism. A migration must not derive execution identity for historical rows; nullable fields preserve their honest unknown state.

Kin parallel implementation tasks must use isolated worktrees. Each task commits only its assigned files and this plan update. Integration happens by reviewing and cherry-picking those commits into the initiating branch. If two tasks unexpectedly touch the same file, do not resolve by accepting one whole file; inspect and combine reviewed hunks. Never reset the user's source checkout or remove `nohup.out`.

If a Kin task fails, its worktree and events remain available for diagnosis. Restart only the failed milestone with a new execution assignment. If a migration fails on a populated database test, fix the forward migration; do not reset or delete user data.

## Artifacts and Notes

Baseline evidence recorded before implementation:

    go test ./internal/task/... ./internal/store/... ./internal/api/...
    ok github.com/vuuihc/kin/internal/task
    ok github.com/vuuihc/kin/internal/store
    ok github.com/vuuihc/kin/internal/api

    cd ui && npm test -- --run
    Test Files 11 passed (11)
    Tests 95 passed (95)

    cd ui && npm run build
    built successfully; Vite reported only the existing large-chunk warning

The shortest first red test should demonstrate silent subscriber overflow. The shortest product proof should then show the same persisted sequences recovered through the client path.

## Interfaces and Dependencies

Use the existing standard library, SQLite store, `nhooyr.io/websocket`, React, Zustand, and Vitest dependencies. Do not add a queue, broker, schema-generation framework, or state-management library for this work.

The stream Module must retain the append-first rule: persist an event before attempting live notification. Its browser-side cursor represents the highest contiguous sequence, not the maximum sequence ever observed.

Extend `adapter.TaskSpec` with optional execution metadata in a backward-compatible form. The parent `ID` remains the Task ID. Execution IDs must be opaque, locally generated, safe for logs, and unique within practical process lifetime. The orchestration step uses a stable zero- or one-based convention documented in the type and JSON field.

Extend `store.Approval` and the approvals table with nullable execution fields. All list/get/create paths must round-trip them. The public JSON response remains additive. The internal approval request accepts the same optional fields, validates that any supplied worker identity is consistent with the execution metadata supplied to the adapter, and never trusts arbitrary browser input to impersonate a worker.

Canonical event metadata must distinguish transport type from semantic origin. `message`, `tool_use`, `tool_result`, `usage`, and `result` remain event transport types. Speaker, audience/visibility, orchestration phase, and execution reference are metadata. Provider-specific content remains payload data interpreted by normalization adapters.

Revision note (2026-07-22): initial plan created from the architecture review. It sequences three low-conflict parallel milestones before the cross-cutting event-contract cleanup so implementation remains reviewable and recoverable.
