# 820×1180 reading baseline — the four high findings, measured

## 现在的位置 / Current position

Measured on base `76355fed` with this row's diff applied (the delivery commit carries no
code change beyond that measured tree; `SHA.txt` in the evidence folder records
`76355fed`). The opt-in diagnostic is **RED** and is not part of the default gate.
The mandatory 820 merge-gate gap remains open: `rsi/MANDATE.md` merge gate item 5 still
asks for 390/1100 screenshots only.

| Criterion | 820×1180 touch | 1100×760 reference | State |
|---|---|---|---|
| Persistent chrome above the reading pane | **130.3 px** (limit 44) | **117.3 px** | measured-red |
| Header actions ≥44×44, unclipped | **min 14.8×17.9 px**, 6 of 6 clipped | **min 31×17.9 px**, 0 clipped | measured-red |
| Every visible table cell center hits its cell | **4 cells red** at the bottom capture (r4c0–c3); **3 red** while unseen>0 | **4 / 3 cells red** | measured-red |
| Final table row fully readable | fully visible | fully visible | measured-green |
| Fixture really rendered (marker + 5 body rows) | present | present | measured-green |
| New-activity control with unseen>0 | **present**; geometric overlap 0, hit coverage 0 | present; overlap 0, coverage 0 | measured-green |
| 390×844 reference | not applicable — its header is `MobileHeader` (a different control set); the desktop action-cluster metric does not resolve there | — | unmeasured by design |
| iPad WKWebView, safe-area, real device | — | — | **unmeasured** (this is Chrome on the host) |

What the red cells actually are on this SHA: the seeded daemon holds three pending
approvals, and the pending-approval band/card stack covers the final table rows
(`hit` = `div.px-3.5.py-3.5`, the approval card body, and the band's buttons). The
reported “有新进展 pill covers the last two rows” is **not** what this capture shows:
the pill is present with `unseen > 0` but sits below the final row (`overlaps = 0`,
`covers = 0`). The overlay defect reproduces; the reported overlay identity does not,
and this row does not promote the report's observation to a measurement.

## One-command reproduction

```bash
./scripts/journeys-smoke.sh \
  --spec rsi/runtime/ux/tablet-reading.json \
  --out /tmp/tablet-reading-baseline
```

Exit is the runner's established code: **1** (walked, real failures), 2 when the run
itself is unavailable. Expected RED while the four findings are unfixed; do not add
`tablet-reading.json` to `rsi/runtime/ux/journeys.json` until the coherent reading fix
makes it green.

The pure verdict can be replayed without a browser:
`node rsi/runtime/ux/walk.mjs --reading-verdict <out>/JT1-tablet-05-incoming.reading.json`
→ `available=true, ok=false` (chrome/actions/cells false; lastRow/newActivity true), exit 1.

## What the run actually recorded

**820×1180 (`tablet`, `hasTouch: true`, `isMobile: false`, DPR 2)** — saved metrics
`JT1-tablet-02-table-bottom.reading.json`, `JT1-tablet-05-incoming.reading.json`:

- chrome `130.3 px` (pane top); 44 px is the ceiling.
- actions: `文件 23.8×44`, `Pull Request 51.9×44`, `分享 23.8×44`,
  `归档会话 23.8×44`, `删除会话 23.8×44`, `alpha 14.8×17.9`; all six `clipped: true`.
  With the round running, the incoming capture adds `停止 14×44` and the same verbs
  shrink to `18×44`.
- table: 5 body rows + header; final row `fullyVisible: true`; four final-row cell
  centers return the approval card/band instead of the cell.
- new activity: pill present, `unseen > 0` (the follow-up landed while scrolled away),
  `overlaps: 0`, `covers: 0`.

**1100×760 (`mac`)** — `JT1-mac-02-table-bottom.reading.json`,
`JT1-mac-05-incoming.reading.json`:

- chrome `117.3 px`.
- actions: `文件 31×32`, `Pull Request 93.3×32`, `分享 31×32`, `归档会话 31×32`,
  `删除会话 31×32`, `alpha 32.8×17.9`; none clipped (the cluster is not squeezed at
  this width, it is only below the 44 px touch floor).
- table: final row fully visible; the same approval card/band covers r3–r4 cells.
- new activity: pill present, overlap 0.

## Artifacts

Evidence directory:
`rsi/state/shots/tablet-reading-baseline/` (control tree; not committed).

| File | What it is |
|---|---|
| `walk.json` | raw walk summary, complete `hardFail` array |
| `summary.txt`, `run.log` | runner table and full log; summary exits 1 |
| `seed.log` | the throwaway daemon and fake-agent fixtures |
| `context-tablet.json` (plus phone/mac) | the exact `browser.newContext` options |
| `JT1-tablet-*.png`, `JT1-mac-*.png` | 820 captures and 1100 references |
| `*.reading.json`, `*.verdict.json` | raw measurements and the shared verdict |
| `SHA.txt`, `git-status.txt` | the measured tree |

## What this does not prove

- Chrome on the host, not iPad WKWebView: safe-area and real-device touch are outside it.
- No daemon without pending approvals was measured; the approval band is a named
  confounder, not folded into the pill criterion.
- Horizontal table overflow and first-column wrapping are not separate criteria here;
  the final row is fully visible horizontally in this fixture.

## Next product action

Run the coherent reading fix as one delivery (T3-quality reading surface):

1. `R-reading-chrome` — collapse usage/changed-files into one header entry; chrome
   ≤44 px above the pane.
2. `R-header-cluster` — 44 px floor, `flex-none` actions or the existing `⋯` sheet;
   no half glyphs.
3. `R-new-activity-lane` — the unseen control takes a non-content lane (or side
   margin), never over the table; the approval band follows the same rule.
4. `R-table-measure` — first column `nowrap`/min width and a conversation measure
   ceiling; the final row stays fully readable.

Then rerun the command above until `JT1/tablet` is green, add
`tablet: 820x1180` to the acceptance set, and wire this spec into the merge gate.
