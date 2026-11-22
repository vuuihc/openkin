# Switch latency — the first measured cost of an F4 switch

**Status: measured and attributed.** Three switch legs were timed on a
throwaway daemon at `71f1d77b`, 10 runs each after one discarded warm-up. No
product change was made: this document is the baseline the next switch phase
opens from. At `e2c96089` the same script also splits the area leg on the page
clock: 10/10 runs attributed, and the render after the answer owns nearly all
of the time (table 2).

**The area leg moved; the numbers below did not.** `mac-area-to-area` used to
switch conversations → projects. Projects retired with its collection
(`ui/src/lib/areas.ts` now lists only conversations, routines, settings), so the
leg was re-pointed in place at conversations → routines. Every number in this
document was measured on the old conversations → projects leg; it is kept as
history and labelled **retired leg**, and the new leg's baseline is whatever
`switch-latency.mjs` prints now.

## Current position (现在的位置)

| Item | State |
|---|---|
| `rsi/runtime/ux/switch-latency.mjs` | green — boots, seeds, times three legs; `node --check` passes |
| `mac-area-to-area` leg | re-pointed to conversations → routines; Projects retired with its collection, so the numbers below are the **retired leg**'s and are not comparable with the new leg's |
| Real end-to-end run (10 runs/leg) | green — table 1 below; JSON at `rsi/state/switch-latency/switch-latency.json` |
| Attribution split (`mac-area-to-area`) | green — 10/10 runs attributed at `e2c96089` on the retired leg; table 2 below |
| Hermetic attribution test | green — `rsi/runtime/tests/test-switch-attribution.sh`, 6 cases, wired into `check.sh` |
| Guard (a) `--break-target` | green — exit 2, `GUARD (a) destination-never-appeared` |
| Guard (b) `--break-shell` | green — exit 2, `GUARD (b) shell-rebuilt` |
| Guard (c) splash/blank/error | green — `--break-splash`, `--break-alert`, `--break-blank` each exit 2 with `GUARD (c) splash-blank-or-error` and their own detail |
| `--print <json>` claim check | green — prints the same p50/p90 as the run, plus the attribution lines |
| Product code changed | none — script, its hermetic test, and this document only |

## What was measured

**Click → the destination's own content on screen**, on the real console served
by a locally built `./kin`, in Google Chrome driven by Playwright-core.

The clock never includes Playwright's round trip. Before each press the script
installs a one-shot capture-phase `click` listener in the page that writes
`performance.now()` into `window.__switch.t0`; it then calls `locator.click()`.
When the destination selector is visible it reads `t1` in a
`requestAnimationFrame` callback on the same clock. Duration is `t1 − t0`.

Because `t1` is taken on the first frame after Playwright's visibility poll
resolves, every duration includes that poll's detection lag and at most one
frame (~16.7 ms). The numbers are therefore an upper bound on the paint, not a
lower bound.

### Legs (never averaged together)

| Leg | Viewport | Press | Destination (its own content) |
|---|---|---|---|
| `mac-chat-to-chat` | 1100x760 | `[data-session-row]:has-text('[seed] Failed migration')` | `[role=region][tabindex='-1']:has-text('[seed] fail: explain why the migration stopped.')` |
| `mac-area-to-area` | 1100x760 | `[data-area="routines"]` | `[data-area="routines"][aria-current="page"]` (the nav's own state) **and** `ul li:has-text('[seed] Morning check-in')` (the fetched routine row — the last selector is the content gate) |
| `phone-list-to-chat` | 390x844 | `[data-session-row]:has-text('[seed] Morning planning')` | `[role=region][tabindex='-1']:has-text('[seed] change: summarise the three things worth doing today.')` |

`mac-area-to-area` starts from the conversations area each run; the reset
(routines → conversations, waiting for the area to be current and the seeded
rows to be back) is not measured. The phone leg returns through the
app's own Back control (`header button[aria-label='返回'|'Back']`), never
`page.goto`, and waits for the list's `input[type=search]`; that return is not
measured either. `mac-chat-to-chat` resets by opening `[seed] Morning planning`
again, also unmeasured.

### Guards

A guard exits 2, records no number for any leg, and prints which guard fired:

- **(a) `destination-never-appeared`** — the destination's unique text never
  became visible, or it was already on screen before the press (a dead tap or a
  pre-rendered target must not yield a fast number).
- **(b) `shell-rebuilt`** — `#root .touch-lg` is not the same element before
  and after (marked with a property in the page and re-checked). A reload or
  remount is not a switch.
- **(c) `splash-blank-or-error`** — the boot splash is still on screen, `<main>`
  is blank, or a visible `[role=alert]` error surface is what the reader sees.

`--break-target` points every destination at `#never-appears`; `--break-shell`
reloads the page right after the press. `--break-splash`, `--break-alert` and
`--break-blank` inject the guard (c) failure after the press landed and its
destination appeared (so guards (a) and (b) cannot answer first): one visible
`#root .kin-boot`, one visible `[role=alert]`, or an emptied `<main>`. All five
are committed flags with a recorded run (see Reproduce).

Guard runs pass `--out "$(mktemp -d)"`: they write a guard JSON with no
numbers, and must never replace a real measurement file.

## Table 1 — measured 2026-11-20

The `mac-area-to-area` row here is the **retired leg** (conversations →
projects): these numbers are history, not the current leg's baseline.

Nearest-rank p50/p90: with 10 runs p50 is the 5th smallest and p90 the 9th; no
interpolation is invented. Every value below comes from
`rsi/state/switch-latency/switch-latency.json`, not from a hand-typed table.

| Leg | Viewport | p50 | p90 | min | max |
|---|---|---:|---:|---:|---:|
| `mac-chat-to-chat` | 1100x760 | 56.2 | 73.6 | 33.6 | 76.3 |
| `mac-area-to-area` | 1100x760 | 99.2 | 150.8 | 64.9 | 155 |
| `phone-list-to-chat` | 390x844 | 64.3 | 81.6 | 44.1 | 98.9 |

Per run, in order (ms):

| Leg | Runs |
|---|---|
| `mac-chat-to-chat` | 33.6, 71.6, 43.7, 49.1, 62.3, 73.6, 76.3, 73.5, 44.6, 56.2 |
| `mac-area-to-area` | 97.7, 64.9, 150.8, 84.4, 112.8, 112.7, 99.2, 155, 75.9, 112.8 |
| `phone-list-to-chat` | 46.6, 98.9, 44.1, 73.5, 54.1, 76.7, 81.6, 46.6, 64.3, 69.6 |

Discarded warm-up per leg: `166.3`, `78.9`, `131.1` ms. The warm-ups are kept
in the JSON and left out of the statistics: the first press after a cold render
pays work later presses do not, and that is not a switch cost.

The spread is wide: `mac-chat-to-chat` ranges 33.6–76.3 ms and
`mac-area-to-area` 64.9–155 ms, whose p90 is 1.5× its p50; the phone leg is
tighter at 44.1–98.9 ms. This run does not attribute the variance (a cached
task row, a faster fetch, or frame alignment would all look like this), and the
p50/p90 are reported as measured over the whole sample.

### Machine and build

| Fact | Value |
|---|---|
| Commit | `71f1d77b05c9e2efda887a79626e0611486af0db` (`origin/main`) |
| OS | macOS (Darwin) 27.2.0 arm64 |
| CPUs | 8 |
| Node | v22.23.4 |
| Load average (1m 5m 15m), before → after | `4.7 5.1 5.8` → `5.1 5.2 5.8` |
| Console | production Vite bundle from `cd ui && npm run build`; entry `/assets/index-DOj2fOK9.js` |
| Daemon | `./kin` built from this commit after that UI build, in a `mktemp` state dir on a free port |
| Seed | `scripts/journeys_seed.py`, fake agent pinned first (`scripts/journeys_fake_agent/claude`) |

The worktree's `web/dist/index.html` was unchanged by the build (same hashed
entry chunk), so nothing under `web/dist/` is part of this change.

## Table 2 — attribution, retired leg, 2026-11-20

**Retired leg.** Every number in this table was measured on conversations →
projects: the P12 cut took that retired leg to p50 61.9 / p90 66.0
(`rsi/GOAL.md`) and this table's earlier split was p50 81.6 / p90 135.9, so
neither is comparable with a number from the new conversations → routines leg —
the new baseline is whatever the command prints now.

`switch-latency.mjs` now splits a measured press on the page's clock. The
page's resource timeline is cleared before the press; after `t1` the first
resource entry whose path starts with the leg's `dataPath` and whose
`startTime` is at or after `t0` yields

- `dispatch = entry.startTime − t0` — press → the read starts (the route
  change and the skeleton mount are inside this),
- `read = entry.responseEnd − entry.startTime` — the fetch itself,
- `render = t1 − entry.responseEnd` — answer → the list on screen (this phase
  carries the same detection-lag/one-frame upper bound as the total).

A run with no matching entry, a negative phase, or phases that miss the total
by more than 2 ms is recorded as unattributed with its reason and excluded
from the split. `--print` then says `attributed n/N (k unmeasured)` and prints
no phase numbers over runs it did not measure.

| Fact | Value |
|---|---|
| Commit | `e2c96089865ea313d873c6bc25d79a5229cbf685` |
| OS | macOS (Darwin) 27.2.0 arm64 · 8 CPUs · node v22.23.4 |
| Load average (1m 5m 15m), before → after | `9.5 9.3 9.6` → `9.5 9.3 9.6` |
| Console | production Vite bundle; entry `/assets/index-ysi98Ugl.js` |
| Daemon | `./kin` built from this commit, in a `mktemp` state dir on a free port |
| Attributed runs | **10 / 10** — no run excluded |
| `mac-area-to-area` total this run (p50 / p90 / min / max) | 81.6 / 135.9 / 49.4 / 164.7 ms |

| Phase of `mac-area-to-area` | p50 | p90 | min | max |
|---|---:|---:|---:|---:|
| `dispatch` — press → `/api/projects` starts | 1.8 | 1.9 | 1.6 | 2.5 |
| `read` — `/api/projects?status=active` | 1.3 | 1.5 | 1.1 | 1.7 |
| `render` — answer → `[data-projects-list]` on screen | 78.6 | 133.1 | 46.2 | 160.9 |

Per run, in order (ms, dispatch / read / render):

| Run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `dispatch` | 1.9 | 1.9 | 1.9 | 1.8 | 1.6 | 1.7 | 1.8 | 2.5 | 1.7 | 1.6 |
| `read` | 1.3 | 1.1 | 1.1 | 1.4 | 1.2 | 1.5 | 1.3 | 1.3 | 1.3 | 1.7 |
| `render` | 48.5 | 78.6 | 47.6 | 46.2 | 133.1 | 96.3 | 86.8 | 160.9 | 54 | 118.4 |

The other two legs name no data path, so they record
`attributed 0/10 (no data read named for this leg)` and print no phase
numbers; this change attributes the area leg, the one whose destination owns a
collection read.

**What the split says.** At this commit the read is not the cost. Press → fetch
starts is under 3 ms and the fetch itself is ~1.3 ms on loopback against the
three-project seed. The render after the answer owns 78.6 of the 81.6 ms p50
and the whole tail: its p90 is 133.1 ms and its max 160.9 ms, against a read
that never passes 1.7 ms. The spread table 1 could not attribute is in
`render`, not in the read. This does not say *why* the render takes that long —
React work, layout, the frame boundary and the visibility poll all sit inside
`render` — only where the time sits. Each phase's percentile is nearest-rank
over that phase's own runs, so the phase p50s need not add to the total's
(here 81.7 vs 81.6 ms). This run's total p50 is lower than table 1's 99.2 ms
at `71f1d77b`, but the host was at load average 9.5 with other RSI lanes
running and the two runs are different commits; the within-run split, not the
cross-run delta, is what table 2 supports.

## What these numbers do not prove

- **Cold start.** Every run starts from a console that is already loaded; this
  is the cost of a switch, not of opening Kin.
- **Phone ↔ Mac.** The phone leg is the console at a 390-wide viewport on the
  same machine and loopback daemon. It is not the phone→Hub→Mac route, and no
  network beyond loopback is in any number.
- **Real conversations.** The seeded transcripts are one prompt and one answer;
  a long real transcript may render, virtualise or restore scroll differently.
- **The reverse legs.** Morning planning → Failed migration, conversations →
  routines, and list → chat are measured. The opposite directions and
  alternating areas are not.
- **The Electron shell and the packaged build.** Chrome headless drives the
  console directly; the desktop shell's boot surface, its navigation and the
  `.dmg`/asar build are outside this number.
- **Scroll and draft restoration cost.** J9/J11 prove the shell node, scroll and
  draft *survive* a switch. This script measures when the destination content
  appears, not what restoring those costs.
- **A controlled machine.** Other RSI lanes share this host; load is recorded
  above but was not held constant, and 10 runs per leg is a small sample.
- **A guard proof is not a measurement.** `--break-splash`, `--break-alert` and
  `--break-blank` show the surface read fails loudly on each condition it
  names; they say nothing about how often the real console shows a splash, a
  blank `<main>` or an alert during a switch, and they record no number.
- **Paint.** `t1` is the first animation frame after the visibility poll, so the
  duration is an upper bound that includes the poll lag and up to one frame.
- **A cache hit is not a fetch.** Resource timing measures the fetch the page
  issued: a read served from the app's own cache (no fetch) is `unattributed`,
  not a zero-length `read`. The loopback daemon answers the three-project seed
  quickly; a cold connection, a slower provider or a larger collection would
  move `read` without changing the method.
- **Why a phase took that long.** Attribution names the phase that owns the
  time, not the mechanism inside it. `render` contains React work, layout, the
  next frame and the visibility poll's detection lag; `read` contains
  connection, queueing and the daemon's handler.
- **Additivity.** Each phase's p50/p90 is nearest-rank over that phase's own
  attributed runs, so phase percentiles need not add to the total's percentile
  and must not be summed as if they did.

## Reproduce

```bash
# Build the console if web/dist/assets is absent, then the daemon binary.
(cd ui && npm run build)
go build -o ./kin ./cmd/kin

# The baseline (10 measured runs + 1 warm-up per leg), now with attribution.
node rsi/runtime/ux/switch-latency.mjs --kin ./kin --runs 10

# Claim check: the JSON's numbers and attribution lines, no daemon needed.
# The output below is the 2026-11-20 retired-leg run; a fresh run prints the
# new conversations → routines leg's rows and split instead.
node rsi/runtime/ux/switch-latency.mjs --print rsi/state/switch-latency/switch-latency.json
# -> attr mac-area-to-area attributed 10/10 dispatch p50 1.8 p90 1.9 · read p50 1.3 p90 1.5 · render p50 78.6 p90 133.1

# Hermetic: the printer's attribution contract and the legs' area tokens
# (6 cases, no daemon, no browser).
bash rsi/runtime/tests/test-switch-attribution.sh

# Guard (a): a destination that never appears.
node rsi/runtime/ux/switch-latency.mjs --kin ./kin --runs 1 --legs mac-chat-to-chat --break-target --out "$(mktemp -d)"
# -> GUARD (a) destination-never-appeared: ... ; exit 2, no number recorded

# Guard (b): a reload in place of a switch.
node rsi/runtime/ux/switch-latency.mjs --kin ./kin --runs 1 --legs mac-chat-to-chat --break-shell --out "$(mktemp -d)"
# -> GUARD (b) shell-rebuilt: ... ; exit 2, no number recorded

# Guard (c), splash: the boot splash is still what is on screen.
node rsi/runtime/ux/switch-latency.mjs --kin ./kin --runs 1 --legs mac-chat-to-chat --break-splash --out "$(mktemp -d)"
# -> GUARD (c) splash-blank-or-error: the boot splash is still the surface on screen ; exit 2

# Guard (c), blank: <main> has no text.
node rsi/runtime/ux/switch-latency.mjs --kin ./kin --runs 1 --legs mac-chat-to-chat --break-blank --out "$(mktemp -d)"
# -> GUARD (c) splash-blank-or-error: the main surface is blank ; exit 2

# Guard (c), error: a visible role=alert is on screen.
node rsi/runtime/ux/switch-latency.mjs --kin ./kin --runs 1 --legs mac-chat-to-chat --break-alert --out "$(mktemp -d)"
# -> GUARD (c) splash-blank-or-error: an error surface is on screen: ... ; exit 2
```

The script kills its daemon and removes its `mktemp` directory on exit. It
refuses the live node's port and never reads or writes `~/.kin`.
