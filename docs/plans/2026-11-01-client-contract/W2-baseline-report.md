# W2 — Cold-start client baseline

Status: complete (baseline before W1's contract changes)
Date: 2026-11-01
Workstream: W2, client-contract program (`2026-11-01-client-contract-program.md`)
Deliverables: `probe/kin-probe/` (Go, standard library only) and this report.

## TL;DR

An independent client built from the public contract alone passes five of the
six acceptance steps against the live daemon (pair, snapshot, live events,
streaming prompt, reconnect and catch-up with a state match). The sixth — a
permission request — could not be exercised because the daemon runs with
`--allow-yolo`; the client implements the path, but this report does not claim
the approval round trip works end to end.

It needed **zero server changes**. It could not start without a credential that
the contract does not describe, and it had to reverse-engineer the event
payloads, the streaming delta semantics, and one workspace default that breaks
follow-up turns. Those are the gaps worth fixing.

| Measure | Result |
| --- | --- |
| Acceptance script | **passes with one skip** (5 passed, 1 skipped; §2) |
| Passing runs | 7 (the final instrument is the run quoted in §2) |
| Undocumented behaviors | **9** across the work (numbered in §5); 5 fire in the final run |
| Source-read violations | **0** (§6) |
| Server changes required | **0** |
| Probe size | 3,370 Go lines (2,641 non-test), stdlib only |
| Client peak RSS | **13.8 MiB** (14,434,304 bytes, `getrusage`; the Darwin bytes unit was cross-checked against `ps`) |
| Elapsed wall-clock | 13:43–14:56 UTC on 2026-11-01 (≈73 min), single agent session; the acceptance run itself 26 s (§8 caveat) |

Acceptance script reference: master plan §W2. Environment: macOS arm64, Go
1.26.4, daemon `0.0.0-dev` on `http://127.0.0.1:7777`, started as
`kin serve --hub https://kin.example.com --root ~/Workspace --lan --allow-yolo`
(not restarted during the probe).

## 1. What was built

`probe/kin-probe` is a small CLI client. It imports nothing from OpenKin and
uses only the Go standard library, so nothing in the first-party tree can leak
protocol knowledge into it.

| Command | Endpoint(s) |
| --- | --- |
| `pair` | `POST /api/pairing/sessions`, `POST /api/pairing/exchange` |
| `snapshot` | `GET /api/sessions/cursor`, `GET /api/sessions` |
| `watch` | `GET /api/events` (SSE) |
| `create`, `prompt` | `POST /api/tasks`, `POST /api/tasks/{id}/prompt` |
| `approvals`, `decide` | `GET /api/approvals`, `POST /api/approvals/{id}/decision` |
| `catchup` | `GET /api/sessions`, `GET /api/tasks/{id}/events` |
| `run` | the six-step acceptance script, with evidence JSON |

Design rules the contract states and the probe follows: the cursor advances
only from a feed page (ADR 0024); the stream is an accelerant, never the truth;
events are applied by id/seq; the catch-up order in `run` is
open-stream-then-drain-feed.

## 2. Acceptance result

Final run (`run` command, evidence `evidence8.json`, 14:56:28–14:56:54 UTC):

| # | Step | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Pair/login through the documented flow | pass | `POST /api/pairing/sessions` 201 → secret; `POST /api/pairing/exchange` 201 → `device_id`, `token`, `desktop_name`; device token accepted on `/api/sessions` |
| 2 | List sessions, capture cursor | pass | cursor before snapshot 962; walk from 0: 163 sessions, 19 deleted, 1 page, `next_cursor` 962 |
| 3 | Open session, receive live events | pass | the new task produced 11 `event` and 5 `task_update` frames, plus the `retry` preamble; no stream error; first turn `succeeded` |
| 4 | Send prompt, see streaming text | pass | 4 assistant `partial:true` deltas (10 bytes) at 6.26 s, then the final message `PROBE-DONE`; the recorded status was still `running` because the Task read lagged the final SSE frame |
| 5 | Receive and approve a permission request | **skipped** | the turn used the Bash tool, but zero `approval_requested` / `approval_decided` events exist in the live or durable transcript (12 durable events checked) and no approval row exists; the daemon runs `--allow-yolo`, which appears to bypass the gate. Nothing to approve, so nothing could be approved — recorded as an environment condition, not a pass |
| 6 | Disconnect, reconnect, catch up, match state | pass | resume cursor 962; the feed page from it includes the task (`next_cursor` 1012); catch-up returned all 11 durable events after live seq 24 (0 missing, 0 extra; horizon seq 35); full transcript 35 events; feed row equals a fresh read (`status`, tokens, `finished_at`); rebuilt assistant text equals the full transcript; the separate gap check found seq 1 missing from the live stream and refetched it; the reopened stream was healthy (`retry` frame, no error after catch-up) and replayed none of the 11 events that occurred while it was closed |

Every run creates exactly one task titled `probe-w2-acceptance-<unix>` and one
paired device. Cleanup deletes the task and revokes the device: the task read
after the run is `404`, and the device row in `GET /api/devices` has
`revoked_at` set. The probe's later runs also learned that deletion requires the
master credential (§5.7).

## 3. The six steps, as the client saw them

### 3.1 Pairing (step 1)

The contract documents a two-request pairing flow but not how to authenticate
the first request. Observed black-box:

```text
POST /api/pairing/sessions            (Bearer <master token>)  -> 201
  {"secret":"<one-time>","expires_at":<epoch-ms>}

POST /api/pairing/exchange            (no auth)                -> 201
  {"device_id":"ios-<hex>","token":"<device token>",
   "label":"kin-probe-w2","desktop_id":"desktop_<hex>",
   "desktop_name":"<host>"}
```

Without the master token the first request is `401` with
`WWW-Authenticate: Bearer realm="kin"` — the only place the auth scheme is
stated. The `kin` CLI in this build has **no `token` command** (only
`kin token rotate`); the master token lives in `~/.kin/token` (mode 0600). A
client that does not run on the daemon host has no documented path to it.

### 3.2 Snapshot (step 2)

```text
GET /api/sessions/cursor                          -> {"cursor":962}
GET /api/sessions?updated_since=0&limit=500       -> {"sessions":[Task...],
                                                      "deleted":["<id>"...],
                                                      "next_cursor":962,
                                                      "has_more":false}
```

The walk from zero was one page on this database (163 live sessions, 19
tombstones). Each `Task` carries
`hub_seq`, as ADR 0024 says, so a client can tell how far behind a push frame
leaves it.

### 3.3 Live events (step 3)

`GET /api/events` with `Accept: text/event-stream` immediately sends
`retry: 3000`, then frames:

```text
event: event
data: {"kind":"event","data":{"task_id":"<id>","event_epoch":0,"seq":5,
                              "ts":...,"type":"message","payload":{...}}}

event: task_update
data: {"kind":"task_update","data":{...Task...}}
```

The final run counted 11 `event` and 5 `task_update` frames for a short turn;
earlier runs also carried two `: ping` heartbeat comment frames, but this one
lasted under nine seconds and saw none.
Heartbeats are comment frames; the spec mentions
`: ping` but not the cadence.
The stream carries no replay and no readiness signal: a turn that ran entirely
while the client was disconnected produced 11 durable events, and the reopened
stream delivered none of them. The client treats the `retry` preamble as the
earliest proof that the subscription is attached, and it must still drain the
feed for anything it missed.

### 3.4 Prompt and streaming (step 4)

`POST /api/tasks/{id}/prompt` with `{"prompt":"..."}` returns the updated Task
(200). Assistant text arrives as `message` events (shape from an earlier run; the
final run saw the same four-delta pattern in 10 bytes):

```text
seq 18  {"role":"assistant","partial":true, "index":1,
         "content":[{"type":"text","text":"PRO"}]}
seq 19  {"role":"assistant","partial":true, "index":1,
         "content":[{"type":"text","text":"BE"}]}
...
seq 22  {"role":"assistant","partial":false,
         "content":[{"type":"text","text":"PROBE-DONE"}]}
```

`partial:true` events are **deltas**, not cumulative snapshots; the
`partial:false` event repeats the complete text. Nothing in the contract says
this — `TaskEvent.payload` is `{}` for every event type. The step also
illustrates a timing trap: the final SSE frame can arrive after `GET
/api/tasks/{id}` has already reported the turn's outcome, and the reverse
happens too — the final run saw the final text while the status read still said
`running`. A client must not let a status poll and the stream judge each other.
The step waits a bounded grace for the final frame, records the status it saw
without requiring the turn to be over, and leaves completed-text verification
to step 6.

### 3.5 Permission request (step 5)

The follow-up prompt asked the agent to run `echo probe-ok` through the Bash
tool. Transcript evidence: one `tool_use` event, one tool result message, zero
`approval_requested` / `approval_decided` events, and
`GET /api/approvals` returned an empty list for the task. The daemon was
started with `--allow-yolo`, which is the likely cause; the probe did not
restart the daemon to isolate it, so this report says "appears bypassed". The
acceptance step therefore has no object in this environment. To test the
approval path a daemon without that flag (or a
non-bypassed permission mode) is required. The probe implements the whole
path — `GET /api/approvals?status=pending`, `POST
/api/approvals/{id}/decision` — and reports the step as *skipped with reason*
rather than silently passing it.

### 3.6 Disconnect and catch-up (step 6)

Procedure and evidence:

1. cursor held by the client = 962, captured before the snapshot (ADR 0024);
   resuming from it can replay a change but cannot miss one;
2. the previous turn is confirmed terminal, then the stream is closed; a
   follow-up prompt is accepted and runs to completion with no stream attached;
3. the stream is reopened and proven healthy before anything else (its `retry`
   frame arrives, no error); it replays none of the offline turn's events. The
   feed drained from 962 returns one changed session, the probe task
   (`next_cursor` 1012); the feed row equals a fresh `GET /api/tasks/{id}` on
   `status`, tokens, and `finished_at`;
4. `GET /api/tasks/{id}/events?since_seq=24` returns 11 events. The durable
   transcript has exactly 11 events after seq 24, and the full transcript read
   just before catch-up ends at seq 35, so catch-up is checked against an
   independently computed expectation: 0 missing, 0 extra. The full transcript
   is 35 events;
5. the union of live (delivered seqs 2–24) + catch-up is compared with the full
   transcript **before any repair**. The live stream had missed **seq 1** (the
   user message written at create time — see §5.3), recorded as
   `live_missing_before_repair=[1]`, and the rebuilt assistant text matched
   even with that hole because the missing event was not assistant text;
6. only then does the probe refetch from the first hole, after which the union
   matches the durable transcript exactly. The refetch is reported separately
   (`gap_repaired`), so it cannot make a failed catch-up look healthy.

The ADR-0024 order — open the stream, then drain the feed — is what makes this
safe; the probe implements it in `run`. The standalone `catchup` command
resumes the feed and fetches events, but it does not open a stream itself.

## 4. Cost

| Metric | Value |
| --- | --- |
| Elapsed | 13:43–14:56 UTC, ≈73 min (single agent session; see §8) |
| Probe LOC | 3,370 Go lines total; 2,641 non-test |
| Acceptance run | 26 s wall-clock (14:56:28–14:56:54 UTC) |
| Dependencies | 0 |
| Client peak RSS | 13.8 MiB during the full run |
| Server changes | 0 |
| Server restarts | 0 |
| Agent turns consumed | 3 per acceptance run; the daemon's `result` events reported $0.13–$0.18 per turn, ≈$0.47 per run (agent-reported cost, not billing data) |

## 5. Undocumented behaviors (numbered, prioritized)

Each item was hit while implementing the acceptance script. Priority reflects
what blocks or taxes the next independent client, not implementation taste.

### P0 — blocks a cold start

1. **No credential bootstrap and no `securitySchemes`.** The spec never states
   the auth scheme, the header, or where a client's first token comes from.
   `POST /api/pairing/sessions`, the first documented pairing step, itself
   requires the master bearer (`401` otherwise, and that response is not
   documented either). The scheme is only discoverable from the
   `WWW-Authenticate: Bearer realm="kin"` header on a failed request; the
   master token is only obtainable on the daemon host (`~/.kin/token`). On a
   Hub with accounts, sign-in routes are not in the document at all.
   *Observed:* `401` + `WWW-Authenticate`; `201` after supplying the master
   token.

### P1 — shapes a client spends days on

2. **Every event payload is `{}` in the schema.** A client cannot decode
   streaming text, tool calls, approvals, questions, usage, or errors from the
   contract. The probe reconstructed at least these shapes from the wire (live
   runs and the durable transcripts of pre-existing sessions):
   `message` (`role`, `partial`, `index`, `content[]`), `tool_use`,
   `approval_requested` (`approval_id`, `kind`, `payload`), `result`
   (`is_error`, `raw`, `usage`, `cost_usd`), `error` (`message`), `usage`,
   `task_started`, `checkpoint_skipped`, `workspace_*`, `round_changed`.
   Partials are deltas (§3.4); error text only exists in the `error` event, not
   in the Task.
3. **The SSE stream has no readiness signal and no in-band gap signal.** In
   every run, seq 1 was not delivered to the stream the client had just
   opened — either it was written before the subscription became active, or it
   was dropped, and the client cannot tell which. `retry: 3000` is
   sent, but the spec mentions only `: ping` comments and says nothing about
   retry, cadence, replay, or the possibility of a hole. A client must compare
   `seq` continuity and refetch from the first missing seq — the probe does,
   and ADR 0024's "open the stream, then drain the feed" order is the documented
   mitigation, but the endpoint description does not repeat it. In the final
   run a turn produced 11 durable events entirely while the stream was closed,
   and the reopened stream delivered none of them, so a reconnect cannot be
   relied on to replay what was missed.
4. **`workspace_mode` values and `cwd` resolution are undocumented.** Creating
   a task with only `cwd` + `prompt` used the default `workspace_mode:
   "worktree"`. The first turn ran, then the follow-up failed with
   `task execution directory is unavailable: <kin-worktree>/<task>-g1/<cwd
   relative to workspace root>` because the generated worktree does not contain
   the (gitignored) directory. Passing `"workspace_mode":"shared"` fixed it.
   The field exists in the contract as an unconstrained string; its values,
   defaults, and the generation lifecycle are invisible. A client that follows
   only the documented required fields gets a session that works once and then
   fails.
5. **Permission bypass is invisible.** With a daemon started with
   `--allow-yolo`, a tool-using turn emitted no `approval_requested` or
   `approval_decided` event in the live or durable transcript and left no
   approval row. There is no
   documented field or event that tells a client "approvals are bypassed for
   this daemon/turn", so a client cannot distinguish "nothing needed approval"
   from "the gate was bypassed, do not wait". `decided_via` values are also
   undocumented.

### P2 — friction, correctness traps

6. **Paired device ids are minted as `ios-<hex>`** regardless of the client;
   the exchange request has no documented client-kind field. Cosmetic today,
   misleading in a device list that mixes platforms.
7. **`DELETE /api/tasks/{id}` exists but is undocumented and master-only.**
   A device token gets `403`; the master token gets `204` and the task is gone
   (`404` afterwards). The contract documents no delete at all, so a paired
   client's only cleanup is `archive`, which hides the row but keeps it.
8. **Timestamp units and undocumented error responses.** Most integer
   timestamps are epoch milliseconds but the schemas do not say so
   (`PairingSessionResponse.expires_at`, `Task.created_at`, …). Master-only
   routes document only their success response (`/api/pairing/sessions` lists
   only `201`; `/api/devices` only `200`), so `401`/`403` handling is
   guesswork.
9. **`Task.status`, `permission_mode`, and `workspace_mode` have no enums.**
   The contract types `status` and the two request modes as plain strings. A
   client cannot know which status values end a turn; the probe's terminal set
   (`succeeded`, `failed`, `canceled`, plus an unknown-means-terminal fallback)
   is inferred from the wire. `permission_mode` suffers the same problem as
   `workspace_mode` (§5.4): the field exists, its accepted values do not.

## 6. Source-read discipline

**Violations: 0.** No file under `internal/`, `ui/src/`, `desktop/src/`, or
`mobile/` was read. The only repository files opened outside the allowed
contract set were the master plan that assigned this work, build configuration
(`go.mod`, `scripts/check.sh`) to scope checks, and the probe's own artifacts;
none contains protocol behavior.

Times I was tempted, and what answered the question instead:

| Question | Temptation | Resolution without source |
| --- | --- | --- |
| Which auth scheme and header? | read `internal/api` middleware | `401` + `WWW-Authenticate: Bearer realm="kin"` |
| Where does the first credential come from? | read auth/hub code | `kin --help` (no token command), `~/.kin/token`, pairing responses |
| What is inside `TaskEvent.payload`? | read event writers | durable `/api/tasks/{id}/events` from existing sessions, then live runs |
| Why did the follow-up turn fail? | read workspace provisioning | `error` event text + `workspace_mode`/`workspace_scope` fields on the Task |
| Why was no approval raised? | read permission/yolo code | process argv (`--allow-yolo`) + empty approvals + zero approval events |

## 7. First attempt failed; what that cost

The first acceptance run failed at steps 4–6 for one reason: the default
workspace mode. It was visible only as a follow-up-turn `error` event, after a
first turn that had succeeded in the same directory. The probe was not changed
to hide it: the fix is one documented-but-unvalued field
(`workspace_mode:"shared"`), and the failure is finding §5.4. Two measurement
bugs were also found and fixed in the probe itself (Darwin `ru_maxrss` is bytes,
not KiB; gap repair must also handle a hole at seq 1). Passing runs followed,
across instrument revisions.

A later review of the instrument found two defects that could have flattered
the result: live events were keyed by seq alone although event seq restarts per
task, and the catch-up assertion could be satisfied by the gap-repair refetch.
Both are fixed. The per-task event map has a regression test; the
catch-up-before-repair order has no unit test — it is enforced by code order and
visible in the evidence, where `catchup_missing_seqs` and
`live_missing_before_repair` are computed before `gap_repaired`. A second review
found that the step-3 frame check could be satisfied by another session's
frames, that stream and decode errors were collected but never surfaced, that
cleanup could blank a newer run's credential, and that step 4 raced the final
SSE frame. Those are fixed too: frames are counted per task and per stream,
`waitStreamReady` and the evidence `extra` block expose stream/decode errors,
cleanup clears the saved token only when it still belongs to the revoked
device, and step 4 waits a bounded grace for the final frame.

A third review found that stream liveness was recorded but never asserted, that
malformed `task_update`/`approval_update` frames were dropped silently, and
that step 5 could claim a bypass when the approvals route had failed. Those are
fixed: a clean server close, a decode failure, or an `event_epoch` change now
fails the run; step 6 rechecks the resumed stream after catch-up; step 5 reads
live and durable events before choosing its skip reason and records both
approvals-query errors; and the catch-up expectation is bounded by the horizon
catch-up actually returned. A fourth review found that last bound was still
self-referential — a truncated catch-up defined its own passing horizon — and
that step 5 could still claim a bypass when the durable transcript read failed
while the live stream happened to show a tool. Both are fixed: the horizon now
comes from the full transcript read before catch-up (an event above it is a
late append; an in-horizon event the full read lacks fails the step), and a
failed durable read fails step 5 regardless of what the live stream showed, so
the bypass finding is only emitted from a complete transcript. Twelve guards
are red-verified with `scripts/mutants.py`. The nested probe module is wired
into `scripts/check.sh` when probe files change or under `--all`; CI does not
invoke `check.sh`, so the probe suite runs in the local completion gate rather
than in CI. The final run quoted in §2/§3.6 was made from the probe source
committed here. A fifth pass verified those fixes against the committed tree
and found no remaining blocker or major issue; two failure-path nits were
deferred: the "extra" catch-up message should say "outside the expected set"
rather than "not in the full transcript" when catch-up applies an inclusive
`since_seq`, and a turn-scoped durable-read failure can be masked by an
earlier-turn `error` event because that skip branch runs first. Neither can
emit the bypass finding or change a passing result.

## 8. Elapsed-time caveat

The recorded span is wall-clock time inside one agent session, not a human
estimate. It is useful as a floor for "how long the wire protocol takes to
implement once the environment is known", not as evidence for the program's
2-working-day budget. A human still has to discover the bootstrap credential,
run an agent to see payload shapes, and debug the workspace default; the probe
had a warm daemon with roughly 160 existing sessions and could read their
transcripts black-box, which a true cold start cannot.

## 9. Prioritized gap list for W1 and W4

**W1 (contract):**

1. `securitySchemes` + the full credential story: master vs device token,
   pairing prerequisites, Hub login routes, and documented `401`/`403`
   responses on every protected path. (Fixes §5.1, §5.8.)
2. Publish `TaskEvent.payload` schemas for at least `message`, `tool_use`,
   `approval_requested`, `approval_decided`, `result`, `error`, and `usage`,
   including the delta/final message rule. (Fixes §5.2.)
3. In the `/api/events` description: `retry`, heartbeat cadence, no replay, no
   readiness signal, and the ADR-0024 open-then-drain order. (Fixes §5.3.)
4. Give `workspace_mode` an enum with documented defaults/semantics, and say
   what happens when `cwd` is not present in the generated checkout. (Fixes
   §5.4.)
5. Document permission modes/bypass and `decided_via`. (Fixes §5.5.)
6. Publish enums (or at least the terminal set) for `Task.status`, and accepted
   values for `permission_mode` and `workspace_mode`. (Fixes §5.9.)

**W4 (re-run):**

- Re-run the same acceptance script against the updated `main`; the target is
  ≤3 undocumented behaviors. Items 1 and 8 should disappear from the spec
  alone; items 2–5 need schema/runtime documentation; items 6–7 need a decision
  (document or remove); item 9 needs an enum.
- Run step 5 against a daemon **without** `--allow-yolo` (or with a
  non-bypassed permission mode) so the approval path is actually exercised.
  This report cannot claim the approval round trip works end to end; it can
  only claim the client implements it from the documented shapes and that the
  environment suppressed it.

## 10. Reproduction

```bash
cd probe/kin-probe
go build -o kin-probe .
go test -race ./...

# The contract does not document this credential; see §5.1.
./kin-probe run \
  -base http://127.0.0.1:7777 \
  -master-token-file ~/.kin/token \
  -state /tmp/kin-probe-state.json \
  -evidence /tmp/kin-probe-evidence.json \
  -scratch /tmp/kin-probe-cwd
```

Exit status is `0` when all six steps pass, `3` when a step was skipped in this
environment, and `1` on a failed step. The recorded run exited `3` (five passed,
one skipped).

Evidence JSON from the recorded runs is not committed: it contains live
session ids, absolute paths, and the daemon's desktop name. The probe writes it
wherever `-evidence` points, mode 0600. When the probe is run from
`probe/kin-probe`, its default state and evidence files are gitignored.

## 11. Residual risk

- One daemon, one agent (`claude-code`), one machine, one OS. Approval,
  question, multi-device dispatch, and relay paths were not exercised.
- The approval step is **skipped, not passed**; the client's decision call is
  implemented but unverified against a live pending approval.
- The daemon was live and not restarted; its data included roughly 160 pre-existing
  sessions, which made payload reverse-engineering cheaper than a true cold
  start would be.
- The terminal-status set is inferred (§5.9); a new or renamed status would
  change what "the turn finished" means without a client being able to tell.
- The probe proves the wire contract is implementable; it does not prove the
  console's assumptions are absent. A generated-client check (W1's coverage
  script) is still the durable guard.
