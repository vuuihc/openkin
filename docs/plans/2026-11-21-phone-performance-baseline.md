# Phone interaction baseline — 2026-11-21

**Status: measured, 5/5 runs green, no guard fired.** On a headed Chrome at
390×844 with a real touch pipeline, scrolling 30 conversation rows dropped
**7.4 %** of frames; scrolling a 61-message transcript dropped **18.0 %** and
its p90 frame interval was **16.3 ms**, twice the list's **10.2 ms**. There
were **no long tasks** on the list and **one 51 ms task in five transcript
runs** (1 ms blocking): the transcript gap is paint/compositor time, not
JavaScript. A row tap showed its transcript in **127 ms** p50 / **151 ms** p90;
the run-config sheet opened in **57/68 ms** and a sent message's bubble landed
in **52/62 ms**. Startup is unchanged from its own baseline (warm 61 ms, cold
177 ms, phone-weak 3,674 ms).

## 现在的位置 / Current position

| Item | State |
|---|---|
| Command | `node scripts/phone-interaction.mjs --runs 5 --json` — exit 0, table below |
| Machine | macOS Darwin 27.2.0, arm64, 8 CPUs; 1-minute load average **8.9–13.1** (other RSI lanes shared the machine) |
| Browser | Chrome **157.0.8103.51**, **headed**, viewport 390×844, `isMobile`, `hasTouch`; the display ran at ~120 Hz (idle rAF p50 **8.3 ms**) |
| Seed | **30 rows**, **61 message events** in `[seed] Morning planning` (19 follow-up turns beyond the seed), created through the public HTTP API |
| `/sessions` scroll | green — 5/5 runs; dropped frames **7.4 %** pooled, p50/p90 **8.3/10.2 ms** |
| `/tasks/:id` transcript scroll | green — 5/5 runs; dropped frames **18.0 %** pooled, p50/p90 **8.5/16.3 ms** |
| Tap → detail | green — 5/5; p50 **127 ms**, p90 **151 ms** |
| Run-config sheet | green — 5/5; p50 **57 ms**, p90 **68 ms** |
| Composer send → bubble | green — 5/5; p50 **52 ms**, p90 **62 ms** |
| Guards | green — `--self-check` proves nearest-rank p50/p90, all **11** guards exit 2, short sets exit 2, JSON round-trips |
| Not measured | Capacitor WKWebView on a real iPhone, the real Hub/tunnel, thermal/CPU state, native gesture comparison |

The one-sentence user-visible statement this run supports:

> 用户看到：手机上滚动会话列表和长对话时仍可能掉帧，点一行到详情有可测的延迟；这一轮先把这些数字量出来并归因，暂不改产品代码。

## What was measured

`scripts/phone-interaction.mjs` (Node, standard library + `playwright-core`;
no new dependency):

- **Throwaway daemon.** A reserved free port (never `:7777`), a `mktemp` state
  dir outside `~/.kin`, inherited `KIN_*` stripped, `kin serve --port N`, the
  process group killed on exit. It rebuilds `./kin` only when it is older than
  the Go tree or the embedded `web/dist`.
- **Seed.** `scripts/journeys_seed.py` under the journey fake agent
  (`[seed] ` rows, `RSI_FAKE_SLOW_SECS=0`). The script then tops the fixtures
  up through the public HTTP API to 30 rows and 60 messages and prints the
  counts it actually used. A short seed is printed as `(short sample)`, never
  padded.
- **Gestures.** Chrome's real touch pipeline via CDP
  `Input.dispatchTouchEvent` (the transport `rsi/runtime/ux/touch-drag.mjs`
  uses), not a synthetic `dispatchEvent`.
- **Clock.** An init script records every `requestAnimationFrame` timestamp on
  the page's own clock. A gesture window is the frames between `performance.now()`
  before the first touch and after the last one settles. A **dropped frame** is
  an interval longer than **1.5× that run's median**; **long tasks** are
  `PerformanceObserver('longtask')` entries over 50 ms in the same window, with
  blocking time `sum(duration − 50)`. p50/p90 are **nearest-rank**.
- **Tap, sheet, composer.** A capture-phase `touchstart` listener stamps `t0`;
  a `requestAnimationFrame` loop stamps `t1` on the first frame the destination
  is visible. Playwright's round trip is excluded.
- **Frame-clock control.** Headless Chrome on this machine advances rAF at
  20 Hz (idle p50 **50.0 ms**), so the script runs **headed** by default and a
  `frame-clock-throttled` guard (idle p50 > 40 ms) refuses scroll numbers from
  a throttled clock. This run's idle p50 was **8.3–8.5 ms** on every run.

## Results

Pooled over five runs; per-run values in the raw table below.

| Leg | Frames | Frame p50 | Frame p90 | Dropped | Long tasks | Blocking |
|---|---:|---:|---:|---:|---:|---:|
| `/sessions` scroll (30 rows) | 1,195 | **8.3 ms** | **10.2 ms** | **7.4 %** | 0 | 0 ms |
| `/tasks/:id` scroll (61 messages) | 1,201 | **8.5 ms** | **16.3 ms** | **18.0 %** | 1 (51 ms) | 1 ms |

| Interaction | p50 | p90 | Runs |
|---|---:|---:|---:|
| Tap row → transcript content visible | **127 ms** | **151 ms** | 5/5 |
| Run-config sheet visible | **57 ms** | **68 ms** | 5/5 |
| Composer send → new message bubble | **52 ms** | **62 ms** | 5/5 |

Raw runs (frames, dropped %, long tasks, tap):

| Run | Load (1m) | Sessions | Transcript | Tap |
|---:|---:|---|---|---:|
| 1 | 8.87 | 237 frames, 7.2 %, 0 LT | 240 frames, 19.6 %, 0 LT | 124.7 ms |
| 2 | 12.00 | 223 frames, 9.0 %, 0 LT | 243 frames, 17.3 %, 1 LT (51 ms) | 138.6 ms |
| 3 | 13.07 | 240 frames, 7.1 %, 0 LT | 239 frames, 20.1 %, 0 LT | 127.2 ms |
| 4 | 12.35 | 247 frames, 8.1 %, 0 LT | 240 frames, 16.3 %, 0 LT | 151.2 ms |
| 5 | 11.77 | 248 frames, 5.6 %, 0 LT | 239 frames, 16.7 %, 0 LT | 124.1 ms |

Idle rAF p50 was 8.3–8.5 ms with 0.9–10.7 % dropped, so the machine itself was
not the source of the transcript's 16–20 %. The transcript scroll runs from the
newest message upward (`scrollTop` 6,742 → ~4,865); the list scrolls from the
top (`scrollTop` 0 → 1,109). The list count is the number of
`[data-session-row]` elements after every bucket is expanded; the transcript
count is `type:"message"` events from the public events API (61), of which 42
keyed message elements were drawn in the first run.

## Startup

Unchanged from `docs/plans/2026-11-21-phone-console-baseline.md`:
**warm 61 ms**, **cold 177 ms**, **`phone-weak` 3,674 ms** medians at 390×844;
entry chunk **1,917,339 B** on disk, **573,385 B gzip**. This row does not
re-measure startup; the interaction legs above are the new half.

## Cause ranking

The five suspects from `rsi/state/dogfood/dogfood-20261121-phone-performance.md`,
re-checked at this commit. Classification: `web-fixable` / `native-only` /
`unknown`; "points at it" means this run's numbers separate it from the others.

| # | Suspect (`path:line`) | What this run says | Classification |
|---|---|---|---|
| 1 | `ui/src/components/mobile/SwipeReveal.tsx:116-118` — non-passive `touchmove` + `preventDefault` | **Not on the plain scroll path.** The effect is gated by `reorderActive` (`:110-119`): the listener exists only while a long-press lift is live. At rest the wrapper uses `touch-action: pan-y` (`:339`) and React pointer handlers (`:340-343`), so vertical scrolling stays with the compositor. No long tasks during either scroll. | `web-fixable`, **not attributable from this run** |
| 2 | `ui/src/components/sessions/SessionRow.tsx:102` — no `React.memo`; `SessionList.tsx:2063` maps every row | The list's live updates (the seed keeps one row running) did not produce a long task in 1,195 frames; its dropped ratio stayed at 5.6–9.0 %. A render storm would show as main-thread tasks, and none appeared. | `web-fixable`, **not attributable from this run** |
| 3 | `ui/src/index.css:775-784` `.kin-glass` / `:780-784` float — `backdrop-filter: saturate(190%) blur(24/28px)`; mounted by `MobileHeader.tsx:56` and `SessionsHeader.tsx:60` (both `md:hidden`, so on the phone) | **The strongest remaining candidate for the transcript's p90.** Both pages carry the same glass header, but only the transcript's frame p90 doubles to 16.3 ms (two 120 Hz vsyncs) while long tasks stay at zero — the signature of compositor/paint cost, which is what a blur over a taller scrolling layer produces. Not isolated: no glass-off control was run. | `web-fixable`, **direction of evidence, not isolated** |
| 4 | No virtualization — `ui/src/components/chat/ChatStream.tsx:779` maps every item; `rg` finds no `react-window`/`react-virtual` anywhere | At 61 messages (42 keyed elements) the transcript had zero long tasks in four of five runs; the cost is per-frame paint, not DOM size or reconciliation. Message components are already memoized (`ChatStream.tsx:905,1482,1545`), so a blind virtualization story would not address the measured signal. | `web-fixable`, **not supported at this size** |
| 5 | Startup entry chunk | Owned by `scripts/phone-console-startup.mjs`; cited above, not re-measured. It cannot explain an interaction frame. | `web-fixable`, **out of scope for this row** |

The RN question is not reopened: neither 2026-11-20 23:47 condition is met —
there is no named requirement only native can do, and this row produced no
startup-failure evidence. The intake's cost estimate stands, not re-derived:
`ui/src` non-test source 88,990 lines, 25–30 k shareable, 25–35 k phone views
to rewrite, 374 test files (~85 k lines, ~155 phone paths), 8–10 open
decisions; this repository already deleted 15,364 lines of native iOS once
(`b513573`) because a second client had to be kept in step.

## Decision memo

**`web fix` — one narrow paint story, not RN, not a virtualization project.**

1. **Transcript paint containment (smallest first story).** Keep off-screen
   message rows out of paint (for example `content-visibility: auto` plus
   `contain-intrinsic-size` on the message row) and re-run this script.
   Acceptance: transcript dropped frames fall into the list's band (≤ 9 %)
   with tap p90 no worse than 151 ms. No signed story exists yet; this memo
   proposes one, and no `ui/` code was written in this row.
2. **Glass A/B before blaming the blur.** If containment alone does not close
   the gap, add a glass-off control to this script and re-measure; the p90
   signature points at blur over a tall scrolling layer but this run did not
   isolate it.
3. **Do not virtualize 61 messages.** The absence of long tasks and the
   existing memoized message components say the DOM count is not the cost.
4. **Do not start an RN client.** The measured interactions are 50–151 ms and
   the list scroll is smooth; the transcript gap is a web paint cost with a
   web-side fix, and no 23:47 condition is met.

Re-measure after any phone-facing release; a >20 % drift in dropped % or tap
p50 reopens the row, otherwise the number is only recorded.

## What this cannot prove

Chrome is not Capacitor's WKWebView on a real iPhone: this run measures the
same React code under a different engine, compositor, GPU and display. The
machine was shared (load 8.9–13.1), so absolute intervals carry a load term
even though the idle control and the list/transcript contrast survived it.
There is no thermal or CPU state, no real Hub/tunnel latency, no native gesture
comparison, and no frame pacing below the browser's own rAF clock. The device
trace is the fact; this Chrome number is the proxy. It also cannot attribute
the user's felt jank to a specific line: it shows where the cost is (transcript
paint/compositor) and where it is not (long tasks, list reconciliation).

## Reproduce

```bash
node scripts/phone-interaction.mjs --self-check      # no browser, no daemon
node scripts/phone-interaction.mjs --runs 5 --json  # headed Chrome required
```

The JSON copy for this run is kept under the lane's local `state/shots/`
directory and is not committed. Exit 0 = measured; exit 2 = a guard fired or
the measurement could not run.
