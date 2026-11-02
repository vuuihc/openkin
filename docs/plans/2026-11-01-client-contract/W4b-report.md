# W4b — Independent client probe, cold-start re-run

Status: complete
Owner: W4b session
Date: 2026-11-02
Branch: `w4b-independent-client-probe`
Base: `main` after W1b and the W4 re-run (`ad996dda`)

## What this is

A fresh cold-start re-run of the independent client probe, against the final
contract. The goal is to measure what an independent client still cannot learn
from public documentation, not to add features or fix the server. The probe is
a separate Go module under `probe/kin-probe-w4b/` that talks to the documented
HTTP and SSE surface with the standard library only.

## Isolation

Protocol answers came only from:

- `api/openapi.yaml`
- `docs/adr/0022-hub-node-multi-device-sessions.md`
- `docs/adr/0024-session-sync-cursor.md`
- `README.md`
- the live wire at `http://127.0.0.1:7777`

The probe and report were written without reading `internal/`, `ui/src/`,
`desktop/src/`, `mobile/`, any existing `probe/` directory, or any file under
`docs/plans/2026-11-01-client-contract/` other than this report.

### Temptation log

1. **The master plan's status table.** The assignment required reading
   `docs/plans/2026-11-01-client-contract-program.md` for the brief. That file
   names prior gaps and their dispositions. Resolved by using it only to
   identify W4b's scope and never as protocol knowledge; every behavior below
   is derived from the allowed sources or observed on the wire.
2. **Report filenames.** Listing the report directory to place this file
   revealed the names of W1/W2/W3/W4 reports. Resolved by not reading them.
3. **Default agent failure.** When the daemon's default agent (`kin`) returned
   an `error` event on every turn, the shortest path to an explanation was
   `internal/`. Resolved by not reading it: the operator queried the documented
   `GET /api/agents` outside the probe and selected an available agent
   explicitly for the run.
4. **Approval suppression.** When the Bash tool ran without an approval row,
   the shortest path to an explanation was the daemon's permission bridge in
   `internal/`. Resolved by not reading it: the probe recorded the durable event
   sequence and the approval-list response, which are the client-visible facts
   the brief asks for.

Source-read violations: **0**.

## Deliverable

`probe/kin-probe-w4b/` — a nested Go module (`kinprobe`), standard library only:

| File | Non-test LOC | Purpose |
| --- | ---: | --- |
| `main.go` | 85 | flags, token file, outcome output |
| `sse.go` | 127 | SSE framing (`event`, `data`, comments, `retry`) |
| `client.go` | 370 | HTTP client for the documented routes |
| `state.go` | 434 | cursor/feed, event identity, message accumulation, live pump |
| `run.go` | 1,015 | six-step acceptance driver, reconciliation, cleanup |
| **Total** | **2,031** | non-test Go LOC |

Tests: `fake_test.go` (1,474 LOC) runs the whole six-step driver against an
in-process fake daemon that implements the documented routes and plays a
scripted agent (streaming chunks, one approval path, one suppressed-approval
path). Negative tests cover an unreadable approval list, a durable approval
request with no row, an unreadable durable baseline, a still-running turn, a
canceled turn, a failed turn, a turn that never attempts the tool, tool
evidence that exists only in an earlier turn, a missing `task_update`, an
unexpected stream EOF, a clean stream EOF, feed/resource drift, durable type
drift, a failed delete, a failed revoke, and a device recovered by label after
a lost exchange response.

`mutants.json` has 24 mutants, all red under `scripts/mutants.py`.

## Acceptance method

1. **Pair.** `POST /api/pairing/sessions` with the operator credential, then
   `POST /api/pairing/exchange` with the one-time secret and a `probe-w4b-*`
   label. A transport failure or `5xx` on exchange retries once with
   `X-Kin-Pairing-Recovery: 1`; cleanup can also find the device by label, so a
   lost exchange response cannot leak a credential. The device token is used
   for every holder route. The operator credential is retained only for pairing
   (session creation, exchange, and the device list that confirms the new
   device), session deletion and its `404` confirmation, the tombstone feed
   drain, and device revocation.
2. **Snapshot.** `GET /api/sessions/cursor` is read first, then
   `GET /api/sessions` is paged from the beginning until `has_more` is false.
3. **Live events.** `GET /api/events` is opened first, then a dedicated
   `probe-w4b-*` session is created with `POST /api/tasks`
   (`workspace_mode: shared`, `permission_mode: default`). The stream must
   carry both a `task_update` frame (`HasTask`) and an `event` frame before the
   step passes; a terminal turn with either missing fails, as does a buffered
   frame overflow or an unexpected stream end.
4. **Streaming.** A follow-up prompt is sent with
   `POST /api/tasks/{id}/prompt`. The client requires at least one `message`
   event with `partial: true`, then waits for the turn to finish and reports
   the turn's final partial-chunk count.
5. **Approval.** A prompt invites one benign tool call (`echo probe-w4b-ok`).
   The client watches both the SSE `approval_update` frames and
   `GET /api/approvals?status=pending`, and approves a pending row for its own
   session with `POST /api/approvals/{id}/decision`. A skip is accepted only
   when both approval-list reads succeed, the pre-prompt durable baseline and
   the final log are readable, the log's shape is unchanged across the prompt,
   the turn reached `succeeded`, no `approval_requested` event was produced by
   this turn, and this turn's events show the invited tool was attempted
   (`tool_use`, `tool_result`, or an embedded `tool_result` block). An
   unreadable list or log, a changed baseline, a durable request with no row, a
   still-running, failed, or canceled turn, or a successful turn with no tool
   attempt is a step failure.
6. **Catch-up.** The feed is drained to the current cursor, the SSE stream is
   closed, a prompt is sent while disconnected, the turn is awaited through
   `GET /api/tasks/{id}`, and `GET /api/sessions?updated_since=<cursor>` is
   drained. The feed row must match `GET /api/tasks/{id}` on status,
   `event_epoch`, and `hub_seq`; the durable log must be one epoch with
   contiguous `seq`; every streamed event identity must exist in the durable
   log with the same type. The stream is then reopened and a further prompt
   proves new live frames arrive.

Cleanup deletes the probe session with the operator credential, confirms `404`
and the deletion tombstone in the feed, revokes the probe device, confirms the
device token now answers `401`, and re-reads the device list.

## Results (final recorded run)

| Step | Result | Evidence |
| --- | --- | --- |
| 1 pair | pass | secret expiry 5m0s; exchange accepted; device token accepted; device visible to the operator list |
| 2 snapshot | pass | cursor 1781 read before the snapshot; 1 page; 163 sessions; snapshot end == cursor |
| 3 live events | pass | `task_update` and `event` frames received for the probe session (3 task frames: 2 updates + 1 event) |
| 4 streaming | pass | 7 partial `message` chunks for the follow-up prompt; 8 total tracked |
| 5 approval | **skip** | no approval row; list readable; exact reason below |
| 6 catch-up | pass | disconnected, caught up 1 page, reconnected, 1 new live frame, 51 durable events matched |
| cleanup | pass | session deleted (404) and tombstoned; device revoked and its token now 401 |

### Step 5 skip reason

The agent executed the invited tool call without asking for approval. The
durable events after the tool prompt were:

```text
message, task_started, raw_output, tool_use, message, message, message, message, usage, result
```

The `tool_use` event named `Bash` (recorded as `tool names: Bash`), and the
turn reached `succeeded` after 10 s. This turn produced no `approval_requested`
event, exactly one `tool_use`, zero standalone `tool_result` events, and one
embedded `tool_result` block. A diagnostic `-keep` run under the same daemon
and agent showed the command was `echo probe-w4b-ok` and the embedded block's
output was `probe-w4b-ok`; the final run's probe records the same event shape
and the tool name.

Both approval-list reads succeeded: 28 rows total, **0 for this session**;
0 pending overall and **0 for this session**. No SSE `approval_update` frame
arrived.

The documented contract says whether a `default` turn asks is the agent's
decision, and that a turn which needed no approval is indistinguishable on the
wire from one whose gate was bypassed; a client can predict suppression only
from the advertised permission ladder, which this probe did not read. The
operator runs the daemon with `--allow-yolo`, which the documentation says
controls whether a bypassing mode is offered. The probe therefore records the
client-visible facts above and treats the outcome as the brief's pre-declared
suppression case; it does not claim to attribute the cause. It is not counted
as a contract gap.

## Measurements

- **Elapsed, first prompt → final recorded step:** 47,365 ms (47.4 s).
  Definition: from the `POST /api/tasks` that carries the first prompt to the
  end of step 6's final durable-log and subset checks. Total process time:
  47,447 ms.
- **Non-test Go LOC:** 2,031.
- **Peak client RSS:** 14,811,136 bytes (≈14.1 MiB), from `getrusage`.
- **Snapshot:** 163 sessions, 1 feed page.
- **Live stream:** 3 task frames in step 3 (2 `task_update`, 1 `event`), 1 task
  frame after reconnect, 0 unrecognized/mismatched frames.
- **Catch-up:** 51 durable events, one epoch, contiguous `seq`, every streamed
  identity present.

The machine-readable outcome of the recorded run was written to a temporary
path outside the repository, per the repository rule to keep run logs and
transient artifacts out of commits. The numbers above are its `metrics`.

## Undocumented behaviors

**None.** The six-step flow ran without a workaround. Behaviors checked against
the documented sources:

1. Pairing exchange returns `device_id`/`token`; `desktop_id`/`desktop_name`
   are optional in the schema and present here.
2. The feed cursor is a plain integer, read before the snapshot; the snapshot
   drain ends at or after it.
3. SSE authenticates with the same bearer header as REST; frames are
   `event: <kind>` with one `WSMessage` object; `retry:` and `: ping` are
   transport noise.
4. `Task.event_epoch` and `seq` are the event identity; `hub_seq` is exposed on
   every task row.
5. `GET /api/approvals` accepts the documented `status` filter and returns
   `200` with an empty array when nothing matches.
6. Deletion is operator-only, answers `204`, makes the task answer `404`, and
   appears as a tombstone in the feed.
7. Revocation answers `204`, leaves the device listed with `revoked_at` set,
   and makes its token answer `401`.
8. A tool result can arrive inside a `message` content block; the contract
   declares message block types an open set. The `tool_use` name is exposed
   under the documented `tool_name`/`name`/`content.name` aliases; this run
   carried it under `name`.

## Server changes required

**0.** The probe only used documented routes; no daemon code, schema, or config
was changed.

## Verification

Final state of the frozen probe and report:

- `gofmt -l` clean.
- `go vet ./...` clean.
- `go test -race -count=1 ./...` pass (57.9 s, includes every fake-daemon and
  negative-path test).
- `scripts/mutants.py probe/kin-probe-w4b/mutants.json` **24/24 red**, each
  restore byte-for-byte. The lock mutant was repeated three times and the
  fixed concurrency test three times without a flake.
- `./scripts/check.sh` reports gofmt, vet, Go tests, desktop tests, api
  contract, api coverage, shell syntax, Python syntax, and stories as ok. Its
  `probe` stage covers the two older probe modules, not this new one; the w4b
  module's own gofmt/vet/race/mutants above are the probe evidence for this
  change. `ui-test`/`ui-tsc` skip because no console file changed, and
  `desktop-tsc` could not run because this fresh worktree has no
  `desktop/node_modules`; neither is related to this probe-only change.
- Live acceptance run: as tabled above, against the running daemon on
  `http://127.0.0.1:7777` with `-agent claude-code`. The daemon was never
  restarted or stopped.

Three independent high-model review passes ran over the probe and report.

- **First pass:** 0 blockers, 4 majors, 6 nits. Fixed: step 5 fails rather than
  skips on unreadable or contradictory observation; step 3 requires a
  `task_update`; `SetTaskID` replays buffered frames under the stream mutex;
  negative tests and mutants cover `matchTask`, `checkContiguous`,
  `checkSubset`, the replay, and the approval classification. Nits fixed: the
  epoch-bump test reuses a rewrite-point seq above 1; the contiguity check is
  documented as this run's shape; frame counts are per task and pending drops
  are surfaced; pairing has a recovery path and a label-based cleanup fallback;
  bodyless routes send no body; the report states every operator-credential
  use.
- **Second pass:** 0 blockers, 1 major, 8 nits. Fixed: a skip requires a
  succeeded turn with tool evidence, so canceled, failed, running, and no-tool
  turns fail; unexpected stream end is recorded as a failure; added a
  concurrent `SetTaskID`/`ApplyFrame` regression test; step-5 failure details
  keep the wait error; `decided_via` is redacted to its mechanism; approval
  rows are counted for the probe session; step 4's detail and metric share the
  final chunk count.
- **Third pass:** 0 blockers, 1 major, 4 nits. Fixed: tool evidence is counted
  only from events after the pre-prompt baseline, so an earlier turn's tool use
  cannot mask a step-5 turn that never attempted the tool, and an unreadable or
  reshaped baseline fails as unattributable; the tool name is read through the
  documented aliases; clean-EOF and failed-turn branches have dedicated tests
  and mutants; the lock mutant now exercises a balanced unlock-before-replay
  under `-race`; the report's `check.sh` coverage claim was narrowed.

## Remaining gaps and residual risk

- Step 5's **decision** endpoint was exercised only against the fake daemon;
  the live daemon never asked, so `POST /api/approvals/{id}/decision` has no
  live evidence in this run.
- The probe does not read the agent's advertised `permission_modes`, so it
  cannot predict suppression from the documented ladder; it observes the
  durable and approval-list facts instead.
- Tool evidence is attributed by the pre-prompt durable baseline. If the log is
  rewritten across the prompt (a retry or other tail rewrite), the step fails
  as unattributable rather than guessing; no retry occurred in this run.
- The daemon's **default agent** (`kin`) reported `available: true` but every
  turn produced `error` in this environment. The recorded run therefore names
  `claude-code` explicitly through the documented `agent` field. A client that
  trusts the default would see agent errors, not a contract error; this is an
  environment/agent observation, not a protocol gap.
- SSE keep-alive comments and `retry:` were parsed and unit-tested. The client
  ignores `retry:` and does not count keep-alive comments, so their live
  presence is not recorded; no turn left the stream idle long enough to
  observe a ping.
- Feed pagination beyond one page was exercised against the fake daemon only.
  The live snapshot and every catch-up drain fit in one page.
- The `event_epoch` bump path is unit-tested (including a rewrite-point seq
  above 1) but did not occur in the live run; the live task had one epoch.
- P0 endpoints outside the six-step script (uploads, workspaces, questions,
  browser actions) were not probed.

## Cleanup confirmation

The probe deleted its session and re-read it as `404`, and its deletion
tombstone was observed in the session feed. It revoked its device, the token
answered `401`, and the device list showed it with `revoked_at` set. An
independent post-run query of `GET /api/devices` and `GET /api/sessions`
reported **0 active `probe-w4b-*` devices**, 11 revoked devices from earlier
runs, and **0 `probe-w4b-*` sessions** in the feed.

## Commits

- `9b1e904b` — `feat(probe): add the W4b independent client acceptance probe`
  (probe module, fake daemon, tests, mutants).
- `5562aef2` — `docs(plans): record the final W4b independent probe run`
  (the first version of this report).
- `f4eb8774` — `fix(probe): require tool evidence for a suppressed approval`
  (second-review fixes).
- `ba4f455c` — `docs(plans): finalize the W4b independent probe report`
  (the report after the second review).
- `891a7beb` — `fix(probe): scope approval tool evidence to the invited turn`
  (third-review fixes, 24 mutants, final recorded run).
- The final report update is committed immediately after; the handoff names
  the branch-head SHA.
