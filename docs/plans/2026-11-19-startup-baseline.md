# Startup baseline — 2026-11-19

**Status: measured.** This document is the number and the phase attribution that
the next slice fixes against. It does not claim, and this slice did not attempt,
a speed-up.

## Current position (现在的位置)

| Item | State |
|---|---|
| Startup phase trace (`KIN_STARTUP_TRACE=1`) | green — 3 unit tests; `--selftest` emitted 11 phase lines, each once |
| Cold/warm baseline, 3 runs | green — table below |
| Dominant instrumented phase | `engine-build`: 189ms cold / 175ms warm |
| Desktop shell measurement | skipped: no desktop bundle in this worktree |
| Live-machine data scale (158 MB DB) | not reproduced — throwaway DB is empty |
| Fix | not attempted, intentionally |

## What was measured

`./scripts/startup-baseline.sh --runs 3`, which builds `./kin`, boots it three
times on fresh `mktemp` state directories (cold) and three times again on the
same directory (warm), polls `/api/health` every 50 ms, and kills each instance
with SIGKILL so shutdown is never counted as startup.

| Fact | Value |
|---|---|
| Build | `283e70ba` on `rsi/startup-baseline` (worktree, uncommitted instrumented build) |
| OS | macOS 27.2.1 |
| CPUs | 8 |
| Load average, before → after | `5.74 7.44 7.91` → `5.17 7.26 7.85` (other lanes run on this machine) |
| Network | loopback only; no Hub role, no relay configured |
| Throwaway DB | 692,224 bytes, checkpointed |
| Throwaway rows | sessions 0, tasks 0, routines 0, devices 1 (the daemon's own row) |

| Phase | Cold median | Warm median |
|---|---:|---:|
| `state-dir` | 0ms | 0ms |
| `lock` | 0ms | 0ms |
| `store-open` | 11ms | 2ms |
| `device` | 0ms | 0ms |
| `adopt` | 0ms | 0ms |
| `agents` | 0ms | 0ms |
| `engine-build` | 189ms | 175ms |
| `engine-start` | 0ms | 0ms |
| `browser` | 0ms | 0ms |
| `listen` | 1ms | 1ms |
| `ready` | 0ms | 0ms |
| **total-to-healthy** | **417ms** | **323ms** |

Per-run total-to-healthy: cold `1121, 417, 329` ms; warm `319, 330, 323` ms.
Cold run 1 is an outlier from the freshly built binary's first execution (page
cache and first-launch work); it is kept in the median rather than discarded,
which is why the cold median (417 ms) is the middle run and not the fastest.

The trace begins at `ServeWith` entry, so it does not cover process exec, dyld,
Go runtime init or flag parsing before the first mark, nor the gap from the
`ready` mark to the script's first successful health response (up to one 50 ms
poll plus the HTTP round trip). Those gaps are visible in the table: the
instrumented phases sum to 201 ms cold and 178 ms warm, while the totals are
417 ms and 323 ms.

## Scale not reproduced

The live daemon's database is `stat -f%z ~/.kin/kin.db` = **157,986,816 bytes
(150.7 MiB)**. The baseline above uses an empty 692 KB database, so its
`store-open` (11 ms cold / 2 ms warm) says nothing about a database 228× larger.
Measuring that is the next slice's job; this one deliberately does not copy,
open, or instrument the live database.

## Dominant phase

`engine-build` is the dominant instrumented phase: **189 ms cold and 175 ms
warm — 45% and 54% of median total-to-healthy**, and 94% / 98% of the
instrumented span. Everything the daemon does between `state-dir` and `ready`
apart from engine construction is noise by comparison (next largest:
`store-open`, 11 ms cold). The other half of the wall clock is outside the
instrumented span — process launch and runtime init before the first mark, and
the final health answer after `ready` — so the next slice should instrument
those two edges before optimising `engine-build` itself.

## Desktop

`skipped: no desktop bundle in this worktree` (`desktop/dist/main.js` does not
exist). No bundle was built for this measurement.

## Reproduce

```bash
./scripts/startup-baseline.sh --runs 3        # the table above
./scripts/startup-baseline.sh --selftest      # red/green: all 11 phase lines
./scripts/startup-baseline.sh --runs 3 --json # machine-readable form
```

The script boots throwaway instances only: `mktemp` state directory,
`KIN_STATE_DIR`, and a freshly reserved `KIN_PORT`. It never contacts or
restarts a live daemon.
