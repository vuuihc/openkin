# W1b — Close the contract gaps found by the W2 probe

Status: **complete**. Contract commit: `8ef5c183` on
`lody/w1b-contract-payloads`; this report follows in its own commit.
Date: 2026-11-01.

## Result

The independent cold-start client (W2) found nine undocumented behaviors. W1
closed the credential story and documented `DELETE /api/tasks/{id}` as an
operation; W1b makes the rest of what the probe had to guess publishable:

- `TaskEvent.payload` is a schema, not `{}`: attribution, message deltas and
  content blocks, tool calls/results, approvals, questions, results, errors,
  usage, and the lifecycle events W2 observed.
- the SSE endpoint states its transport behavior: `retry`, heartbeat cadence,
  no readiness signal, no replay, gap detection, and the ADR-0024
  open-then-drain order.
- `workspace_mode`, `permission_mode`, `decided_via`, `Task.status`, and the
  workspace fields have documented values, defaults, and failure behavior.
- timestamp units are stated on every integer timestamp schema this change set
  touches; the operator routes W2 exercised state `401`/`403`.

No handler, storage, UI, or runtime file changed. The only TypeScript changes
are the generated contract types, a new type-level regression test, and six
test-only fixture edits (listed below).

| W2 finding | Outcome | Where the contract answers it |
| --- | --- | --- |
| §5.1 no credential bootstrap / `securitySchemes` | **Fixed** (security schemes in W1; this change set adds the missing `401`/`403` to the operator routes W2 used) | `info.description` → Authentication failures; pairing/devices/revoke/delete operations |
| §5.2 every event payload `{}` | **Fixed** | `TaskEvent`, `TaskEventPayload`, `TaskEventContentBlock`, `RoundChangedFile` |
| §5.3 SSE has no readiness/gap signal, `retry` undocumented | **Fixed** | `GET /api/events` description and `503` response |
| §5.4 `workspace_mode` / `cwd` resolution undocumented | **Fixed** | `CreateTaskRequest.cwd`, `.workspace_mode`; `Task.workspace_mode`, `.workspace_policy`, `.workspace_scope`, `.execution_cwd` |
| §5.5 permission bypass invisible; `decided_via` undocumented | **Partially fixed** — the observable rule and the ladder are documented; a per-turn "bypassed" stamp is a decision (below) | `CreateTaskRequest.permission_mode`; `AgentInfo.permission_modes`; `DeviceAgent.permission_modes`; `Approval.decided_via` |
| §5.6 paired ids are `ios-<hex>` | **Documented as behavior**; renaming the prefix would be a decision (below) | `PairingExchangeResponse.device_id`, `Device.id`, `Approval.decided_via` |
| §5.7 `DELETE /api/tasks/{id}` undocumented / master-only | **Fixed** (operation in W1; wording corrected to operator-only and statuses added here) | `DELETE /api/tasks/{taskId}` |
| §5.8 timestamp units; undocumented `401`/`403` | **Fixed for the schemas and routes in scope** — not an exhaustive sweep of all 165 operations | timestamp descriptions on the touched schemas; pairing/devices/revoke/delete |
| §5.9 status/permission/workspace have no enums | **Fixed for response fields**; request fields stay open by design (below) | `Task.status`, `.permission_mode`, `.workspace_mode`; `CreateTaskRequest.*` |

W2 §9's W1 list maps to the same rows: item 1 → §5.1/§5.8, item 2 → §5.2,
item 3 → §5.3, item 4 → §5.4, item 5 → §5.5, item 6 → §5.9.

## What the contract now says

Line citations are to the implementation the schema describes. The spec itself
is cited by schema or operation name because its line numbers move with every
edit.

### 1. `TaskEvent.payload` (W2 §5.2)

`TaskEvent.payload` references a new `TaskEventPayload` object with
`additionalProperties: true`, so unknown kinds and adapter extras survive while
the fields a client decodes are typed. Two nested schemas keep the shape pinned:
`TaskEventContentBlock` (`type` required, `text`, open) and `RoundChangedFile`
(no required fields — a stored event is untrusted, and a malformed entry should
be dropped, not fail the round).

- **Message delta rule.** `partial: true` marks a streaming chunk to
  concatenate in `seq` order; a later event with `partial: false` replaces the
  accumulated text. Chunk writers: `internal/adapter/droid/parse.go:157,363`,
  `internal/adapter/claudecode/parse.go:173`,
  `internal/adapter/acp/update.go:220`. Final writers:
  `internal/adapter/claudecode/parse.go:72,83,124,139`,
  `internal/adapter/codex/parse.go:221`, `internal/adapter/grok/adapter.go:213`,
  `internal/adapter/kinagent/loop.go:487`, and the engine's own user message at
  `internal/task/approvals.go:1660-1667`. `content[]` is `type`/`text` blocks
  (`internal/task/approvals.go:1125-1130`); `text` is the flattened alternative,
  and `result`/`message` are accepted aliases
  (`internal/adapter/events.go:100-142`).
- **Attribution.** `agent`, `speaker`, `source`, `phase`, `model`, `role`,
  `visibility`, `execution_id`, `run_execution_id`, `execution_agent`,
  `execution_step`, `execution_model`, `provider_id`, `workspace_id`,
  `workspace_access`, `workspace_generation`
  (`internal/task/event_meta.go:45-115`; approval/question writers add the same
  keys at `internal/task/approvals.go:138-158` and
  `internal/task/user_questions.go:162-184`). `source` and `phase` are open
  sets: the engine's values are at `internal/task/event_meta.go:45-115` and
  `internal/task/approvals.go:1100-1140`, while adapters pass their own
  (`internal/adapter/kinagent/loop.go:568`, ACP phase labels).
- **Tool calls/results.** `tool_use_id`, `name`, `tool_name`, `input` (opaque),
  `summary`, `output`, `status` (open and producer-specific: `running`,
  `pending`, `in_progress`, `done`, `completed`, or `error`; `ok`/`is_error` is
  the authoritative outcome), `ok`, `parent_tool_use_id`, `sidechain`, `item` —
  written by the adapters (`internal/adapter/acp/update.go:234,309-312,353` for
  `sidechain`, `parent_tool_use_id`, and the ACP status values;
  `internal/adapter/droid/parse.go:384-399` for `completed`;
  `internal/adapter/kinagent/loop.go:563,591` for `running`/`done`/`error`).
  `id` stays in the schema only as a legacy reader alias: no current adapter
  writes a top-level `id` (claude-code nests it under `content`, codex under
  `item`), but the console still reads it on older rows
  (`ui/src/components/chat/transcriptProjection.ts:770,804`).
- **Approvals and questions.** `approval_id`, `kind`, `payload`, `decision`,
  `decided_via`, `decided_at` (`internal/task/approvals.go:138-158,197-213`);
  `question_id`, `response`, `answered_via`
  (`internal/task/user_questions.go:162-184,238-244`). `Approval.decision` is a
  closed set because the store writes exactly four values
  (`internal/store/approvals.go:15-18`) and `Decide` accepts approved, denied,
  or expired (`internal/task/approvals.go:178-183`). `kind` stays open because a
  relayed approval passes the deciding machine's kind through.
- **Result / error / usage.** `is_error`, `session_ref` (with `session_id` /
  `sessionId` aliases), `usage` and its alias list, `message`, `error`,
  `result`, `raw`, `tokens_in`, `tokens_out`, `cost_usd`, `total_cost_usd`
  (`internal/adapter/events.go:11-23,59-64,81-85,269-307`;
  `internal/adapter/claudecode/parse.go:185-235`). `raw`, `error`, `result`,
  and `input` are deliberately untyped (`{}`) because they are adapter
  passthroughs; the generated type is `unknown`.
- **Lifecycle.** `task_started` (`internal/adapter/events.go:11-14`);
  `checkpoint_skipped` with `event_seq` and a producer-specific `reason` (the
  checkpoint values are `too_large`, `unavailable`, `git_error`
  — `internal/task/engine.go:3837-3844,3901-3911`; route events reuse the key
  for free text such as `manual dispatch` — `internal/task/engine.go:824-833`,
  `internal/task/engine.go:1151`, `internal/routing/policy.go:259`, so it is
  not an enum); `round_changed` with
  `from_seq`, `to_seq`, `base_tree`, `head_tree`, `total`, and `files` capped at
  200 (`internal/task/engine.go:3851,3885-3892`); `workspace_restored`
  (`internal/task/approvals.go:1428-1437`); the `workspace_*` generation events
  (`internal/store/workspaces.go`, `internal/task/event_meta.go:105-115`);
  fork lineage on the first user `message` or, when the fork starts without a
  turn, on the `meta` annotation (`internal/task/approvals.go:1663-1690`);
  `limit_hit`
  (`internal/task/limit_continue.go:90-107,260-312`); routing
  (`internal/routing/policy.go:242-273`).

The event `type` list is published as known values, explicitly open: adapters
and the engine both append (`internal/store/transcript_index.go:73-84` is the
conservative in-repo list).

### 2. SSE (W2 §5.3)

`GET /api/events` now states: `retry: 3000` once at open
(`internal/api/realtime.go:78-80`); a `: ping` comment every 15 seconds
(`internal/api/realtime.go:35,96-100`); no readiness frame, no replay, and no
`Last-Event-ID` handling; open the stream before draining `/api/sessions`, and
advance the cursor only from a feed page (ADR 0024); gaps are found from `seq`
continuity plus `event_epoch`, never from the stream; credentials are rechecked
every 10 seconds and a revoked device or ended session closes the stream, while
the master token is never rechecked (`internal/api/realtime.go:42`,
`internal/api/api.go` master path); a slow subscriber is disconnected rather
than fed a hole (`internal/api/realtime.go:105-112`); `503` is returned before
streaming when the engine is unavailable or the bus refuses a subscriber, and
`500` only for a writer that cannot flush
(`internal/api/realtime.go:52-63`). The `503` response is declared.

### 3. Workspace and permission modes (W2 §5.4, §5.5, §5.9)

- **Requested vs resolved.** `CreateTaskRequest.workspace_mode` documents
  `auto` (default), `shared`, and `worktree` and what each does; `Task` reports
  `shared` or `worktree` only. Resolution is at
  `internal/task/engine.go:1592-1676` and
  `internal/workspace/prepare.go:48-127`. `auto` is lazy only for an agent that
  supports promotion (`internal/task/engine.go:1617-1622`); otherwise the
  checkout is prepared before the task starts and a dirty source falls back to
  `shared` (`internal/workspace/prepare.go:99-107`). Explicit `worktree` allows
  a dirty source (`internal/workspace/prepare.go:108-127`).
- **Refusals.** Remote tasks always run in that machine's checkout and an
  explicit `worktree` is refused with `400`
  (`internal/task/engine.go:1604-1613`); an unknown local mode is `400`
  (`internal/workspace/prepare.go:48-60`), while an unknown mode on a remote
  task falls through to the shared path. The handler maps create failures to
  `400` (`internal/api/api.go:992-1019`).
- **What the task fields record.** `Task.workspace_policy` names the path that
  was chosen, not a guarantee. The eager path (`worktree`) can still resolve to
  shared metadata — dirty source, not a repository, bare, no commit, or no
  usable git — and then `workspace_mode` reads `shared` with no generated
  checkout (`internal/task/engine.go:1668-1676`,
  `internal/workspace/prepare.go:99-107`). Remote tasks are always shared
  (`internal/task/engine.go:1623-1627`), and a lazy `auto` task with nothing to
  isolate from records `shared` (`internal/task/engine.go:1633-1646`). For a
  shared task `workspace_root` is `execution_cwd`: the probe-resolved absolute
  `cwd` when prepared on this machine, and the address as given for a remote or
  lazy no-HEAD task (`internal/workspace/prepare.go:71-87`,
  `internal/workspace/types.go:71-77`). For a shared task in a repository on
  this machine, `workspace_source_root` plus `workspace_scope` reconstructs it;
  other shared tasks have no source root and scope `.`.
  For a lazy task before promotion the workspace fields describe the source
  checkout (root = source root, cwd = source cwd, branch = source branch);
  promotion rewrites them to the generation
  (`internal/task/engine.go:2379-2388`).
- **Missing `cwd` in the generated checkout.** The checkout contains committed
  paths only, so a gitignored or untracked `cwd` fails at turn start with
  `task execution directory is unavailable: <path>`
  (`internal/adapter/workspace_access.go:90-95`). The same text is what W2 hit.
- **Permission values.** `default`, `accept_edits`, `yolo`; aliases normalize
  (`acceptEdits`, `accept-edits`; `bypass`, `bypassPermissions`,
  `dangerously-skip-permissions`) and unknown values become `default`
  (`internal/adapter/permission.go:7-36`). A generic CLI cannot run under
  `default` (`internal/api/api.go:1094-1114`). `Task.permission_mode` is closed
  and non-null because every write normalizes and the store defaults missing
  rows to `default` (`internal/task/engine.go:1541-1562`,
  `internal/task/approvals.go:999-1001`,
  `internal/store/store.go:386-400`).
- **Bypass derivation.** Kin stamps no per-turn "approvals bypassed" flag, so
  the contract states what a client can infer: no approval will arrive under
  `yolo`; under `accept_edits` when the agent's advertised ladder omits that
  rung; under `default` when the ladder is only `default`. The ladder is
  computed from the adapter's own answer
  (`internal/adapter/permission.go:42-63`,
  `internal/adapter/genericcli/adapter.go:145-156`,
  `internal/adapter/acp/adapter.go:88-125`) and filtered for dispatched turns at
  `internal/server/node.go:196-245`. `DeviceAgent.permission_modes` is an
  advertisement, not a hard refusal list: the node refuses only a mode that
  bypasses approvals when it was not started with `--allow-yolo`
  (`internal/node/executor.go:140-156`).
- **`decided_via`.** The full vocabulary is published: `ios:<device-id>` (which
  literally reads `ios:ios-…`), `web`, `<X-Client-Type>` (≤64 chars),
  `mcp:<client-id>`, `a2a`, `interrupt`, `timeout`, `device_disconnected`
  (`internal/api/api.go:2332-2347`, `internal/task/approvals.go:178-213`,
  `internal/store/approvals.go:15-22`). It stays open because a relayed
  approval carries the deciding machine's attribution.

### 4. Task status and timestamps (W2 §5.8, §5.9)

`Task.status` publishes all eight values (`internal/task/engine.go:26-35`) and
names `succeeded`, `failed`, `canceled` as terminal
(`internal/task/engine.go:3294-3300`). `retrying` is described as retry
restoration in progress, which is why the row cannot be canceled or deleted
then (`internal/store/retry.go:11`, `internal/task/engine.go:1955-1957,2189-2191`).

Every integer timestamp schema touched here says epoch milliseconds. The one
deliberate exception is `limit_hit.reset_at`, which is epoch **seconds**
(`internal/adapter/ratelimit.go:22-23,138-139`); the field description says so.

### 5. Pairing, device ids, and operator routes (W2 §5.1, §5.6, §5.7, §5.8)

- Pairing secrets live five minutes and `expires_at` is epoch ms
  (`internal/api/devices.go:19,89-93`).
- The exchange mints `ios-` + 16 hex characters regardless of platform
  (`internal/api/devices.go:168-172`; the secret is 32 random bytes rendered as
  hex then truncated to 16 characters — `internal/remote/auth.go:19,326-331`).
  The prefix is documented as behavior and as opaque, not renamed.
- `Device` was wrong in W1: it declared `last_used_at`, which the response never
  emits. It is now the response shape at `internal/api/devices.go:43-76,284-325`:
  required `id`, `reachability`, `created_at`, `agents`; optional `label`,
  `platform`, `arch`, `role`, `kin_version`, `last_seen_at`, `revoked_at`,
  `workspace_roots`. `last_seen_at` is the machine's report or, failing that,
  the credential's last use (`internal/store/device_registry.go:234-244`);
  `agents` is empty, never null (`internal/api/devices.go:296`).
- `DELETE /api/tasks/{taskId}` is operator-only, not "master-only": the master
  token and an owner account both pass, a paired device does not
  (`internal/api/api.go:587-605,634-643,417`). A `retrying` task is refused
  (`internal/task/engine.go:2189-2191`).
- `401` (with `WWW-Authenticate: Bearer realm="kin"`) and `403`
  (`{"error":"operator access required"}`) are stated for the operator routes
  W2 exercised and for task delete (`internal/api/api.go:587-643`, route
  registrations at `internal/api/api.go:312,317-318,417`).

## Decisions recorded (not runtime changes)

1. **DELETE is "operator", not "master".** W2 sent a device token, got `403`,
   and reasonably called the route master-only. An owner account is an operator
   too (`internal/api/api.go:599-602`). The contract now says both.
2. **Response enums are closed; request enums stay open.** A client sending
   `workspace_mode: "auto "` or an alias needs the server's normalization, not a
   schema rejection; an unknown local mode is a `400` and an unknown remote mode
   silently runs shared (`internal/task/engine.go:1592-1613`,
   `internal/workspace/prepare.go:48-60`). The values are documented in prose
   with no `enum`, so the generated request type stays `string`. Response rows
   are normalized on write and defaulted on read, so they are closed.
3. **`QueuedPrompt.permission_mode` is the raw requested value.** The queue
   stores `req.PermissionMode` before normalization
   (`internal/task/approvals.go:495-513`); it is normalized when the prompt
   becomes a turn (`internal/task/approvals.go:999-1001`). Documented as such.
4. **SSE `503`, not `500`, for an unavailable stream.** `500` exists only for a
   writer that cannot flush (`internal/api/realtime.go:52-63`).
5. **`phase` is open.** The engine writes `plan`/`progress`/`summary`, but
   adapters pass other labels through; a closed enum would break real events.
6. **Keys shared by several producers stay open.** `reason` is the checkpoint
   vocabulary on `checkpoint_skipped` but a router sentence on route events
   (`internal/task/engine.go:824-833,1151`); `status` varies by adapter
   (`internal/adapter/acp/update.go:309-312`,
   `internal/adapter/droid/parse.go:384-399`); `id` is a legacy reader alias
   with no current writer; and `answered_via` is not `decided_via` (questions
   record `mcp`, not `mcp:<client-id>`, and have no `device_disconnected`
   path — `internal/mcp/server.go:1080-1084`). Each is documented with its
   producer-specific values and left open.
7. **No per-turn bypass stamp (product decision).** A client can derive the
   common cases from `Task.permission_mode` plus the agent ladder, and that
   derivation is now published. A turn that needed no approval is still
   indistinguishable from one whose gate was bypassed; if that distinction
   matters, the options are a task/turn field (for example
   `approvals_bypassed`), an event, or accepting the derivation. This change set
   does not invent one.
8. **The `ios-` prefix is documented, not changed (product decision).** It
   misleads in a mixed-platform device list. Renaming it is a wire-visible
   change with stored ids and existing pairings; out of scope for a
   contract-only change.

## Regression test

`ui/src/api/contractPayloads.test.ts` (new, 6 tests) pins the generated types:

- exhaustive `Record<Union, true>` coverage for `Task.status`,
  `Task.permission_mode`, `Task.workspace_mode`,
  `CreateTaskRequest.workspace_mode`, and `Approval.decision`;
- `IsWidened<T>` guards that fail if a union collapses to `string`;
- a presence check over every declared payload field: 76 keys, with the four
  opaque passthroughs (`input`, `error`, `result`, `raw`) excluded because
  indexed access cannot tell them apart from a dropped field.

The presence check had to work around `additionalProperties: true`: it gives
the generated payload an index signature, so `keyof TaskEventPayload` is
`string | number` and a `Record<union, keyof Payload>` test is vacuous. The test
uses indexed access (`TaskEventPayload[K]`) and collects keys that resolve to
`unknown`; a dropped field then fails to compile.

Red verification: 10 mutants, 10/10 detected (`scripts/mutants.py`), restoring
each file byte for byte: `Task.status` widened, `Approval.decision` widened,
`TaskEvent.payload` reverted to `unknown`, `content` widened to `unknown`,
`partial` widened to `string`, route `reason` narrowed to the checkpoint enum,
`workspace_access` widened, `round_changed.files` dropped, payload `message`
dropped, and payload `kind` dropped. The test command is
`cd ui && ! npx tsc --noEmit 2>&1 | grep -q 'contractPayloads.test.ts'`; the
dropped-`files` mutant originally survived and is why the presence check uses
indexed access.

## Test-only fixture edits

Narrowing the generated types makes six existing tests fail to compile for
reasons unrelated to their assertions. None changes what a test checks:

| File | Edit | Why |
| --- | --- | --- |
| `ui/src/components/chat/ChatStream.find.dom.test.tsx` | helper param `payload: unknown` → `TaskEvent["payload"]` | the fixture is a `TaskEvent`; `unknown` no longer assigns |
| `ChatStream.memo.dom.test.tsx` | same | same |
| `ChatStream.queue.dom.test.tsx` | same | same |
| `chat/transcriptProjection.test.ts` | same | same |
| `ui/src/hooks/useApprovalDecision.test.tsx` | helper param `string` → `Approval["decision"]` | the decision is now a closed union |
| `ui/src/lib/routineHistory.test.ts` | fake status `"done"` → `"succeeded"` (2×) | `"done"` was never a task status; `"succeeded"` is the terminal value the fixture means |

## No runtime change

`git diff --cached --name-only` lists only the spec, its generated types, the
new test, and the six test files above. No file under `cmd/`, `internal/`,
`desktop/src/`, or non-test `ui/src/` changed. Because the generated file is
types only and nothing imports the new types at runtime, behavior is unchanged;
`go test ./internal/api/...` and the full `scripts/check.sh` prove the existing
suite still passes.

## Commands and results

| Command | Result |
| --- | --- |
| `cd ui && npm run generate:api` | exit 0; openapi-typescript 7.9.1 |
| `cd ui && npx tsc --noEmit` | exit 0 |
| `cd ui && npx vitest run src/api/contractPayloads.test.ts` | 6/6 passed |
| `./scripts/mutants.py /tmp/w1b-mutants.json` | 10/10 mutants red; 0 problems |
| `./scripts/check-openapi.sh` | exit 0 |
| `./scripts/check-api-coverage.sh` | exit 0; 181 routes, 165 documented operations, 121 client paths |
| `go test -timeout 300s -count=1 ./internal/api/...` | `ok …/internal/api 41.129s` |
| `./scripts/check.sh` | 13/13 jobs pass: gofmt, vet, gotest, probe, desktop-test, desktop-tsc, ui-test, ui-tsc, api-contract, api-coverage, shell-syntax, python-syntax, stories |
| `ruby -ryaml -e 'YAML.load_file("api/openapi.yaml")'` | parses cleanly |

## Review

Two high-model sub-agent passes over the frozen diff, following the review
protocol in `docs/product/LESSONS.md` (freeze the tree, mutants before review,
one full report, fix once, verify the delta):

- **Pass 1 — changes requested.** One blocker and six majors, all fixed: the
  shared payload key `reason` was closed to the checkpoint vocabulary even
  though route events write free text; `workspace_policy` / `workspace_mode`
  over-claimed the eager fallback and remote behavior; `workspace_root` and
  `workspace_scope` mis-described the shared case; `execution_cwd` and
  `workspace_branch` were wrong before lazy promotion; tool `status` omitted
  real adapter values; `answered_via` was conflated with `decided_via`; and
  `DeviceAgent.permission_modes` overstated the refusal rule. Six nits were
  fixed in the same pass, including expanding the payload presence test from 21
  to 76 keys.
- **Pass 2 — approved.** No surviving blocker or major; all 13 targeted fixes
  verified against source. Four documentation nits remained, all fixed:
  precise adapter lists for `id` / `session_ref`, probe-resolved shared paths
  and the post-promotion scope failure, the intrinsic-vs-filtered
  `permission_modes` distinction, and fork lineage carried on either the first
  user `message` or the `meta` annotation. The second pass re-ran `tsc`, the
  focused vitest, `check-openapi.sh`, and `check-api-coverage.sh`; the
  remaining suite and the 10 mutants were re-run after the nit edits.

Verdict: **approve; no open blocker or major.**

## Residual risk and follow-ups

- **Not a whole-spec timestamp/auth sweep.** Units are stated on the schemas
  this change set touches, and `401`/`403` on the routes W2 used plus task
  delete. The class-level rule is in `info.description`; the other ~50
  operator-only operations still list only their success (and some `400`)
  responses. A full sweep is mechanical but was outside W1b's blast radius.
- **Derived bypass visibility.** The published derivation depends on the
  agent's advertised ladder, which can change when a machine restarts with a
  different adapter configuration. A task row keeps its `permission_mode`, so a
  client re-reading an old task after a ladder change could infer wrongly.
  This is the reason the per-turn field remains a product decision.
- **Route/limit payloads are typed loosely.** `route_decision` carries a large
  routing object; only the fields a console decodes (`team`, `phase`,
  `provider`, `model`, `fallback_from`) are described. The rest remains
  available through the open index signature.
- **Generated file size.** `ui/src/api/generated/openapi.ts` grows by ~640
  lines. It is generated output and must never be hand-edited; `check-openapi.sh`
  enforces that it matches the spec.
