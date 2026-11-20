# Switch latency — the first measured cost of an F4 switch

**Status: measured.** Three switch legs were timed on a throwaway daemon at
`71f1d77b`, 10 runs each after one discarded warm-up. No product change was
made: this document is the baseline the next switch phase opens from.

## Current position (现在的位置)

| Item | State |
|---|---|
| `rsi/runtime/ux/switch-latency.mjs` | green — boots, seeds, times three legs; `node --check` passes |
| Real end-to-end run (10 runs/leg) | green — table 1 below; JSON at `rsi/state/switch-latency/switch-latency.json` |
| Guard (a) `--break-target` | green — exit 2, `GUARD (a) destination-never-appeared` |
| Guard (b) `--break-shell` | green — exit 2, `GUARD (b) shell-rebuilt` |
| Guard (c) splash/blank/error | green — `--break-splash`, `--break-alert`, `--break-blank` each exit 2 with `GUARD (c) splash-blank-or-error` and their own detail |
| `--print <json>` claim check | green — prints the same p50/p90 as the run |
| Product code changed | none — script and this document only |

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
| `mac-area-to-area` | 1100x760 | `[data-area="projects"]` | `[data-projects-list]` (the fetched project rows) **and** `[data-area="projects"][aria-current="page"]` |
| `phone-list-to-chat` | 390x844 | `[data-session-row]:has-text('[seed] Morning planning')` | `[role=region][tabindex='-1']:has-text('[seed] change: summarise the three things worth doing today.')` |

`mac-area-to-area` starts from the conversations area each run; the reset
(projects → conversations) is not measured. The phone leg returns through the
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

## What these numbers do not prove

- **Cold start.** Every run starts from a console that is already loaded; this
  is the cost of a switch, not of opening Kin.
- **Phone ↔ Mac.** The phone leg is the console at a 390-wide viewport on the
  same machine and loopback daemon. It is not the phone→Hub→Mac route, and no
  network beyond loopback is in any number.
- **Real conversations.** The seeded transcripts are one prompt and one answer;
  a long real transcript may render, virtualise or restore scroll differently.
- **The reverse legs.** Morning planning → Failed migration, conversations →
  projects, and list → chat are measured. The opposite directions and
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

## Reproduce

```bash
# Build the console if web/dist/assets is absent, then the daemon binary.
(cd ui && npm run build)
go build -o ./kin ./cmd/kin

# The baseline (10 measured runs + 1 warm-up per leg).
node rsi/runtime/ux/switch-latency.mjs --kin ./kin --runs 10

# Claim check: the JSON's numbers, no daemon needed.
node rsi/runtime/ux/switch-latency.mjs --print rsi/state/switch-latency/switch-latency.json

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
