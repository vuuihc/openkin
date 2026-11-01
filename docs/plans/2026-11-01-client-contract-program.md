# Client-contract and desktop-footprint program

Status: active
Started: 2026-11-01
Coordinator: the session that created this file

**North star:** an independent client can implement the P0 loop from public
documentation alone in **≤2 working days, with 0 server changes**.

If this file is the only thing you read: the goal is not a native rewrite. The
goal is to prove the daemon API is client-agnostic, fix the contract gaps that
block an independent client, and decide the desktop-shell question with
measurements instead of opinion.

## Why this program exists

- `lody-mygo` reimplemented Lody's desktop client in ~19 hours / 113k Go LOC by
  reusing Lody Cloud, the Lody CLI/daemon, and published protocols; 70k of those
  lines were UI. The client was replaceable. The runtime was not.
- OpenKin's desktop (Electron), mobile (Capacitor), and browser surfaces all run
  the same React app (`ui/`). The daemon API has never been exercised by a
  non-React client, so UI assumptions can hide in the contract.
- The contract exists (`api/openapi.yaml`, 70 paths) but has no
  `securitySchemes`, no router/client coverage check, and no measured
  independent-client cost.
- The desktop shell is Electron. Measure it before deciding whether that is a
  problem; do not rewrite 88.7k LOC of UI on vibes.

## Non-goals

- No native UI rewrite, no MyGo, no CRDT migration.
- No product behavior changes. Contract, spec, docs, scripts, and the probe only.
- No public API breaks; additive evolution only.
- No git push, no release, no `desktop-rebuild.sh`.

## Workstreams

### W1 — Contract coverage and auth (1.5 days)

Owner: W1 session.

Deliverables:

- `scripts/check-api-coverage.sh`: routes registered by `internal/api` versus
  `api/openapi.yaml`; paths used by `ui/src/api`, `desktop/src`, and `mobile/`
  versus the spec. Wired into `scripts/check.sh`.
- `api/openapi.yaml`: `securitySchemes` plus the actual auth flows (device
  pairing, device token, cookie/relay), verified against the handlers.
- Missing P0 paths/schemas fixed: session list with `updated_since`,
  `/api/events` SSE, `/api/sessions/wait`, task detail, prompt, approvals,
  questions.
- Report: `docs/plans/2026-11-01-client-contract/W1-report.md`.

Acceptance: the coverage script exits 0; every client-used endpoint is
documented; `scripts/check-openapi.sh` and the relevant
`go test ./internal/api/...` pass; no runtime behavior changes.

### W2 — Cold-start probe, baseline (2 days)

Owner: W2 session.

Protocol answers may come only from `api/openapi.yaml`, `docs/adr/0022-*`,
`docs/adr/0024-*`, and `README.md`. **Do not read `internal/`, `ui/src/`,
`desktop/src/`, or `mobile/` for protocol behavior.** Log every time you are
tempted or forced to do so; each is a finding.

Deliverable: `probe/kin-probe/` (Go, standard library) and
`docs/plans/2026-11-01-client-contract/W2-baseline-report.md`.

Acceptance script:

1. pair/login through the documented flow;
2. list sessions and capture the cursor;
3. open a session and receive live events;
4. send a prompt and see streaming text;
5. receive and approve a permission request;
6. disconnect, reconnect, catch up from the cursor, and match state.

Record: elapsed hours, LOC, undocumented behaviors (numbered), source-read
violations, server changes required (must be 0), and client RSS.

Acceptance: the script passes within 2 days, or the report explains exactly
where it stopped. The probe does not modify the server. A server bug is a
finding, not a fix.

### W3 — Desktop footprint baseline (4 hours)

Owner: W3 session.

Deliverable: `scripts/measure-desktop.sh` and
`docs/plans/2026-11-01-client-contract/W3-footprint-report.md`.

Scenarios: idle; one long session open; after a task runs; 60-minute soak. Five
runs where feasible; report median, p95, and variance. Electron process tree and
the `kin` daemon measured separately. Startup to interactive if measurable.

Pre-registered decision rule: an idle Electron tree above 400 MB, or growth
above 100 MB/hour, means evaluate a light shell; otherwise no rewrite.

Constraints: do not restart the live `:7777` daemon, do not run
`desktop-rebuild.sh`, and do not kill applications you did not start.

### W4 — Cold-start re-run (1 day, after W1 lands)

Owner: a fresh W4 session with the same brief as W2, branched from updated
`main`. Purpose: measure the delta. Success: ≤2 days, 0 server changes, ≤3
undocumented behaviors.

### W5 — Integration and decision (coordinator)

Merge W1/W2/W3 branches, run the applicable checks, launch W4, compare W2
versus W4, and write the final Chinese digest.

## Timeline

| Day | Work |
| --- | --- |
| 0 (11-01) | Plan and launch W1/W2/W3 |
| 1–2 | Parallel execution |
| 3 | Integrate W1; launch W4; review W3 |
| 4 | Compare W2/W4; final report |

## Reporting

- Each workstream writes its own report file and commits it in its own
  worktree. **Do not edit this master file.**
- The coordinator updates the status table and reports to the user in Chinese.
- If blocked after two honest attempts, write the blocker and stop; do not
  widen scope.

## Status

| Workstream | Owner | Branch | Status | Report |
| --- | --- | --- | --- | --- |
| W1 | W1 session | `lody/w1-client-contract-api` | running | `W1-report.md` |
| W2 | W2 session | `probe/client-contract-w2` | running | `W2-baseline-report.md` |
| W3 | W3 session | `w3-desktop-footprint` | running | `W3-footprint-report.md` |
| W4 | — | — | waiting on W1 | `W4-report.md` |

## Safety

- Work only in your own worktree. No push. No destructive commands. No secret
  printing. No changes outside the repository.
- Do not change agent execution semantics or product behavior.
- Treat the live daemon as the user's data: use dedicated test sessions named
  `probe-*`; clean up where possible.
