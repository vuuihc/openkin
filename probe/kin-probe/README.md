# kin-probe

An independent OpenKin client, written to answer one question: **can a developer
who has only the public contract build a working client?**

The probe was built for workstream W2 of the client-contract program. It was
allowed to read only `api/openapi.yaml`, `docs/adr/0022-*`, `docs/adr/0024-*`,
`README.md`, and the daemon's black-box HTTP/SSE behavior. It does not import
any first-party code, and it uses only the Go standard library.

The measured result and the gap list live in
[`docs/plans/2026-11-01-client-contract/W2-baseline-report.md`](../../docs/plans/2026-11-01-client-contract/W2-baseline-report.md).

## Build

```bash
cd probe/kin-probe
go build -o kin-probe .
go test -race ./...
```

Go 1.26.4 or newer (the version in `go.mod`). No third-party dependencies.

## Commands

| Command | What it does | Contract endpoints |
| --- | --- | --- |
| `pair` | mints a device credential | `POST /api/pairing/sessions`, `POST /api/pairing/exchange` |
| `snapshot` | reads the cursor, then walks the change feed from zero | `GET /api/sessions/cursor`, `GET /api/sessions` |
| `watch` | streams and summarizes live frames | `GET /api/events` (SSE) |
| `create` | creates a session | `POST /api/tasks` |
| `prompt` | sends a follow-up | `POST /api/tasks/{id}/prompt` |
| `approvals` | lists approvals | `GET /api/approvals` |
| `decide` | answers one approval | `POST /api/approvals/{id}/decision` |
| `catchup` | resumes the feed from a cursor (and persists it) and, with `-task`, fetches events after a seq | `GET /api/sessions`, `GET /api/tasks/{id}/events` |
| `run` | executes the six-step acceptance script and writes evidence JSON | all of the above |

Every command takes `-state` (default `.kin-probe-state.json`, mode 0600). The
state file holds the device token. Run from this directory, the default state
and evidence files are gitignored; the evidence file is also 0600 because it
names live tasks, devices, and paths. Point `-state`/`-evidence` elsewhere and
their ignore status is your responsibility.

### The bootstrap the contract does not describe

`POST /api/pairing/sessions` — the first documented pairing step — itself
requires a bearer credential that only the daemon host holds. The public
contract has no `securitySchemes`, no login endpoint, and no documented way to
obtain that first credential. The probe therefore reads the daemon's master
token from `~/.kin/token` (or `KIN_MASTER_TOKEN`, or `-master-token-file`) and
records this as the top finding rather than pretending it did not happen.

On a Hub with accounts, the sign-in routes live outside the OpenAPI document
entirely; a cold-start client cannot discover them.

## Acceptance run

```bash
./kin-probe run \
  -base http://127.0.0.1:7777 \
  -state .kin-probe-state.json \
  -evidence evidence.json \
  -scratch ./agent-cwd
```

The run:

1. pairs through the documented exchange;
2. captures `/api/sessions/cursor` and pages the feed from zero;
3. opens `/api/events`, creates a `probe-` session, and watches live frames;
4. sends a prompt and measures assistant text deltas;
5. waits for a permission request, approves it if one appears, and records why
   when none does;
6. closes the stream, makes a change while disconnected, reopens the stream,
   drains the feed from the last feed cursor, fetches events after the last
   live seq, repairs any seq gap, and compares the rebuilt state with a fresh
   read.

The run creates one task titled `probe-w2-acceptance-<unix>` and one paired
device. Cleanup deletes the task (the route exists but is master-only and
undocumented) and revokes the device, even when the run is interrupted; the
cleanup context is detached from the cancelled run. Nothing else is touched.

Exit status: `0` all six steps passed, `3` passed with at least one skipped
step (the permission step in a `--allow-yolo` environment), `1` a step failed
or the evidence file could not be written.

## Deliberate choices

- **Events are decoded by shape, not by schema**, because the contract declares
  every `TaskEvent.payload` as `{}`. The decode rules the probe had to infer
  (assistant `partial:true` events are deltas; a `partial:false` event carries
  the full text) are documented in the report as a contract gap.
- **The cursor only advances from a feed page**, per ADR 0024. `run` resumes
  from the cursor it captured before the snapshot (ADR 0024's order), not from
  the feed head read at reconnect time; `catchup` walks a page and persists its
  `next_cursor`.
- **Stream health is part of the result.** A clean server close, a decode
  failure, or an `event_epoch` change fails the run: each means the seq-based
  evidence no longer proves what the step claims.
- **Catch-up is checked before gap repair.** Reconnect evidence counts the
  durable events after the last live seq independently, then the probe rebuilds
  state from live + catch-up, and only afterwards refetches a missing seq. The
  refetch is reported separately so it cannot make a failed catch-up look
  healthy.
- **A seq gap is treated as a drop, not as progress.** The probe compares event
  seq continuity and refetches from the first hole; the contract gives no
  in-band signal that a frame was missed.
