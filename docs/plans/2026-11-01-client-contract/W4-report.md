# W4 — Cold-start re-run of the independent client probe

Status: complete
Date: 2026-11-01
Branch: `w4-cold-start-probe`
Probe: `probe/kin-probe-w4/` (Go, standard library only)
Live target: `http://127.0.0.1:7777`

## Result

| # | Acceptance step | Result |
|---|-----------------|--------|
| 1 | Pair/login through the documented flow | **pass** |
| 2 | List sessions and capture the cursor | **pass** |
| 3 | Open a session and receive live events | **pass** |
| 4 | Send a prompt and see streaming text | **pass** — with the streaming caveat in finding 1 |
| 5 | Receive and approve a permission request | **skip** — not exercisable on the live daemon (see below) |
| 6 | Disconnect, reconnect, catch up from the cursor, match state | **pass** |

Final acceptance run: 2026-11-02T00:43:27.32+08:00 →
00:43:33.82+08:00 (6.50 s), exit 0. Six live runs were made against the daemon; the recorded final run
follows every review pass and uses a prompt that invites one benign tool use,
so step 5 was genuinely attempted. The probe session `probe-w4-*` was deleted,
its paired device revoked, and the daemon still answered health checks
afterwards.

## Metrics

| Metric | Value |
|--------|-------|
| Elapsed, first prompt → final acceptance run | 96 min 10 s ≈ **1.60 h** |
| Go LOC, non-test | **1,500** (`flow.go` 1,077, `client.go` 204, `types.go` 114, `main.go` 86, `rss.go` 19) |
| Go LOC, tests | **1,220** |
| Undocumented behaviors | **3** encountered live; **4** including the latent approval gap |
| Source-read violations | **0** |
| Server changes required | **0** |
| Client peak RSS | **13.86 MiB** (14,532,608 bytes, `getrusage` max) |

Success bar for W4: ≤2 days, 0 server changes, ≤3 undocumented behaviors.
Time and server changes pass clearly. The behavior count is 3 for what the run
exercised; counting the approval step (finding 4, unexercised) would make it 4.

## What the probe does

`probe/kin-probe-w4` is a standalone client, not a test harness:

1. reads the master token from `~/.kin/token` (the documented location), mints
   a pairing secret, and exchanges it for a scoped device credential; the
   device credential drives the snapshot, live stream, turn reads, approval
   list, and approval decision, while task creation falls back to the master
   token on a 403 and cleanup uses the master token (delete and revoke are
   operator-only in the contract, and one credential keeps the cleanup path
   uniform);
2. opens `/api/events` as SSE, then captures `/api/sessions/cursor` and walks
   `/api/sessions` from 0 until `has_more` is false to build the first
   snapshot — open-then-drain, the order ADR 0024 prescribes;
3. confirms the subscription is open and buffering before the first write;
4. creates a task whose first prompt asks for one benign shell command
   (`printf probe-w4-tool`) and then an exact reply marker, in a temporary
   directory; watches live frames and polls `/api/tasks/{id}` until
   `finished_at` is set;
5. lists approvals and, when one appears for the probe task, approves it via
   `POST /api/approvals/{id}/decision`;
6. closes the stream, reopens it, then drains the change feed from the
   pre-turn cursor, compares the reconstructed row against
   `GET /api/tasks/{id}` and the live event sequence against
   `/api/tasks/{id}/events`, then forces a change and **requires** a fresh
   `task_update` on the reopened stream; a silent stream fails the step.

Run it with:

```bash
cd probe/kin-probe-w4
go run . -base http://127.0.0.1:7777 -label probe-w4
```

Tests run the entire six-step flow against an in-process stub daemon, including
the approval branch, plus negative tests for a silent reopened stream, a
non-advancing feed cursor, a complete feed that ends exactly at the page cap
(no finding) and a truncated one (finding), a prompt echo that must not count
as assistant text on either the live stream or the durable log — including an
echo split across fragments, a marker that exists only durably, a durable-only
event that must be named `epoch:seq:type`, a replaced subscription that must
close its predecessor, an approval whose decision does not read back as
approved, an unreadable approval list that must not be reported as "no
approval", and the cancel-then-delete cleanup fallback. Event identity across
epochs, SSE framing, payload extraction, and task comparison have their own
unit tests.

## The recorded run, in numbers

- Snapshot: 163 sessions, one page, cursor `1105`; the SSE subscription was
  established before the first feed page.
- Turn: 17 live frames (`11 × event`, `6 × task_update`), 4 text fragments from
  3 `message` events and 1 `tool_result`. The turn used one tool: the durable
  log contains `tool_use` and `tool_result`. The reply marker itself arrived in
  a `message` event (`marker_live_types` = `["message"]`), not in tool output.
- First text fragment 2,328 ms after the prompt; last 3,771 ms; terminal
  3,778 ms. Text was observed before the terminal update, spread across the
  turn rather than delivered as a single end-of-turn batch.
- Durable log: 12 rows. The live stream delivered 11 of them; the unseen row is
  `{event_epoch 0, seq 1, type message}`, recorded by name. Every live event
  matched the durable log on `{event_epoch, seq}` and type — 0 missing, 0 type
  mismatches — and the unseen row is recoverable from
  `/api/tasks/{id}/events`, exactly as ADR 0024's realtime-as-accelerant rule
  anticipates.
- Statuses observed: `queued` → `running` → `succeeded`. `permission_mode`
  read `default` on both the create response and the terminal row.
- Catch-up: one change in one page from cursor `1105`, ending at `hub_seq`
  `1122`; feed row matched `GET /api/tasks/{id}` on id, title, status,
  `event_epoch`, `finished_at`.
- Reconnect: the stream was reopened before the feed drain; an archive/unarchive
  pair then produced a `task_update` in under 1 ms (reported as 0 ms by
  millisecond truncation) after the archive response.
- Cleanup: the probe task was deleted and the paired device revoked; the daemon
  answered health checks afterwards and no `probe-w4-*` session remained.

## Undocumented behaviors and the workarounds they required

### 1. Event vocabulary, payload schema, and streaming semantics (largest gap)

The contract types `TaskEvent.type` as a free string and `TaskEvent.payload` as
an open object. It never says which types exist, which one carries assistant
text, what shape the text has, or whether text is incremental.

Observed vocabulary in one turn: `task_started`, `message`, `usage`,
`raw_output`, `tool_use`, `tool_result`, `result`. Text-shaped payload fields
appeared on `message` (the assistant text) and on `tool_result` (tool output);
tool payloads carry their own open shapes. A client must walk every payload
generically.

Workaround: the probe walks every payload generically and accepts strings under
text-shaped keys (`text`, `delta`, `content`, `chunk`, `output`, `message`,
`result`), excluding text echoed back from its own prompt. It calls text "live"
when it arrives before `finished_at`. A real client cannot know from the
contract which event carries assistant output or whether a given event is token
streaming, a tool record, or an end-of-turn batch.

### 2. Task status vocabulary and terminal states

`Task.status` is an unconstrained string; no enum or terminal set is documented.
Observed values: `queued`, `running`, `succeeded`.

Workaround: treat `finished_at != 0` (a documented nullable field) as the
terminal signal, and pass `status` through to the UI as an opaque string.

### 3. Default agent when `CreateTaskRequest.agent` is omitted

`agent` is documented as optional, but the contract does not say what the
daemon does when it is absent — whether it picks the default, the active
provider's agent, or fails. `AgentInfo.default` exists, but the omission rule
does not.

Workaround: read `/api/agents` and select the row with `default: true` (agent
`kin` on this machine), falling back to the first installed-and-available row.

### 4. Pending approval representation — latent, unexercised

`Approval.decision` is required, but the value that marks a row pending is not
stated; `GET /api/approvals` takes a free-form `status` query with no documented
vocabulary. A client building an approval inbox must guess how to ask for
pending items and how to recognise one.

Workaround implemented in the probe: list all approvals, filter by `task_id`,
and treat `decision == ""` as pending. Step 5 could not run live (below), so
this behavior is implemented and unit-tested but not observed against the
daemon.

### Not counted

- **Realtime is lossy.** 11 of 12 durable rows arrived live. This is documented
  behavior (ADR 0024: the stream is an accelerant, `/api/sessions` and the
  durable log are the truth), and the probe recovered the unseen row
  (`event_epoch 0, seq 1, type message`) from `/api/tasks/{id}/events`.
- **`event_epoch` semantics.** Required on both `Task` and `TaskEvent`, never
  explained. The probe only compares equality; no workaround was needed for the
  P0 loop. Worth documenting anyway.

## Why step 5 was skipped

The probe's prompt asks the agent to run one benign shell command
(`printf probe-w4-tool`) before replying, so the step was genuinely attempted
this time. The durable log shows `tool_use` and `tool_result`, so a tool did
run, yet no approval row appeared for the probe task: `GET /api/approvals` was
readable (`approval_list_ok` true) and returned zero rows for the task. That is
consistent with the live daemon running `--allow-yolo` (operator brief): the
operator had already disabled the permission gate. The task's
documented-but-free-form `permission_mode` field read `default` on both the
create response and the terminal row; the contract documents no vocabulary for
it, so the client cannot tell from the protocol whether `--allow-yolo`, a
`default` mode, or an agent policy suppressed the request.

The README documents `kin serve` and its network modes but no switch for a
separate data directory or port, and the protocol sources say nothing about
one; starting an isolated approval-enforcing daemon was therefore not "safe and
obvious" from documentation alone. No isolated daemon was started, the `:7777`
daemon was not restarted or reconfigured, and port `:7777` was not touched. The
approval client path is covered by the probe's tests against a stub daemon: a
pending row appears, the probe posts `approved`, and the `approval_update`
frame is applied.

## Delta from the W2 baseline

The brief asks W4 to record the delta, but the isolation rule forbids reading
any file under `docs/plans/2026-11-01-client-contract/` other than this report,
so the W2 baseline report could not be read. The W2 probe is also not present
on this branch, so the baseline code could not be compared. W4's numbers stand
on their own for W5 to diff against W2:

**1.60 h · 1,500 non-test LOC · 0 server changes · 3 live undocumented
behaviors (+1 latent) · 13.86 MiB peak RSS · 6/6 steps attempted, 5 pass,
1 documented skip.**

## Source isolation log

Read (allowed): `api/openapi.yaml`, ADR 0022, ADR 0024, `README.md`, and the
master plan file (explicitly required). Wrote only this report under
`docs/plans/2026-11-01-client-contract/`.

Temptations logged, not acted on:

- reading `internal/` to learn event types and payload shapes — instead the
  probe discovered them from runtime frames and the durable log;
- reading the W2 report or the W2 probe to compute the delta — forbidden by the
  isolation rule; the delta is handed to W5;
- running `kin serve --help` to look for an isolated-daemon flag — CLI help is
  outside the allowed protocol sources, and the README documents no such flag,
  so step 5 was skipped instead.

Source-read violations: **0**.

## Largest remaining contract gaps

1. **Event vocabulary and streaming semantics.** A client cannot render
   assistant output progressively from the contract; it can only guess at
   payload keys and accept end-of-turn batches as "streaming".
2. **Status vocabulary.** No enum, no terminal set; clients fall back to
   `finished_at` or display raw strings.
3. **Approval pending representation and the `status` filter.** Unverified
   live; the probe's guess is reasonable but untested against the daemon.
4. **Default agent rule when `agent` is omitted.**
5. **`event_epoch` semantics** — required but unexplained.
6. **`permission_mode` vocabulary.** A nullable free-form string on `Task` and
   the create/follow-up requests; observed `default`, with no documented set or
   relationship to whether approvals will be raised.

## Review passes

Four independent review passes ran against the delivery. The first raised
three majors, all fixed before the recorded run:

1. **Step 5's cause was unproven** because the prompt forbade tools. The prompt
   now invites one benign command, the skip reason states the prompt and the
   `--allow-yolo` possibility, and the run confirmed via `tool_use` /
   `tool_result` that a tool actually ran.
2. **Step 6 could pass without its reconnect proof.** A silent reopened stream
   now fails the step; a negative test uses a stub daemon that suppresses the
   frame.
3. **Pagination was not really asserted.** Tests now require the seeded session
   count, the `limit=500` page size, and a finding when the feed cursor does
   not advance.

The second pass raised two majors, both pre-existing rather than regressions:

4. **The probe drained before opening, against ADR 0024.** The snapshot now
   opens the stream before the first feed page, and the reconnect reopens
   before the catch-up drain; a request-ordering test fails if either is
   reversed.
5. **The marker could pass on the probe's own prompt echo.** Text echoed from
   the prompt is filtered out of both live and durable transcripts, and the
   step now requires the marker in live text; durable-only text is recorded but
   fails the step. Negative tests cover both the echo and the durable-only
   marker.

The third pass, over the fixes from the second, reported no blocker and no
major. A fourth and final pass then found one major the third missed: because
the prompt-echo filter ran per fragment, an echo split across fragments could
still carry the marker into "live" text and pass step 4 with no assistant
output. The filter now subtracts the exact prompt from the joined live and
durable transcripts; a split-echo regression test and three mutants cover it.
Its remaining findings were nits, all fixed and covered by tests and the
committed mutant manifest: event identity is `{event_epoch, seq}` rather than
`seq` alone, with separate unit tests for the live map and the durable index;
the SSE reader exits when its stream closes instead of leaking a blocked
goroutine; a replaced subscription closes its predecessor; durable-only rows
are named `epoch:seq:type`; `permission_mode` is decoded and observed; page
caps emit a finding only when the feed still reports `has_more`; the marker's
delivering event type is recorded; an approval only counts when the daemon's
response reads back `approved`; "no approval appeared" is reported only when
the approval list was readable, and the skip records that it was; cleanup's
cancel-then-delete fallback and device revoke are counted and tested; and the
prompt-echo filter is exercised on both the live and durable paths, including
the split-fragment case.

## Verification

```bash
cd probe/kin-probe-w4
gofmt -l .          # clean
go vet ./...        # pass
go test -race -count=1 ./...   # pass (31.6 s, 20 tests)
```

Twenty-seven mutants, committed in `probe/kin-probe-w4/mutants.json`, were
applied with `scripts/mutants.py probe/kin-probe-w4/mutants.json`; all 27 were
detected (red) and every file was restored byte for byte.

Live acceptance run: `/tmp/kin-probe-w4 -base http://127.0.0.1:7777
-label probe-w4 -turn-timeout 8m -timeout 18m -out
/tmp/probe-w4-summary-final4.json`, exit 0, summary archived outside the
repository. Afterwards the daemon still answered `GET /api/health` with 200 and
no `probe-w4-*` session remained in the change feed.

## Residual risk

- Step 5 was not exercised end to end; the approval representation is a
  documented guess. The final run did prove a tool ran without an approval,
  which is consistent with `--allow-yolo`, but the client cannot distinguish
  that from a `default` permission mode or an agent-level policy through the
  protocol.
- Streaming was measured only with the daemon's default `kin` agent. Four text
  fragments arrived across the turn, but they came from `message` and
  `tool_result` events, and the contract gives a client no way to tell
  assistant output from tool output or to rely on incremental delivery.
- Step 4's echo filter subtracts the exact prompt text from the joined
  transcript. A daemon that reformats or re-chunks the echoed prompt (different
  whitespace, dropped markup) could still let a marker-bearing fragment through.
  The live daemon did not echo the prompt on the stream at all, so this path is
  covered only by the stub daemon.
- All live runs used the same daemon build (`0.0.0-dev`); behavior across
  versions is unmeasured.
- The probe opens the live stream before draining the snapshot and before the
  reconnect catch-up, but it does not read frames while either drain runs: the
  reader goroutine buffers up to 256 frames, after which delivery stops until
  the drain ends and the next step consumes them. The live snapshot was one
  page of 163 sessions and the catch-up one page, so this never bound; a very
  large snapshot or catch-up could stall the subscriber or overflow the
  daemon's bus, and that case is untested. A catch-up larger than the buffer
  would also delay the archive `task_update` that step 6 waits for.
- The probe deletes its session and revokes its device on exit. Cleanup is best
  effort: a failed delete is logged, with one cancel-then-delete retry that is
  covered by tests.
