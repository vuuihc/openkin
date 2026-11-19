# Startup baseline — 2026-11-19

**Status: measured and attributed; the first shell-side fix is recorded below.** The
daemon's wall clock decomposes into named segments that add up, `store-open`
has been measured against a synthetic database at the live file size, and the
desktop shell has an isolated spawn → daemon-ready → first-paint number
measured without touching the live node. The shell-side instrumentation and
its runner are on `main` (`scripts/desktop-startup.sh`). The 2026-11-19
numbers below are the baseline the first fix is measured against and are left
as measured; §「2026-11-20 — the startup handshake」 records the before/after.

## Current position (现在的位置)

| Item | State |
|---|---|
| Startup phase trace (`KIN_STARTUP_TRACE=1`) | green — 6 unit tests (3 new); `--selftest` emitted 12 phase lines, each once |
| Whole-wall attribution (`process`, `ready→health`) | green — segments sum to the wall clock within 4–5 ms (flooring only) |
| Empty-DB baseline, 3 runs | green — table 1 below |
| Real-size `store-open` (150.7 MiB synthetic) | green — 38ms cold / 37ms warm, file at 99.1% of target |
| Desktop shell measurement (Electron spawn → first paint) | instrumented — env-isolated daemon + 8 trace marks; first paint 3726 / 1828 ms (median **2777 ms**) on 2026-11-19, measured with `scripts/desktop-startup.sh` |
| Shell handshake `sidecar-start` → `sidecar-ready` | measured 2026-11-20 — median **915 ms before**, **595 ms after**; see §「2026-11-20 — the startup handshake」 |
| Fix | daemon untouched; the shell's pre-daemon work fixed 2026-11-20 (see that section) |
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

The runner `scripts/desktop-startup.sh` builds `./kin` (gitignored build
output) and `desktop/dist`, then launches the real Electron shell once per run
(twice with `--runs 2`). Each run gets `mktemp`
state and userData directories and a freshly reserved port, exported as
`KIN_STATE_DIR`, `KIN_DESKTOP_USER_DATA` and `KIN_PORT` — the same two
variables `kin serve` already reads, which the shell now resolves
instead of hardcoding `~/.kin` and `:7777`. The shell emits
`[kin-desktop] trace <name> <ms>` lines (`desktop/src/startup-trace.ts`, same
switch and origin plausibility rule as the daemon), so one launch is attributed
from spawn to window paint. The table below was measured with that runner.

| Mark | Run 1 | Run 2 | Median |
|---|---:|---:|---:|
| `process` (spawn → main.ts) | 855 ms | 283 ms | 569 ms |
| `app-ready` | 1094 ms | 430 ms | 762 ms |
| `sidecar-start` | 1282 ms | 547 ms | 914 ms |
| `sidecar-ready` | 3289 ms | 1642 ms | 2466 ms |
| `window-created` | 3442 ms | 1694 ms | 2568 ms |
| `window-ready-to-show` | 3726 ms | 1828 ms | **2777 ms** |
| `window-shown` | 3738 ms | 1848 ms | 2793 ms |
| `window-first-load` | 3872 ms | 1828 ms | 2850 ms |
| **first paint** (`window-ready-to-show`) | 3726 ms | 1828 ms | **2777 ms** |
| **shell total** (last mark) | 3872 ms | 1848 ms | **2860 ms** |

Measured on macOS 27.2.1 arm64 at load average `38.41 23.54 13.37` (other
lanes run on this machine). Run 1 was the first launch of the invocation and
run 2 reused the caches it warmed, which is most of the `process` difference;
an earlier invocation whose first launch did follow the build showed the same
pattern more strongly (`process` 2932 ms, then 996 ms). `window-first-load`
can arrive a millisecond or two before `ready-to-show`, so shell total is the
last mark, not a named one.

The result is **daemon-gated**, as `main.ts` implies: `mainWindow.show("/")`
runs only after `sidecar.ensureRunning()` resolves. From the medians,
`sidecar-start` → `sidecar-ready` is **1552 ms**, larger than the daemon's own
407–440 ms to healthy in table 1: the shell also spawns `kin supervise` (which
starts `kin serve`), probes the binary version, and polls health every 250 ms
on a heavily loaded machine. First paint lands **311 ms** after
`sidecar-ready` (window creation plus URL load). The other edges are Electron's
own init (spawn → `app-ready`, 762 ms median) and the 209 ms from
`window-created` to first paint.

What this does **not** measure: renderer parse/script time beyond
`did-finish-load` (no CDP first-contentful-paint), the packaged `.dmg`/asar
build (this is the dev shell), a purged disk cache, or SPA hydration after the
load event.

The marks can be read from any launch with `KIN_STARTUP_TRACE=1`: one
`[kin-desktop] trace <name> <ms>` line per mark on stdout.
`./scripts/desktop-startup.sh --runs N --json` does that against a throwaway
daemon and reports the per-mark table and medians.

Runner safety: every run uses `mktemp` directories and a reserved port; a
state directory under `$HOME/.kin` is refused before anything is opened. The
script kills only the Electron process group it started and the daemon that
answered on its own reserved port. If Electron cannot launch (no GUI session),
it prints `SKIP: <reason>` and exits 2 rather than inventing a number.

## 2026-11-20 — the startup handshake

**Status: green.** `desktop/src/daemon-handshake.ts` now owns the shell's first
conversation with the daemon, and the preparatory work no longer sits in front
of the health probe:

- health is the first question (one loopback GET);
- `kin version` starts beside it and is awaited only where its label is used,
  bounded at 250 ms after health answers;
- a spawned daemon is polled every **50 ms**, not 250 ms, so the readiness edge
  is the daemon's boot plus at most one poll;
- `/api/version` starts the moment health answers, also bounded by the label
  wait;
- the rival-daemon wait (`daemon-rival.ts`) is unchanged: a kin process already
  on the machine gets its chance before a second daemon is spawned, and a
  stuck one still means `unavailable`.

`desktop/src/main.ts` is untouched: the window still shows only after
`ensureRunning()` resolves. This section shortens the handshake; showing the
window before that resolution is a separate delivery.

### Before / after

Same invocation on this machine: `./scripts/desktop-startup.sh --runs 3
--json`. "Before" is `46cebbf3` with the old handshake; "after" is the worktree
that added `daemon-handshake.ts`. Each invocation builds once and launches the
real shell three times against a throwaway daemon.

| Mark | Before median | After median |
|---|---:|---:|
| `process` | 219 ms | 222 ms |
| `app-ready` | 295 ms | 295 ms |
| `sidecar-start` | 373 ms | 362 ms |
| `sidecar-ready` | 1288 ms | 957 ms |
| **handshake edge** (`sidecar-ready − sidecar-start`) | **915 ms** | **595 ms** |
| `window-created` | 1349 ms | 1010 ms |
| first paint (`window-ready-to-show`) | 1524 ms | 1171 ms |
| shell total (last mark) | 1538 ms | 1186 ms |

Per-run handshake edge — before: `2177, 915, 591` ms; after: `1312, 542, 595`
ms. Run 1 of each invocation pays cold caches (the first launch of a fresh
build); it is kept in the median rather than discarded.

Load average (`uptime`) — before, around the invocation: `7.35 6.23 6.33` →
`7.46 6.48 6.41`; after: `6.35 6.39 6.39` → `14.94 8.79 7.27` (other lanes
share this machine, and the after run's builds landed on it). The medians are
reported as measured, not normalised; the two warm runs after the change are
542 and 595 ms.

Reading: the shell's pre-daemon steps no longer dominate the edge. What remains
is the spawned daemon's own boot (407 ms cold in table 1, measured on a
quieter machine), at most one 50 ms poll, and one loopback `/api/version`
round trip. This runner does not trace inside the daemon, so the 595 ms is not
split further here — `scripts/startup-baseline.sh` is the instrument for that
half. The 2026-11-19 desktop numbers above are left as measured; they were
taken on a different load average and are the baseline this section is
compared against, not a prediction.

Red/green: `desktop/src/daemon-handshake.test.ts` (12 tests, including order,
cadence, cancellation, and never-settling labels);
`./scripts/mutants.py desktop/src/daemon-handshake.mutants.json` restores the
old order (`await expected` before the first probe) and the order test fails
(`not ok 1 - probes health before it runs the version binary`), then restores
the module byte for byte.

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
