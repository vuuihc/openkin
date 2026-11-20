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
| Pre-render probe deadline | green — `PRE_RENDER_DEADLINE_MS = 1500` in `ui/src/lib/bootProbe.ts`; 6 Vitest tests, 6 mutants red |
| Healthy path still decides before the render | green — the deadline is cleared when the probe answers; the 3-run measurement below never takes it |
| Re-measured `console-interactive` | **1113 ms** median; **155 ms** after `sidecar-ready`, **44 ms** after `window-first-load` (3 runs, table below) |
| Deadline path in a real browser | green — held `/api/auth/status`, throwaway daemon, both viewports: splash at 400 ms, console committed 1800 ms later, no dialog or page error |
| One-time-link exchange | green — bounded by `LINK_EXCHANGE_DEADLINE_MS = 1500` in `ui/src/lib/linkExchange.ts`; a late success re-probes and opens the gate without a second render; 6 Vitest tests, 4 mutants red |

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

## The bounded handover — R-console-handover

The measurement above has an unbounded tail: `main.tsx` awaited
`refreshAccount()` before `createRoot(root).render(...)`, and `refreshAccount()`
had no deadline. A healthy daemon answers in tens of milliseconds; a half-open
connection, a loaded Hub, or a relay that accepts and never answers leaves the
iOS wheel (#423) on screen indefinitely, with nothing to say why and no retry.

The handover is now bounded by `PRE_RENDER_DEADLINE_MS = 1500`.

**Why 1500 ms.** The measured healthy handover is at most **306 ms** from the
daemon answering to the first commit (worst of the three runs in the table
above; 54 ms of it is renderer work after the document loads). 1500 ms is about
five times that worst healthy cost, so it cannot fire on a launch that is merely
having a slow moment, and it stays under the ~2 s point where a waiting screen
stops reading as “loading” and starts reading as “broken”.
`bootIntoStoredHub()` runs before this and keeps its own 2500 ms bound, so the
worst-case first render is **~4000 ms** on the shell's stored-Hub path and
**1500 ms** everywhere else. Both numbers are the written bound; neither path is
allowed to sit on the splash longer.

**What happens at the deadline.** The console renders immediately with the gate
open (`setAuthOk()`), and the original probe promise is left running. When its
answer lands:

- `enabled && !authenticated` and no device token → the visit gate is applied
  then, so the account screen appears at the moment the verdict is known;
- authenticated → one-time credentials are cleaned (`cleanVisitCredentials()`)
  and the gate stays open;
- an error or NO_ACCOUNT → today's fallback: no copy, no gate change.

The deadline path never produces a blank frame, a timeout-specific error, a
`ConnectScreen` caused only by the deadline, or a second `console-interactive`
mark. The last one is structural: `bootProbe.ts` calls `render` exactly once,
whichever path it takes, and the desktop recorder's once-per-launch rule stays
untouched.

**Where the code lives.** The orchestration is `ui/src/lib/bootProbe.ts`, with
the probe promise, the render callback, the gate callbacks and the deadline
injected — the same move #427 made for the mark, so the decision is tested
rather than sitting inside `main.tsx`. `main.tsx` keeps only wiring.

**One state to hold during the wait.** At the deadline the account answer does
not exist yet, and the store's default (`NO_ACCOUNT`) is itself a verdict —
App's mount effect reads it as “this daemon has no accounts” and would close the
gate on the token screen the deadline did not ask for. While the probe is
unanswered the store therefore holds `NO_ACCOUNT` with `enabled: true`, and
`applyVisitGate()` refuses to decide from it. The first such decision retires
the placeholder, so an API 401 after it reads as NO_ACCOUNT (the token screen
for a daemon with no accounts) rather than inventing a login screen the daemon
may not be able to serve.

### The run on this branch

`bash scripts/desktop-startup.sh --runs 3 --json`, same command as the baseline
above, one build and three launches of the real dev shell against throwaway
daemons. Every value is quoted from that JSON (`per_run[].marks` and
`median_ms`); macOS 27.2.1 arm64, 8 CPUs, other lanes active (load average
`9.26 7.24 7.64` after the runs). Build: worktree at `890c15dd` **plus this
delivery uncommitted**; entry chunk `/assets/index-BAvdb7Lo.js`.

| Mark | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| `process` | 2100 | 230 | 225 | 230 |
| `app-ready` | 2195 | 284 | 292 | 292 |
| `sidecar-start` | 2333 | 384 | 367 | 384 |
| `window-created` | 2410 | 441 | 420 | 441 |
| `window-ready-to-show` | 2546 | 560 | 534 | **560** |
| `window-shown` | 2567 | 575 | 550 | 575 |
| `sidecar-ready` | 3620 | 921 | 959 | 959 |
| `window-first-load` | 3733 | 1032 | 1069 | **1069** |
| `console-interactive` | 3790 | 1076 | 1113 | **1113** |

| Gap | Run 1 | Run 2 | Run 3 | Median of per-run gaps |
|---|---:|---:|---:|---:|
| `console-interactive − sidecar-ready` | 170 | 155 | 154 | **155** |
| `console-interactive − window-first-load` | 57 | 44 | 44 | **44** |

Nine of nine marks in every run, each exactly once. The handover after the
document loads is 44 ms (median of per-run gaps), and after the daemon answers
155 ms — both far below `PRE_RENDER_DEADLINE_MS = 1500`, so no healthy launch
took the deadline. Run 1 again pays cold caches (`process` 2100 ms against
230/225 ms) and is kept in the median rather than discarded.

### The deadline against a real browser

The measurement above proves the bound does not fire on a healthy daemon; it
cannot prove what happens when the probe never answers, because a healthy run
never takes that path. That case was run against the production console served
by a throwaway daemon (`mktemp` state, reserved port) in Chromium, with
Playwright holding `**/api/auth/status` and never continuing it.

At 390×844 and again at 1100×760: 400 ms after the document loaded the splash
was up (`#root .kin-boot` = 1, the iOS wheel = 1, no text); 1800 ms later the
console had committed (`kin-boot` = 0, wheel = 0), showing the conversation list
and navigation, with one held request at each size, no dialog, and no page
error. The route was released afterwards. Shots live in the lane's gitignored
state: `rsi/state/shots/console-handover/{390,1100}-{splash,console}.png`.



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
- **No before/after claim.** The measurement rows in the first table were taken
  before this delivery and are kept as the baseline; the re-measured rows below
  are the same command on the branch.
- **The one-time-link exchange is bounded too.** A `POST /api/auth/login-link`
  that is accepted and never answered no longer holds the splash before the
  account probe starts: `linkExchange` stops waiting at
  `LINK_EXCHANGE_DEADLINE_MS` (1500 ms, `ui/src/lib/linkExchange.ts`), opens the
  console with a “did not finish” message, and adopts a late success by asking
  the account once more — no second render. Proven by
  `ui/src/lib/linkExchange.test.ts`.
- **The healthy runs never take the deadline.** They prove the bound does not
  fire on a daemon that answers; the deadline path itself is proven by the
  held-route browser run, not by these marks.
- **The deadline costs one render, not zero.** On the deadline path the console
  commits before any account answer exists. Data that needs the account still
  arrives after it, and a signed-out Hub gets its account screen late rather
  than before the first frame.

## Reproduce

```bash
bash scripts/desktop-startup.sh --selftest          # 9 parsed marks, gap rejected
bash scripts/desktop-startup.sh --runs 3 --json     # the tables above
./scripts/mutants.py desktop/src/console-interactive.mutants.json
./scripts/mutants.py ui/src/lib/bootProbe.mutants.json   # 6/6 red

# Claim check: the bound is in the code and the doc, and the never-answers
# test exists.
rg -n 'PRE_RENDER_DEADLINE_MS|1500' ui/src/lib/bootProbe.ts docs/plans/2026-11-20-console-interactive.md
cd ui && npx vitest run src/lib/bootProbe.test.ts -t 'never answers'
```

The runner boots throwaway instances only (`mktemp` state + userData, reserved
port); it never contacts the live node on `:7777` or `~/.kin`. If Electron
cannot launch, it prints `SKIP: <reason>` and exits 2 rather than inventing a
number.
