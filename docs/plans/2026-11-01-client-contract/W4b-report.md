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
   `internal/`. Resolved by not reading it: the probe queried the documented
   `GET /api/agents` instead and the operator selected an available agent
   explicitly.
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
| `client.go` | 368 | HTTP client for the documented routes |
| `state.go` | 432 | cursor/feed, event identity, message accumulation, live pump |
| `run.go` | 958 | six-step acceptance driver, reconciliation, cleanup |
| **Total** | **1,970** | non-test Go LOC |

Tests: `fake_test.go` (1,282 LOC) runs the whole six-step driver against an
in-process fake daemon that implements the documented routes and plays a
scripted agent (streaming chunks, one approval path, one suppressed-approval
path). Negative tests cover an unreadable approval list, a durable approval
request with no row, a missing `task_update`, a broken stream, feed/resource
drift, durable type drift, a failed delete, a failed revoke, and a device
recovered by label after a lost exchange response.

`mutants.json` has 15 mutants, all red under `scripts/mutants.py`.

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
   frame overflow.
4. **Streaming.** A follow-up prompt is sent with
   `POST /api/tasks/{id}/prompt`. The client requires at least one `message`
   event with `partial: true`, then waits for the turn to finish.
5. **Approval.** A prompt invites one benign tool call (`echo probe-w4b-ok`).
   The client watches both the SSE `approval_update` frames and
   `GET /api/approvals?status=pending`, and approves a pending row for its own
   session with `POST /api/approvals/{id}/decision`. A skip is accepted only
   when both approval-list reads succeed, the durable log is readable, the turn
   is terminal, no `approval_requested` event exists, and the turn did not
   fail. An unreadable list, an unreadable log, a durable request with no row,
   a still-running turn, or a failed turn is a step failure.
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
| 2 snapshot | pass | cursor 1483 read before the snapshot; 1 page; 163 sessions; snapshot end == cursor |
| 3 live events | pass | `task_update` and `event` frames received for the probe session (3 task frames: 2 updates + 1 event) |
| 4 streaming | pass | 4 partial `message` chunks for the follow-up prompt; 7 total tracked |
| 5 approval | **skip** | no approval row; list readable; exact reason below |
| 6 catch-up | pass | disconnected, caught up 1 page, reconnected, 2 new live frames, 50 durable events matched |
| cleanup | pass | session deleted (404) and tombstoned; device revoked and its token now 401 |

### Step 5 skip reason

The agent executed the invited tool call without asking for approval. The
durable log for the probe session after the tool prompt was:

```text
message, task_started, raw_output, tool_use, message, message, message, message, usage, result
```

The `tool_use` event named `Bash` with input `echo probe-w4b-ok`; a following
`message` event carried a `tool_result` content block with the output
`probe-w4b-ok`. There was no `approval_requested` event
(`approval_requested=0`), exactly one `tool_use`, zero standalone
`tool_result` events, and one embedded `tool_result` block. No
`POST /api/approvals` row existed for the session, and no SSE
`approval_update` frame arrived. Both `GET /api/approvals` and
`GET /api/approvals?status=pending` were readable (HTTP 200, 28 total rows and
0 pending at the time), and the turn reached `succeeded` after 10 s. This
matches the brief's pre-declared condition: the daemon runs with
`--allow-yolo`, so a turn may be suppressed from asking. It is not counted as
a contract gap.

## Measurements

- **Elapsed, first prompt → final recorded step:** 45,717 ms (45.7 s).
  Definition: from the `POST /api/tasks` that carries the first prompt to the
  moment step 6's final state match is recorded. Total process time: 45,811 ms.
- **Non-test Go LOC:** 1,970.
- **Peak client RSS:** 13,811,712 bytes (≈13.2 MiB), from `getrusage`.
- **Snapshot:** 163 sessions, 1 feed page.
- **Live stream:** 3 task frames in step 3 (2 `task_update`, 1 `event`), 2 task
  frames after reconnect, 0 unrecognized/mismatched frames.
- **Catch-up:** 50 durable events, one epoch, contiguous `seq`, every streamed
  identity present.

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
   declares message block types an open set.

## Server changes required

**0.** The probe only used documented routes; no daemon code, schema, or config
was changed.

## Verification

Final state of the frozen probe and report:

- `gofmt -l` clean.
- `go vet ./...` clean.
- `go test -race -count=1 ./...` pass (33.6 s, includes every fake-daemon and
  negative-path test).
- `scripts/mutants.py probe/kin-probe-w4b/mutants.json` **15/15 red**, each
  restore byte-for-byte.
- Live acceptance run: as tabled above, against the running daemon on
  `http://127.0.0.1:7777` with `-agent claude-code`.

One independent high-model review pass ran over the frozen probe and report.
It found **0 blockers, 4 majors, 6 nits**. All four majors were fixed:
step 5 now fails (rather than skipping) on unreadable or contradictory
observation; step 3 requires a `task_update`; the buffered-frame replay in
`SetTaskID` runs under the stream mutex; and negative tests plus mutants cover
`matchTask`, `checkContiguous`, `checkSubset`, the replay, and the approval
classification. All nits were addressed: the epoch-bump comment and test now
reuse a seq above 1, the contiguity check is documented as this run's shape,
frame counts are per task and pending drops are surfaced, pairing has a
recovery path and a label-based cleanup fallback, bodyless routes send no body,
and this report states every operator-credential use.

## Remaining gaps and residual risk

- Step 5's **decision** endpoint was exercised only against the fake daemon;
  the live daemon never asked, so `POST /api/approvals/{id}/decision` has no
  live evidence in this run.
- The daemon's **default agent** (`kin`) reported `available: true` but every
  turn produced `error` in this environment. The recorded run therefore names
  `claude-code` explicitly through the documented `agent` field. A client that
  trusts the default would see agent errors, not a contract error; this is an
  environment/agent observation, not a protocol gap.
- SSE keep-alive comments and `retry:` were parsed and unit-tested but not seen
  live, because no turn left the stream idle long enough.
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
reported **0 active `probe-w4b-*` devices**, 7 revoked devices from earlier
runs, and **0 `probe-w4b-*` sessions** in the feed.

## Commits

- `9b1e904b` — `feat(probe): add the W4b independent client acceptance probe`
  (probe module, fake daemon, tests, mutants).
- The report is committed immediately after in a `docs(plans): …` commit whose
  parent is the probe commit; the handoff names both branch-head SHAs.
