# Startup baseline — 2026-11-19

**Status: measured and attributed.** The wall clock now decomposes into named
segments that add up, and `store-open` has been measured against a synthetic
database at the live file size. This slice is measurement only: it did not
attempt, and does not claim, a speed-up.

## Current position (现在的位置)

| Item | State |
|---|---|
| Startup phase trace (`KIN_STARTUP_TRACE=1`) | green — 6 unit tests (3 new); `--selftest` emitted 12 phase lines, each once |
| Whole-wall attribution (`process`, `ready→health`) | green — segments sum to the wall clock within 4–5 ms (flooring only) |
| Empty-DB baseline, 3 runs | green — table 1 below |
| Real-size `store-open` (150.7 MiB synthetic) | green — 38ms cold / 37ms warm, file at 99.1% of target |
| Desktop shell measurement (Electron spawn → first paint) | not in this slice (slice `-c`) |
| Fix | not attempted, intentionally |
| `~/.kin/kin.db` opened, copied or instrumented | **never** |

## What was measured

`./scripts/startup-baseline.sh --runs 3` builds `./kin`, boots it three times on
fresh `mktemp` state directories (cold) and three times again on the same
directory (warm), polls `/api/health` every 50 ms, and kills each instance with
SIGKILL so shutdown is never counted as startup. The script hands the daemon
its true spawn instant (`KIN_STARTUP_ORIGIN_MS`), so `process` covers exec,
dyld, Go runtime init and flag parsing before `ServeWith`; `ready→health` is
derived as `wall − ready total` and covers the poll plus the HTTP round trip.

| Fact | Value |
|---|---|
| Build | worktree at `301d345f` on `rsi/startup-attribution` (uncommitted instrumented build) |
| OS | macOS 27.2.1, arm64 |
| CPUs | 8 |
| Load average, sampled after the runs | `6.70 6.70 5.44` (other lanes run on this machine) |
| Network | loopback only; no Hub role, no relay configured |
| Throwaway DB, empty run | 692,224 bytes, checkpointed |
| Throwaway rows, empty run | sessions 0, tasks 0, routines 0, devices 1 (the daemon's own row) |

### Table 1 — empty database

| Phase | Cold median | Warm median |
|---|---:|---:|
| `process` | 116ms | 113ms |
| `state-dir` | 0ms | 0ms |
| `lock` | 0ms | 0ms |
| `store-open` | 15ms | 3ms |
| `device` | 0ms | 0ms |
| `adopt` | 0ms | 0ms |
| `agents` | 0ms | 0ms |
| `engine-build` | 207ms | 226ms |
| `engine-start` | 1ms | 0ms |
| `browser` | 0ms | 0ms |
| `listen` | 2ms | 1ms |
| `ready` | 0ms | 0ms |
| `ready→health` | 67ms | 47ms |
| **total-to-healthy** | **407ms** | **400ms** |

Per-run total-to-healthy: cold `1426, 406, 407` ms; warm `395, 403, 400` ms.
Cold run 1 is the freshly built binary's first execution and is kept in the
median rather than discarded. Per run, the rows sum to the wall clock within
**4 ms** (whole-millisecond flooring). `ready→health` is quantised by the 50 ms
poll, so it is a bound on the wait, not an exact duration.

### Table 2 — synthetic database at the live file size

`./scripts/startup-baseline.sh --db-fixture-size 157986816 --runs 3`. Each run
creates a fresh throwaway directory, boots the daemon once so its own
migrations create the schema, SIGKILLs it, seeds synthetic rows until the file
is within 2 % of the target, then runs one cold boot (first boot on that
directory) and one warm boot (reboot on the same directory).

| Fact | Value |
|---|---|
| Target size | 157,986,816 bytes (150.7 MiB, the live file size recorded in #367) |
| Seeded size | 156,487,680 bytes (99.1 % of target, inside ±2 %) |
| Seeded rows | 400 tasks, 3,000 agent sessions, 33,011 events |
| Fixture boot included in table? | no — the seeding boot is setup, not a measurement |

| Phase | Seeded cold median | Seeded warm median |
|---|---:|---:|
| `process` | 110ms | 111ms |
| `state-dir` | 0ms | 0ms |
| `lock` | 0ms | 0ms |
| `store-open` | **38ms** | **37ms** |
| `device` | 0ms | 0ms |
| `adopt` | 0ms | 0ms |
| `agents` | 0ms | 0ms |
| `engine-build` | 201ms | 199ms |
| `engine-start` | 13ms | 13ms |
| `browser` | 0ms | 0ms |
| `listen` | 1ms | 1ms |
| `ready` | 0ms | 0ms |
| `ready→health` | 74ms | 122ms |
| **total-to-healthy** | **440ms** | **487ms** |

Per-run total-to-healthy: seeded cold `457, 440, 406` ms; seeded warm
`487, 506, 417` ms. The same invocation also re-ran the empty baseline:
total `440 / 420` ms, `store-open` `15 / 3` ms, `process` `110 / 111` ms —
consistent with table 1, so the two tables are comparable.

At this scale `store-open` grows from 15/3 ms to **38/37 ms** (+23 ms cold,
+34 ms warm), and `engine-start` shows a new 13 ms that the empty database does
not. Everything else inside the boot stays at its empty-DB cost. The
total-to-healthy difference between the seeded and empty columns is inside
run-to-run noise on this loaded machine (seeded warm is slower than seeded cold
in the same runs), so no total-level claim is made beyond the two phases that
moved consistently.

### What the fixture inflates, and what it does not reproduce

The store's schema is embedded in `internal/store/migrate.go`; there is no
`internal/store/migrations/` directory in this tree. The fixture inflates
**`tasks`**, **`events`** (4 KB payloads across the transcript event types),
and **`agent_sessions`**, and writes `transcript_index_state` watermarks ahead
of every synthetic event so opening the file measures the open path rather than
a transcript-index backfill. The distribution is **synthetic** and is not the
live row distribution.

It also does not reproduce: the live mix of row sizes and tables, the live
daemon's WAL state (the fixture checkpoints and truncates its WAL so `stat`
reflects the seeded size), page-cache warmth (the file was just written by the
seeding process, so even the "cold" boot has a warm kernel cache), or real
transcript-index contents.

**`~/.kin/kin.db` was never opened, copied, `stat`-ed for copying, or
instrumented.** Every number above comes from `mktemp` state directories built
from scratch; the script refuses any state directory under `$HOME/.kin` before
it boots anything.

## Attribution: where the wall clock goes

The previous baseline left 216 ms of the 417 ms cold start attributed to
nothing. That gap splits into two measured segments:

- `process` — **116 ms cold / 113 ms warm** from exec to `ServeWith` entry:
  process creation, dyld, Go runtime init and flag parsing. This is the larger
  previously invisible edge.
- `ready→health` — **67 ms cold / 47 ms warm** from the `ready` mark to the
  script's first successful health answer, quantised by the 50 ms poll.

The named boot phases in between stay where they were: `engine-build` remains
dominant at **207 ms cold / 226 ms warm**, untouched by this slice. It is still
the phase to optimise first, but it is no longer the only large number — the
pre-`ServeWith` launch cost is the same order of magnitude and must be counted
in any end-to-end explanation of 「启动巨慢」.

## Desktop

Not in this slice. Measuring Electron spawn → window → first console paint is
the `-c` remainder, and it is blocked on how the desktop shell boots an
isolated daemon (the shell currently attaches to the live `:7777` node, so a
measurement run needs a separate binary/state/port without disturbing it).

## Reproduce

```bash
./scripts/startup-baseline.sh --runs 3                          # table 1
./scripts/startup-baseline.sh --db-fixture-size 157986816 --runs 3  # table 2
./scripts/startup-baseline.sh --selftest                        # red/green: 12 phase lines
./scripts/startup-baseline.sh --selftest --db-fixture-size 157986816
./scripts/startup-baseline.sh --runs 3 --json                   # machine-readable form
```

The script boots throwaway instances only: `mktemp` state directory,
`KIN_STATE_DIR`, and a freshly reserved `KIN_PORT`. It never contacts or
restarts a live daemon.
