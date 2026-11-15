# ux-proto — clickable prototype of the four-zone shell (KIN-CONTINUE-003)

A zero-build, single-file approximation of the target experience: Kin tokens (`ui/src/design/theme.css` values), fake data, plain CSS standing in for Astryx.
It exists to **judge the experience** (structure, density, flow, states) before the visible shell slices (S1–S3) are allowed to start. It is not product code and is never imported by `ui/`.

```
python3 -m http.server -d rsi/ux-proto 8765      # then open http://127.0.0.1:8765/  (resize: <700px = phone layout, else Mac)
#   ?theme=light   light theme      ?still=1  no loading skeleton / no live-task ticker (used by the walk)
#   keys (Mac): Cmd/Ctrl+K palette · +1..4 areas · +N new chat · +\ review panel · j/k move in the list · Esc closes one layer
node rsi/ux-proto/walk.mjs rsi/state/ux-proto/final          # J1–J7 walk at 1440x900 + 390x844 (MAC_W/MAC_H override), 146 checks
```
`walk.mjs` needs `playwright-core` (`PW_CORE=…/node_modules/playwright-core`, default `~/.kin/ux-proto-tools`) and Google Chrome (no browser download). Besides screenshots it asserts the TASTE rules it can measure: one search box and at most one primary button per screen, no horizontal overflow, 44 px tap targets on the phone, tab bar only at area roots, per-area state survives area switches, deep link lands on the highlighted approval card and Back goes to the area root, the review panel never squeezes the chat under 420 px.

Screens: conversations (needs-you first, scope chips with counts), conversation (approval docked above the composer, running task you can follow, "new activity" pill), review panel (turn summary, scope, per-line comments → send to agent, one-click PR), new chat, projects + cover, routines, settings + agent operations, ⌘K palette, row actions, notification banner → deep link, offline banner, light theme.
Walk output (not committed): `rsi/state/ux-proto/final/` (1440×900, 390×844@2x) and `final-1100/` (1100×760). Findings and what changed between iterations: `rsi/UX-AUDIT.md`.
