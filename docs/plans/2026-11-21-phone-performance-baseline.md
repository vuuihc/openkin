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
| Guards | green — `--self-check` proves nearest-rank p50/p90, all **13** guards exit 2, short sets exit 2, JSON round-trips |
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
   proposes one, and no `ui/` code was written in this row. **Row 22 ran that
   control: the contain arm met the bar (3.3 % pooled dropped, tap p90
   139.8 ms) but the off baseline met it too (4.3 %) and the paired delta was
   0.0 pp — see `## Paint containment A/B (row 22)`; the baseline gap must
   reproduce before a story is signed.**
2. **Glass A/B before blaming the blur.** If containment alone does not close
   the gap, add a glass-off control to this script and re-measure; the p90
   signature points at blur over a tall scrolling layer but this run did not
   isolate it. **Row 19 ran that control: the blur is not attributable — see
   `## Glass A/B (row 19)` below, and the next candidate is step 1.**
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

## Glass A/B (row 19)

**Status: measured — control clean, verdict `not attributable`.** Command:
`node scripts/phone-interaction.mjs --runs 5 --glass=ab --json` on the product
tree at `06dbce0b` (this row touches no product file; the harness is the one
this row adds), exit 0, **no guard fired**. Chrome **157.0.8103.51 headed**,
viewport **390×844** (`isMobile`, `hasTouch`), 8 CPUs, 1-minute load
**7.7–9.9** across the five runs, idle-rAF p50 **8.3–8.4 ms** in every arm
(120 Hz clock, not throttled). Seed: **30 rows**, **61 message events**, 19
follow-ups.

Each run measured both scroll legs twice, re-opening the page per arm; arm
order alternated by run parity (1 on→off, 2 off→on, …). The off arm set
`backdrop-filter: none !important` (and `-webkit-`) on the four carriers; the
on arm injected an inert declaration through the same `<style>` element. The
override was proven on every mounted carrier — **2 on `/sessions`**
(`SessionsHeader` + phone footer, both `.kin-glass`) and **1 on
`/tasks/:id`** (`MobileHeader`) — in all ten arm visits; the
`glass-override-not-applied` guard never fired. The `/sessions` leg was
included in both arms; the whole five-run pass plus build and seed finished in
under two minutes, so the extra list leg stayed far inside the 30 s/run budget.

Pooled over five runs (frame intervals, same method as #522):

| Leg | Arm | Frames | Frame p50 | Frame p90 | Dropped | Long tasks |
|---|---|---:|---:|---:|---:|---:|
| `/sessions` scroll | on | 1,215 | 8.3 ms | 9.2 ms | 3.3 % | 0 |
| `/sessions` scroll | off | 1,225 | 8.3 ms | 9.2 ms | 4.8 % | 0 |
| `/tasks/:id` transcript scroll | on | 1,212 | 8.3 ms | 11.6 ms | 9.8 % | 0 |
| `/tasks/:id` transcript scroll | off | 1,215 | 8.3 ms | 10.8 ms | 8.6 % | 0 |

Paired per run (off − on; nearest-rank over the five per-run deltas, which is
the statistic that removes machine drift):

| Leg | p90 | Dropped | Per-run p90 / dropped |
|---|---:|---:|---|
| `/sessions` | **+0.3 ms** | **+2.5 pp** | +0.3/+3.7, −0.4/+0.9, +0.4/+2.5, +0.8/+2.6, −0.2/−2.1 |
| Transcript | **+0.1 ms** | **+1.3 pp** | +1.1/+1.9, +0.1/−0.8, +3.4/+1.8, −7.2/−10.1, −0.4/+1.3 |

**Verdict: not attributable.** Removing the blur moved the transcript's paired
p90 by a median **+0.1 ms** and its dropped-frame ratio by **+1.3 pp** — both
inside the `/sessions` leg's own paired spread (same carriers, same override:
median **+0.3 ms** / **+2.5 pp**, range **−2.1 to +3.7 pp**) — and the
transcript's per-run deltas changed sign (−10.1 to +1.9 pp); the glass is not
this transcript's measured frame cost. The next candidate is step 1,
transcript paint containment: the transcript still drops 8.6–9.8 % with zero
long tasks while the list drops 3.3–4.8 % under the same carriers. No product
code was written and no story is signed by this row.

The tap (p50 134 / p90 155 ms), sheet (57/60 ms) and composer (54/60 ms) legs
were measured once per run outside the A/B and stayed in #522's band.

**What this cannot prove.** Chrome headed is a proxy; WKWebView on a real
iPhone is the fact. The machine was shared (load printed above) and the
override is a simulation of removing blur, not a product change — it also
removed the phone footer's blur on `/sessions` because the footer carries
`.kin-glass`. This run's absolute cost is lower than #522's (transcript on-arm
9.8 % dropped / p90 11.6 ms here vs 18.0 % / 16.3 ms there, at a lower load),
so the two rows' absolute numbers are not comparable; the paired delta inside
this run is the evidence, and a longer transcript or a loaded device could
still make the blur matter.

## Paint containment A/B (row 22)

**Status: measured — control clean, verdict `closes-gap` by the pre-declared
bar, not attributable to the override.** Command:
`node scripts/phone-interaction.mjs --runs 5 --paint=ab --json` on the product
tree at `a430e521` (harness commit `bc24dc67`; this row touches no product
file), exit 0, **no guard fired**. Chrome **157.0.8103.51 headed**, viewport
**390×844** (`isMobile`, `hasTouch`), 8 CPUs, 1-minute load **7.6–9.6** across
the five runs, idle-rAF p50 **8.3 ms** in every arm (120 Hz clock, not
throttled). Seed: **30 rows**, **61 message events**, 19 follow-ups; the
transcript drew **42→50** keyed message rows, one more composer send per run.

Each run measured both scroll legs twice, re-opening the page per arm; arm
order alternated by run parity (1 contain→off, 2 off→contain, …). The contain
arm set `content-visibility: auto !important` and
`contain-intrinsic-size: auto 120px !important` on
`[data-conversation-pane] [data-message-key]`; the off arm injected an inert
custom property through the same `<style>` element. The override was read back
from every mounted row before the frame window: **42/44/46/48/50 transcript
rows** per arm, **0 message rows on `/sessions`** (none mount there), every
contain row computed `auto` and every off row computed `visible`. The
`paint-override-not-applied` guard never fired.

Pooled over five runs (frame intervals, same method as #522):

| Leg | Arm | Frames | Frame p50 | Frame p90 | Dropped | Long tasks |
|---|---|---:|---:|---:|---:|---:|
| `/sessions` scroll | contain | 1,214 | 8.3 ms | 8.6 ms | 2.4 % | 0 |
| `/sessions` scroll | off | 1,214 | 8.3 ms | 8.7 ms | 2.4 % | 0 |
| `/tasks/:id` transcript scroll | contain | 1,214 | 8.3 ms | 8.5 ms | **3.3 %** | 0 |
| `/tasks/:id` transcript scroll | off | 1,227 | 8.3 ms | 8.6 ms | **4.3 %** | 0 |

Paired per run (contain − off; negative = containment reduced the interval;
both arms' absolute transcript numbers shown so the pairing can be read):

| Run | Order | Load (1m) | Contain dropped / p90 | Off dropped / p90 | Transcript Δ dropped / p90 | `/sessions` Δ dropped / p90 |
|---:|---|---:|---:|---:|---:|---:|
| 1 | contain→off | 8.80 | 3.3 % / 9.2 ms | 3.3 % / 9.0 ms | 0.0 pp / +0.2 ms | +0.9 pp / +0.4 ms |
| 2 | off→contain | 8.38 | 2.0 % / 8.4 ms | 8.9 % / 10.5 ms | −6.9 pp / −2.1 ms | +0.5 pp / +0.1 ms |
| 3 | contain→off | 7.64 | 2.5 % / 8.5 ms | 5.3 % / 8.7 ms | −2.8 pp / −0.2 ms | −0.9 pp / −0.7 ms |
| 4 | off→contain | 8.63 | 4.9 % / 8.5 ms | 2.0 % / 8.4 ms | +2.9 pp / +0.1 ms | −1.3 pp / 0.0 ms |
| 5 | contain→off | 9.55 | 3.7 % / 8.5 ms | 2.4 % / 8.4 ms | +1.3 pp / +0.1 ms | +0.8 pp / +0.2 ms |
| **median** | | | **3.3 % / 8.5 ms** | **3.3 % / 8.7 ms** | **0.0 pp / +0.1 ms** | **+0.5 pp / +0.1 ms** |

The verdict rule was fixed before this run (row brief): `closes-gap` when the
contain arm's pooled transcript dropped% is ≤ 9 % and tap p90 is ≤ 151 ms;
`partial` when the paired improvement exceeds the list leg's paired spread but
the arm is still above 9 %; `not attributable` when the paired delta sits
inside that spread. First match wins.

**Verdict: `closes-gap` by the bar, not attributable to the override.** The
contain arm's pooled transcript dropped **3.3 %** (≤ 9 %) and the post-run tap
p90 was **139.8 ms** (≤ 151 ms; tap p50 131.8 ms, sheet 57.5/62.1 ms, composer
53.6/54.1 ms), so the Decision memo's acceptance bar is met. But the off arm
met it too — **4.3 %** pooled — and the paired contain − off delta's median is
**0.0 pp** (range **−6.9 to +2.9 pp**, changing sign across runs) with a p90
median of **+0.1 ms**, inside the `/sessions` leg's own paired spread (median
**+0.5 pp**, range **−1.3 to +0.9 pp**). This session's *baseline* transcript
already sat in the list's band, unlike #522's 18.0 % or row 19's 9.8/8.6 %; the
contain arm therefore did not close a gap that this run reproduced. Next: if
the baseline gap reproduces on the current product tree, the smallest signed
story is the containment row; if it does not, the next candidate is a
real-device WKWebView trace, because on this proxy the arms are
indistinguishable. No product code was written and no story is signed by this
row.

**What this cannot prove.** Chrome headed is a proxy; WKWebView on a real
iPhone is the fact. The machine was shared (load printed above), and the
override is a simulation of containment, not a product change: it applies to
every keyed row at once, uses a fixed 120 px intrinsic placeholder that only
becomes exact after a row has rendered once, and does not exercise the app's
own scroll anchoring or streaming updates. The absolute numbers are not
comparable with #522 or row 19 — this run's off baseline was already at
4.3 % — so the paired delta is the only evidence about containment here, and
it is null. A longer transcript, a slower device, or WKWebView's own
`content-visibility` implementation could still separate the arms; this Chrome
number cannot.
