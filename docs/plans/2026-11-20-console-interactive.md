# Console interactive — 2026-11-20

**Status: measured and green.** The shell now stamps a ninth startup mark,
`console-interactive`, when the console reports that React committed its first
screen. On the recorded run the console became usable **221 ms** (median of the
per-run gaps) after the daemon answered, and **54 ms** (median of the per-run
gaps) after the console document finished loading. Three of three runs produced
all nine marks exactly once.

## Current position (现在的位置)

| Item | State |
|---|---|
| `console-interactive` mark, stamped in the main process | green — `desktop/src/console-interactive.ts`; 3 node tests |
| Renderer report after the first commit | green — `ui/src/lib/consoleInteractive.tsx`; 3 Vitest tests |
| Once-per-launch and console-URL rules | green — mutants: dropped trace and removed once-guard both turn the suite red, restored byte for byte |
| Runner requires 9 marks | green — `bash scripts/desktop-startup.sh --selftest` → 9 parsed marks |
| Real 3-run measurement | green — 9/9 marks exactly once in every run; table below |
| `console-interactive − sidecar-ready` | **221 ms** median of per-run gaps (178 / 306 / 221) |
| `console-interactive − window-first-load` | **54 ms** median of per-run gaps (54 / 62 / 51) |
| Visible change | none intended — the splash is #423's surface, unchanged |

## Why `window-first-load` was not "usable"

`window-first-load` is emitted from `did-finish-load` for the console document,
but the document does not render on load. `ui/src/main.tsx` runs a boot IIFE
that awaits `bootIntoStoredHub()`, `bootstrapTokenFromURL()` and
`refreshAccount()` before it calls `createRoot(root).render(...)`; the HTML
splash inside `#root` (`ui/index.html`) stays on screen for that whole stretch.
The startup doc said so in as many words: "renderer parse/script time beyond
`did-finish-load`" was not measured.

This row measures exactly that stretch. The renderer reports its first commit
over IPC; the shell stamps the mark on its own clock. The mark is a lower bound
on "the person can use the app": it says the first screen committed, not that
data arrived.

## Method

- **One clock.** `traceStartup` in the main process stamps
  `Date.now() - origin`, the same clock and origin as every other mark. The
  renderer's `performance.now()` is relative to its own document and could not
  be subtracted from `sidecar-ready`, so the renderer only says "now".
- **Bridge.** `preload.ts` exposes `markConsoleInteractive()` as a
  fire-and-forget `ipcRenderer.send("kin:console-interactive")`; it is optional
  in both `KinDesktopAPI` types, so a plain browser, the phone, and an older
  shell simply do not report.
- **Recorder.** `createConsoleInteractiveRecorder({ trace, isConsoleURL })`
  stamps only when the reporting frame's URL is the console's, and at most once
  per launch. A reload (a second report) records nothing, so the runner's
  "each mark exactly once" rule holds. The URL rule moved verbatim from
  `window.ts` into `desktop/src/console-url.ts`; both call sites import it.
- **Trigger.** `<ConsoleReady />` sits beside `<App />` and reports in a
  `useEffect`, i.e. after the first commit. StrictMode's double effect is
  harmless because the main-process recorder drops the second report.
- **Runner.** `scripts/desktop-startup.sh` now requires nine marks and still
  prints `shell-total` as **`window-first-load`** — the new mark is
  deliberately later, and redefining an existing name would silently change
  every table measured before this row.

## The run

`bash scripts/desktop-startup.sh --runs 3 --json`, one build and three launches
of the real dev shell against throwaway daemons. Every value in the table is a
`marks` value from that JSON; the median column is the JSON's `median_ms`.
macOS 27.2.1 arm64, 8 CPUs.

| Fact | Value |
|---|---|
| Build | worktree at `3c825df9` **plus this delivery uncommitted** (the built shell includes it) |
| Entry chunk | `/assets/index-BLDmbzoU.js` |
| Load average, start → end of invocation | `6.10 5.75 5.66` → `22.05 9.20 6.89` (other lanes share this machine) |
| Runs | 3, each with a fresh state + userData directory and a reserved port |
| Marks per run | 9, each exactly once |

| Mark | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| `process` (spawn → main.ts) | 2285 | 248 | 228 | 248 |
| `app-ready` | 2365 | 321 | 297 | 321 |
| `sidecar-start` | 2509 | 412 | 374 | 412 |
| `window-created` | 2615 | 475 | 426 | 475 |
| `window-ready-to-show` | 2851 | 684 | 549 | **684** |
| `window-shown` | 2866 | 698 | 562 | 698 |
| `sidecar-ready` | 3916 | 1047 | 914 | 1047 |
| `window-first-load` | 4040 | 1291 | 1084 | 1291 |
| `console-interactive` | 4094 | 1353 | 1135 | **1353** |
| **first paint** (`window-ready-to-show`) | 2851 | 684 | 549 | **684** |
| **shell total** (`window-first-load`) | 4040 | 1291 | 1084 | **1291** |

Run 1 is the first launch after the build and pays cold caches (`process`
2285 ms against 248/228 ms); it is kept in the median rather than discarded.

### The two gaps

Derived from the same JSON by subtraction; no number below is absent from it.

| Gap | Run 1 | Run 2 | Run 3 | Median of per-run gaps |
|---|---:|---:|---:|---:|
| `console-interactive − sidecar-ready` | 178 | 306 | 221 | **221** |
| `console-interactive − window-first-load` | 54 | 62 | 51 | **54** |

The difference of the two medians is larger (1353 − 1047 = 306 ms;
1353 − 1291 = 62 ms) because run 1's cold start inflates all three marks
together. The per-run gaps are the honest aggregate.

Reading: once the daemon answers, the console needs about a fifth of a second
(178–306 ms) before its first screen is committed, and only about **54 ms** of
that is renderer work after the document's load event — parse, the boot IIFE's
local work, React's first commit, the effect, and the IPC hop. The rest of the
`sidecar-ready` gap is the swap (`boot.settle("ready")` → `window-first-load`,
124–244 ms in these runs) plus the load itself. On this machine the
console document does not sit on the splash for long; the startup doc's
unmeasured tail turns out to be small compared with the daemon edge.

## What it does not prove

- **Dev shell, not the packaged `.dmg`/asar build.** A packaged app may parse
  and unpack differently.
- **"Interactive" means the first screen committed**, not that the screen was
  painted by the compositor, and not that any data loaded. `useEffect` runs
  after commit; the mark does not wait for a paint event or a first fetch to
  resolve.
- **The IPC hop is not decomposed.** The ~1 ms send + handler is included in
  the gap but not measured separately.
- **The phone webview is separate.** It has no `window.kinDesktop`, so it never
  reports and this mark says nothing about it.
- **One machine, one load average.** The numbers are reported as measured, not
  normalised; the invocation ran while other lanes were active (see load row).
- **Millisecond resolution.** `Date.now()` on the main process floors each mark
  to a whole millisecond; gaps of a few milliseconds are not meaningful.
- **No before/after claim.** This row adds measurement only; it changes no
  product behaviour and no existing mark.

## Reproduce

```bash
bash scripts/desktop-startup.sh --selftest          # 9 parsed marks, gap rejected
bash scripts/desktop-startup.sh --runs 3 --json     # the table above
./scripts/mutants.py desktop/src/console-interactive.mutants.json
```

The runner boots throwaway instances only (`mktemp` state + userData, reserved
port); it never contacts the live node on `:7777` or `~/.kin`. If Electron
cannot launch, it prints `SKIP: <reason>` and exits 2 rather than inventing a
number.
