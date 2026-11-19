# Engine-build — 2026-11-20

**Status: measured, cut, green.** On an empty database the daemon's
`engine-build` span fell from a **188 ms cold / 190 ms warm** median (same
machine and invocation as the after run; the 2026-11-19 baseline records
207 / 226 ms at a different load) to **0 ms cold / 0 ms warm** — every
sub-mark inside the span floors at 0 ms, i.e. each is under one millisecond.
Total-to-healthy moved **458 / 382 ms → 242 / 201 ms** in the same-session
before/after. The cut is two changes: `Registry.List` probes registrations
with a bounded fan-out, and the boot no longer calls `List` at all, because
its only boot-time use was printing readiness and one provider's model
discovery execs its binary for ~182 ms.

## Current position (现在的位置)

| Item | State |
|---|---|
| Attribution sub-marks (`engine-routing`, `engine-catalog`, `engine-workspace`, `engine-notifier`, `engine-configure`) | green — `--selftest` emitted 17 phase lines, each once |
| Concurrent `Registry.List` + behaviour pin | green — `TestListProbesRegistrationsConcurrently`, `TestListMatchesSequentialOrder` |
| Probe panic containment | green — `TestListSurvivesAProbePanic` |
| Boot prints readiness without model discovery | green — `engine-build` span 0 ms cold / 0 ms warm |
| Same-session before/after | green — tables 1 and 3 below |
| `go test -race ./internal/agent/... ./internal/server/...` | green — 124 tests, 2 packages |
| `./scripts/check.sh` | green — all 18 checks |
| Desktop shell / UI | untouched; no rendered change |

## What was measured

```bash
bash scripts/startup-baseline.sh --runs 3
```

The script builds `./kin`, boots it three times on fresh `mktemp` state
directories (cold) and three times again on the same directory (warm), polls
`/api/health` every 50 ms, and SIGKILLs each instance. It never touches a real
state directory or the live node.

Machine: macOS, arm64, 8 CPUs, load shared with other lanes. The load average
is sampled immediately before and after each invocation and quoted with its
table. Per-run totals are listed under each table; the first cold run of an
invocation pays first-execution cost and is kept in the median rather than
discarded. Every row floors to whole milliseconds, and `ready→health` is
quantised by the 50 ms poll, so it is a bound on the wait, not an exact
duration.

### Table 1 — before (`b47032f1`, parent commit)

Load average `7.93 8.35 7.23` → `9.60 8.73 7.39`.

| Phase | Cold median | Warm median |
|---|---:|---:|
| `process` | 98ms | 96ms |
| `state-dir` | 0ms | 0ms |
| `lock` | 0ms | 0ms |
| `store-open` | 12ms | 2ms |
| `device` | 0ms | 0ms |
| `adopt` | 0ms | 0ms |
| `agents` | 0ms | 0ms |
| `engine-build` | **188ms** | **190ms** |
| `engine-start` | 0ms | 0ms |
| `browser` | 0ms | 0ms |
| `listen` | 1ms | 1ms |
| `ready` | 0ms | 0ms |
| `ready→health` | 77ms | 90ms |
| **total-to-healthy** | **458ms** | **382ms** |

Per-run totals: cold `1318, 458, 376` ms; warm `487, 348, 382` ms.
`docs/plans/2026-11-19-startup-baseline.md` records 207 / 226 ms for this
phase and 407 / 400 ms to healthy at a different load average; those are the
historical baseline, not this run's numbers.

### Table 2 — after (this branch)

Load average `5.91 6.80 6.85` → `6.24 6.85 6.87`.

| Phase | Cold median | Warm median |
|---|---:|---:|
| `process` | 108ms | 94ms |
| `state-dir` | 0ms | 0ms |
| `lock` | 0ms | 0ms |
| `store-open` | 12ms | 2ms |
| `device` | 0ms | 0ms |
| `adopt` | 0ms | 0ms |
| `agents` | 0ms | 0ms |
| `engine-routing` | 0ms | 0ms |
| `engine-catalog` | 0ms | 0ms |
| `engine-workspace` | 0ms | 0ms |
| `engine-notifier` | 0ms | 0ms |
| `engine-configure` | 0ms | 0ms |
| `engine-build` | 0ms | 0ms |
| `engine-start` | 0ms | 0ms |
| `browser` | 0ms | 0ms |
| `listen` | 1ms | 1ms |
| `ready` | 0ms | 0ms |
| `ready→health` | 130ms | 101ms |
| **total-to-healthy** | **242ms** | **201ms** |

Per-run totals: cold `890, 242, 169` ms; warm `225, 201, 171` ms.
**`engine-build` span** (the sum of the six `engine-*` rows) is **0 ms cold /
0 ms warm**: each sub-mark is below the trace's one-millisecond resolution.
That is the ≥ 40 % target (124 ms) met with the measurement's full resolution
to spare, not a modelled number.

### Table 3 — the fan-out alone (intermediate commit state)

The concurrency change landed before the boot-path cut, and was measured with
the same invocation: load average `7.78 7.33 7.03` → `7.58 7.30 7.02`.

| Phase | Cold median | Warm median |
|---|---:|---:|
| `engine-catalog` (the old `engine-build` work) | 208ms | 189ms |
| `engine-build` residual | 0ms | 0ms |
| **total-to-healthy** | **394ms** | **432ms** |

Per-run totals: cold `1021, 340, 394` ms; warm `432, 462, 382` ms. The phase
did not move (208 / 189 vs 188 / 190), so the fan-out alone was not the cut.
That run is what sent the attribution one level deeper.

## Attribution: the 188 ms was one model probe

A throwaway test built the real registry with `buildAgentRegistry` against an
empty `store.Open` database and timed each registration's `Status` and
`Models` separately (removed before commit: a wall-clock assertion on a shared
machine is a flaky test, and the script above is the reproducible check). On
this machine the registry has 15 rows; the discovery catalog lists 74 specs,
but only the ones with a generic invocation become factories.

| Registration | `Status` | `Models` |
|---|---:|---:|
| `droid` | 17µs | **181.895ms** |
| `claude-code` | 97µs | 1.005ms |
| `kin` | 127µs | 15µs |
| `gemini-cli` | 204µs | — (no model probe) |
| all other 11 rows | ≤ 54µs | ≤ 0µs |
| `Default(ctx, "")` | 177.541µs total | |
| `List` after droid's cache is warm | 1.181ms for 15 rows | |

`droid`'s model discovery runs its own binary on a cache miss
(`internal/adapter/droid/models.go`, 10-minute TTL), and a fresh daemon has no
cache. Every other probe is sub-millisecond. The boot was paying ~182 ms for
metadata it never read: the `reg.List` call at `internal/server/server.go:329`
only fed a readiness print loop (`Available`, `Binary`, `Reason`).

## What changed

1. **`internal/agent/registry.go` — `List` probes with a bounded fan-out.**
   One goroutine per registration under a 16-slot semaphore; results are
   written by index (`out[i]`), so order, every `Info` field, and the `Default`
   flag match the sequential implementation. Each probe recovers its own
   panic: a buggy adapter row comes back unavailable with the panic as its
   reason instead of ending the daemon, which is what an unrecovered panic in
   a goroutine would do. Nothing is cached: `List` still answers `/api/agents`
   by probing, so a binary installed while the daemon runs appears on the next
   request. `sync` only; no dependency change.
2. **`internal/server/server.go` — boot asks for readiness, not models.** The
   boot loop now walks `reg.IDs()`, gets each registration, and calls `Status`;
   the printed lines are byte-identical to the ones `List` produced because the
   loop only ever read `Available`, `Binary`, and `Reason`. `/api/agents` keeps
   calling `List` and gets the full answer on demand.
3. **Attribution sub-marks** inside the span: `engine-routing` (after
   `routing.NewCatalog`), `engine-catalog` (after the readiness loop),
   `engine-workspace` (settings + `workspace.NewManager`), `engine-notifier`
   (APNs client from settings), `engine-configure` (`task.NewConfiguredEngine`).
   Every pre-existing mark is still emitted; `engine-build` now reads ~0 ms
   because the work that used to land in it is attributed to the new
   sub-marks.
4. **`scripts/startup-baseline.sh`** requires the new marks exactly once and
   reports `17 phase lines`.

## Red/green

- `TestListProbesRegistrationsConcurrently` — 74 fakes, every `Status` and
  `Models` sleeps 3 ms. Against the pre-concurrency implementation:
  `List probed 74 registrations serially: 692.612ms (want < 200ms; 74 × 3ms
  for Status + Models is ~444ms sequential)`. The bound was first set to
  60 ms; ten runs under `GOMAXPROCS=2` (the setting `scripts/check.sh` uses)
  produced 60.9 ms and 64.5 ms, so it was raised to 200 ms — still 2.2× below
  the sequential floor and ~3× above the measured concurrent range (40–65 ms).
- `TestListMatchesSequentialOrder` — 24 registrations with colliding
  priorities and distinguishable fields; asserts the concurrent `List` equals
  the sequential reference row for row (`reflect.DeepEqual`), and that the
  returned `Models` slice is a copy of the plugin's own slice. Passes on both
  sides of the change.
- `TestListSurvivesAProbePanic` — a panicking `Status` and a panicking
  `Models` each cost their own row (unavailable, reason `probe panicked: …`)
  and leave order and the healthy row intact.
- `go test -race ./internal/agent/... ./internal/server/...` — 124 tests, green.
- `bash scripts/startup-baseline.sh --selftest` —
  `ok startup-baseline selftest: 17 phase lines, each once, in a 878ms boot`.
- `./scripts/check.sh` — all 18 checks green.

## Residual risk and what is not measured

- **First `/api/agents` after boot pays droid's discovery (~182 ms)** and then
  serves from the 10-minute cache. That surface is on demand; the boot is not.
  This is a deliberate trade: the answer is unchanged, only its first-call
  latency moved off the boot path. The same cold cache applies to a Node's
  first `buildNodeHello → nodeAgents → reg.List` when it dials its Hub: it
  pays the discovery once, in `runNode`'s goroutine, which does not gate the
  `ready` mark. That cost is unmeasured here; it is bounded by the same
  10-minute cache.
- **Sub-millisecond resolution.** All `engine-*` rows report 0 ms because each
  is under 1 ms; the trace cannot say whether the span is 0.2 ms or 0.9 ms.
- **The registry on this machine has 15 rows**, not the catalog's 74. The
  concurrency test sizes itself to 74 as the upper bound a machine with every
  discovery entry installed could reach.
- **`ready→health`** is quantised by the 50 ms poll; the after medians
  (130 / 101 ms) are within that resolution and are not claimed as an
  improvement.
- **Load is shared.** Other lanes run on this machine; the before and after
  invocations were at comparable load (`7.9–9.6` vs `5.9–6.9` one-minute), and
  the medians are reported as measured rather than normalised.
- `/api/agents`, its JSON fields, and its capability filtering are unchanged.

## Reproduce

```bash
bash scripts/startup-baseline.sh --runs 3        # tables 1 and 2
bash scripts/startup-baseline.sh --selftest      # 17 phase lines, each once
bash scripts/startup-baseline.sh --runs 3 --json # machine-readable form
```

The script boots throwaway instances only: `mktemp` state directory,
`KIN_STATE_DIR`, and a freshly reserved `KIN_PORT`. It never contacts or
restarts a live daemon.
