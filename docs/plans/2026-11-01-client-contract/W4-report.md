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

Final acceptance run: 2026-11-01T23:17:28+08:00 → 23:17:32+08:00 (4.07 s),
exit 0. Two live runs were made; both passed. The probe session
`probe-w4-*` was deleted and its paired device revoked afterwards.

## Metrics

| Metric | Value |
|--------|-------|
| Elapsed, first prompt → final acceptance run | 9 min 57 s ≈ **0.17 h** |
| Go LOC, non-test | **1,343** (`flow.go` 921, `client.go` 204, `types.go` 113, `main.go` 86, `rss.go` 19) |
| Go LOC, tests | 670 |
| Undocumented behaviors | **3** encountered live; **4** including the latent approval gap |
| Source-read violations | **0** |
| Server changes required | **0** |
| Client peak RSS | **13.67 MiB** (14,336,000 bytes, `getrusage` max) |

Success bar for W4: ≤2 days, 0 server changes, ≤3 undocumented behaviors.
Time and server changes pass clearly. The behavior count is 3 for what the run
exercised; counting the approval step (finding 4, unexercised) would make it 4.

## What the probe does

`probe/kin-probe-w4` is a standalone client, not a test harness:

1. reads the master token from `~/.kin/token` (the documented location), mints
   a pairing secret, exchanges it for a scoped device credential, and uses the
   device credential for the rest of the script;
2. takes `/api/sessions/cursor`, then walks `/api/sessions` from 0 until
   `has_more` is false to build the first snapshot;
3. opens `/api/events` as SSE before the first write (the order ADR 0024
   prescribes);
4. creates a task with a first prompt in a temporary directory, watches live
   frames and polls `/api/tasks/{id}` until `finished_at` is set;
5. lists approvals and, when one appears for the probe task, approves it via
   `POST /api/approvals/{id}/decision`;
6. closes the stream, drains the change feed from the pre-turn cursor,
   compares the reconstructed row against `GET /api/tasks/{id}` and the live
   event sequence against `/api/tasks/{id}/events`, then reopens the stream and
   proves a fresh change arrives on it.

Run it with:

```bash
cd probe/kin-probe-w4
go run . -base http://127.0.0.1:7777 -label probe-w4
```

Tests run the entire six-step flow against an in-process stub daemon, including
the approval branch, plus SSE framing and payload-extraction unit tests.

## The recorded run, in numbers

- Snapshot: 163 sessions, one page, cursor `1029`.
- Turn: 12 live frames (`7 × event`, `5 × task_update`), 3 text-bearing events.
- First assistant text 1,355 ms after the prompt; last 1,374 ms; terminal
  1,381 ms. **All assistant text arrived in a 19 ms burst ending 26 ms before
  the terminal update** — no progressive text during the 1.3 s turn.
- Durable log: 8 events, types `task_started`, `message` ×3, `raw_output`,
  `result`, `usage`. Live stream delivered 7 of the 8 (the initial user-message
  event was not seen live); every live sequence matched the durable log, and
  the missing one is recoverable from `/api/tasks/{id}/events`, exactly as
  ADR 0024's realtime-as-accelerant rule anticipates.
- Statuses observed: `queued` → `running` → `succeeded`.
- Catch-up: one change in one page from cursor `1029`; feed row matched
  `GET /api/tasks/{id}` on id, title, status, `event_epoch`, `finished_at`.
- Reconnect: stream reopened; an archive/unarchive pair produced a
  `task_update` frame 8 ms after the change.

## Undocumented behaviors and the workarounds they required

### 1. Event vocabulary, payload schema, and streaming semantics (largest gap)

The contract types `TaskEvent.type` as a free string and `TaskEvent.payload` as
an open object. It never says which types exist, which one carries assistant
text, what shape the text has, or whether text is incremental.

Observed vocabulary in one turn: `task_started`, `message`, `raw_output`,
`result`, `usage`. Assistant text lives in
`payload.content[].text` on `message` events.

Workaround: the probe walks every payload generically and accepts strings under
text-shaped keys (`text`, `delta`, `content`, `chunk`, `output`, `message`,
`result`). It calls text "live" when it arrives before `finished_at`. A real
client has no way to distinguish token streaming from end-of-turn batching
without guessing, and on this run the text was batched at the end.

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

- **Realtime is lossy.** 7 of 8 durable events arrived live. This is documented
  behavior (ADR 0024: the stream is an accelerant, `/api/sessions` and the
  durable log are the truth), and the probe recovered the missing event from
  `/api/tasks/{id}/events`.
- **`event_epoch` semantics.** Required on both `Task` and `TaskEvent`, never
  explained. The probe only compares equality; no workaround was needed for the
  P0 loop. Worth documenting anyway.

## Why step 5 was skipped

The live daemon was started with `--allow-yolo` (operator brief), and no
permission request was raised during the probe turn, so there was nothing to
approve. The README documents `kin serve` and its network modes but no switch
for a separate data directory or port, and the protocol sources say nothing
about one; starting an isolated daemon was therefore not "safe and obvious"
from documentation alone. No isolated daemon was started, and port `:7777` was
not touched. The approval client path is covered by the probe's tests against a
stub daemon: a pending row appears, the probe posts `approved`, and the
`approval_update` frame is applied.

## Delta from the W2 baseline

The brief asks W4 to record the delta, but the isolation rule forbids reading
any file under `docs/plans/2026-11-01-client-contract/` other than this report,
so the W2 baseline report could not be read. The W2 probe is also not present
on this branch, so the baseline code could not be compared. W4's numbers stand
on their own for W5 to diff against W2:

**0.17 h · 1,343 non-test LOC · 0 server changes · 3 live undocumented
behaviors (+1 latent) · 13.67 MiB peak RSS · 6/6 steps attempted, 5 pass,
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

## Verification

```bash
cd probe/kin-probe-w4
gofmt -l .          # clean
go vet ./...        # pass
go test -race -count=1 ./...   # pass (8.8 s)
```

Live acceptance run: `/tmp/kin-probe-w4 -base http://127.0.0.1:7777
-label probe-w4`, exit 0, summary archived outside the repository.

## Residual risk

- Step 5 was not exercised end to end; the approval representation is a
  documented guess.
- Streaming was measured only with the daemon's default `kin` agent. A
  different agent may produce text incrementally, but the contract gives a
  client no way to know or rely on it.
- Both live runs used the same daemon build (`0.0.0-dev`); behavior across
  versions is unmeasured.
- The probe deletes its session and revokes its device on exit; a failed
  cleanup is logged, not retried beyond one cancel-then-delete attempt.
