# GOAL — Kin RSI

**North star:** when Ethan dogfoods Kin in the morning it feels at least as good as T3 Code, and
in places (self-hosted Hub, routines, cost control, phone call-back) better. Every pulse must move one of
the five flows below closer to "passes without a human noticing".

## The five flows (each is judged by what the user sees, not by test counts)

| # | Flow | Pass means |
|---|---|---|
| F1 | New chat → send | Message and waiting row appear instantly and **never vanish**: no full-page skeleton, no blank area, and a composer visible at every 16 ms sample across `/new` → `/tasks/:id`, its box moving at most 24 px (measured 2026-11-21: 2 px at 390, 4 px at 1100; the conversation's composer takes the caret and the draft composer's `expanded` arrangement on arrival, so Start does not resize the box; the detail page mounts its own composer, so element identity is not claimed — J3 `sample`/`steady`; gap-log 2026-11-14 高). |
| F2 | Mid-run control | While an agent runs: send a follow-up, interrupt, approve/deny, answer a question, all from the composer/cards with consistent pickers (agent/model/permission/dir open the same way, no layout jump). YOLO means no approval prompts. Steer is honest: native if the agent supports it, otherwise labelled interrupt+requeue. |
| F3 | Review → PR | See what changed this round, open the diff, comment on lines, send comments back, commit/push/open PR without leaving the conversation (parity target: Lody diff comments, T3 one-button PR). |
| F4 | Switch without repaint | Chat↔chat, chat↔project, area↔area keep shell, scroll, drafts and loaded content. Skeleton only on the first load of a block (TASTE 15). |
| F5 | Phone call-back | Notification → tap → lands on the exact item → approve/answer → back, with state intact on the phone's four tabs. |

## How we get there (ordered by leverage)

1. **Stop the bleeding** on F1/F2/F4 defects (gap-log Open, High first).
2. **Make inconsistency impossible**: `ui_inventory` ratchet + lint bans (raw `<button>`, `createPortal`, magic z-index) in `scripts/check.sh`.
3. **Kin facade primitives** (`ui/src/components/ui/`: Button, Menu, Popover, Select) used first by the Composer bottom row. Astryx sits *behind* the facade later.
4. **UX unification** per `docs/plans/2026-11-14-ux-unification.md` (four zones; Mac two-column; phone four tabs) — Batches C → B → D → E; Batch A (React 19 / Tailwind 4 / Astryx) only after the facade exists.
5. **Parity gaps** from `docs/plans/2026-11-02-lody-parity-gap-report.md` S2 list (steer, queue reorder, routine filters, tabbed workspace panel, PR review).

## Rules of the game

- One item per pulse, one reviewable PR (≤ ~800 changed lines), merged only when gates are green (MANDATE).
- A UI change is not done without 390px and 1100px before/after screenshots (TASTE 9) and a one-line "what the user sees now".
- Prefer deleting/merging UI over adding it (TASTE 7). Prompt before product machinery (PRINCIPLE 5.5).
- Escaped defects → `docs/product/LESSONS.md` (see `LESSONS-HOOK.md`).

## Current phase (P16) — 一块 820 屏的阅读面，做到 T3 的清晰与克制
<!-- phase: P16-t3-reading target=2026-11-28T20:00 -->

**Why this and not features.** The north star is "at least as good as T3 Code", yet on 2026-11-21 the
owner's daily device — an iPad at 820×1180, split view leaving ~520 CSS px for the conversation — was in no
journey, no merge-gate screenshot rule and no UX-gate width
(`docs/plans/2026-11-21-t3-parity-quality-reset.md`, evidence A). Two screenshots of the same 820 screen show
the gap in product terms: four persistent bars (~170 CSS px, ~270 with banners) above the body; header verbs
crushed to 24–30 px half-glyphs; a table wrapping one character per line with its last rows under a floating
「有新进展」 pill. The same day's ledger shows what the loop rewarded instead: on 2026-11-21 afternoon 27 of
48 merges were loop guards and bookkeeping, and `pace.py` read NO-PHASE while every phase marker was closed
and P15 was parked (evidence B). The reading surface is where T3 is strongest and where the owner spends his
day, so it is the phase.

**Done means** (each item names what proves it; a green check alone is not proof)
1. The 820 width is inside the acceptance gate: `rsi/runtime/ux/journeys.json` carries a
   `tablet: {"size": "820x1180", "hasTouch": true}` viewport, a tablet reading journey (J16) runs the
   long-answer + 4-row-table fixture, `rsi/MANDATE.md`'s merge-gate screenshot rule asks for 390/**820**/1100,
   and a hermetic contract in `scripts/journeys_smoke_test.py` keeps J16 from being weakened without a
   browser (row 33, PR #543).
2. The reading surface keeps one column at 820: persistent chrome above the body ≤44 CSS px (the header;
   usage/billing, changed files, daemon state and subagent counts reachable in one action from it, never
   deleted), every visible control ≥44×44 CSS px with whole glyphs, the table's first column not wrapping one
   character per line, every visible cell's centre hit-testing to that cell, and the last row fully readable
   with no floating surface over it (row 32, PR #542, and the rows it unblocks).
3. The reading state is reproducible by one command and a screenshot set: the tablet journey at 390/820/1100,
   shots under `rsi/state/shots/<slug>/`, and one "what the user sees now" sentence in the PR body.
4. STATUS leads with the product delta: the Current position's first evidence line is one user-visible change
   with its shots; merge counts are a cost line, not the headline.

**Out of scope** — the flat thread list and the three-level device → project → conversation tree
(`R-list-scan` stays parked: it needs its own story, not a slice); the native/RN rewrite (DECISIONS
2026-11-20 23:47); P15's bundled console (parked 2026-11-21, option ③) and any auth/CORS change; in-app PR
writes and the browser panel (ADR 0034); fades, ellipses or `overflow: hidden` used to hide a defect a
screenshot can show.

**Cut rule.** At 11-28 20:00 land what is green and queue the rest with its reason; do not extend the date.
If item 2 is not green, land the width (item 1) plus what is measured and record the remaining mechanism with
its number — a phase that explains itself is what the next fix is judged against. While #542/#543 are
unmerged, at most one lane runs P16 product work at a time; the phase does not license stacking loop guards.

## Closed phase (P3) — review → PR, proven
<!-- closed-phase: P3-review-pr target=2026-11-20T20:00 -->

Closed 2026-11-18, all four items landed: item 1 `58afe1ae` (#274 walks the Mac review loop, with the tray's
single primary and ⌘Enter/edit/undo passes `c583b892`/`d12a3cdc`), item 2 `db4792a7` (#279 the 390 review
loop), item 3 `f55f70bb` (#282 a rerun keeps the comment; seed `6adca723`), item 4 `dc5a4cdb` (#287 the PR tab
walked as unobserved → refresh → read).

**Why this and not features.** P1 proved F1 by walking a real send; P2 proved F2 by walking mid-run control.
F3 is the last of the three daily flows with parts but no proof: line comments, the tray, the send-back
(#181, #261), the changed-files bar, and the read-only PR / publish panels all exist and have DOM suites, yet
J2 stops the moment the diff opens. So a regression that drops the comment body or its file/hunk/quote from the
sent message, that loses a comment when the agent reruns, or that leaves the tray stale is invisible to the gate
and only a human eye catches it. Review is also the flow where T3 Code is strongest, so "feels as good" is
decided here.

**Done means** (throwaway daemon with the fake agent; walker/seed PRs touch no `ui/` file, so `ux-gate.sh`
does not run on them — item 1's mutant is their verification):
1. The Mac review loop is walked in J2: the seeded `[seed] Morning planning` conversation opens `notes.md`'s
   diff, a changed line takes a comment (⌥C or the gutter glyph), Save puts one row in the tray, Send lands one
   ordinary follow-up in the transcript naming the path, hunk and quoted line, and the tray is empty afterwards.
   1100 shots of the box, the tray and the sent message are stored. A mutant that drops the anchor (or the body)
   from the sent message turns the J2 walk red, and a `--check-spec` negative keeps the new steps from being
   weakened without a browser.
2. The phone review loop is walked at 390: tap a changed line → the comment sheet → Save → tray → Send, with the
   same transcript assertion and shots of the sheet, the tray and the sent message.
3. A rerun keeps the comment: a second round rewrites the commented line (`[seed] rewrite`), and the tray either
   re-anchors the comment to the quoted line's new position (`[seed] shift`) or marks it 该行已变化 and keeps it —
   never drops it silently. A mutant that deletes a comment when its line changes turns the proof red.
4. The PR leg is honest in the walk: J2 opens the read-only PR panel on the seeded branch and asserts the state a
   person meets (unobserved / last-read age, one explicit refresh), with no live GitHub call on open.

**Cut rule.** If item 1 is not green by the target, land it alone (it is the lost-review path and the one that
catches the most), keep 2–4 queued, and say so in the weekly retro. Do not extend the date.

## Closed phase (P4) — the last two flows, walked
<!-- closed-phase: P4-flows-proven target=2026-11-21T20:00 -->

Closed 2026-11-18, all four items landed: item 1 F4's typed draft, scroll offset and shell node survived
chat↔chat and area↔area, mac `4b175773` (#284) and phone `7b929048` (#295), item 2 `d00d19cf` (#288 each
phone tab returns to its own address after an approval), item 3 `cb345bef` (#285 发布 as the panel's fourth
tab), item 4 `eb1a3334` (#291 J5's shipped row actions pinned). P4 closed early; the target date is unchanged.

**Why this and not features.** P1/P2/P3 gave F1, F2 and F3 a walk that fails when the flow breaks; F4 and F5
still rest on DOM suites no person runs as a user. Nothing walks chat↔chat and area↔area to prove the shell
node, the scroll offset and a typed draft survive, and nothing walks notification → item → approve → back on
the phone's four tabs. Those are the flows Ethan uses right after review, and their regressions read as "the
app flashed and ate my draft" — invisible to today's gate. So the phase proves the last two flows and finishes
the panel review now lives in: 发布 becomes its fourth tab.

**Done means** (throwaway daemon with the fake agent; walker/seed rows touch no `ui/` file, so `ux-gate.sh`
does not run on them — each item's mutant is its verification):
1. F4: a typed draft, the scroll offset and the shell node survive chat↔chat and area↔area; a mutant that
   remounts the shell turns the walk red; 390/1100 shots of both switches.
2. F5: after approving from a deep link, each phone tab returns to its own address and the approved card stays
   gone; a state-losing mutant turns it red.
3. 发布 is the panel's fourth tab (变更 · 文件 · PR · 发布), one surface, one close, and the old full-bleed
   publish sheet is deleted; 390/1100 shots.
4. J5's shipped row actions stay pinned (改名 on the active scope, 正在运行 disabled) so the walk cannot drift
   from what ships.

**Cut rule.** If item 1 is not green by the target, land it alone (lost drafts are what people notice first),
keep 2–4 queued, and say so in the weekly retro. Do not extend the date.

**Out of scope — parked on Ethan** (one line each in `state/STATUS.md`, "Parked / needs a person"): F3 in-app PR writes (credential and
permission model), the browser panel tab (Electron `webview` ADR), the agent catalog cut 74 → ≤10.

## Closed phase (P6) — a new chat starts already briefed
<!-- closed-phase: P6-projects-briefing target=2026-11-21T20:00 -->

Closed 2026-11-18, all three items landed: item 1 `2059df97` (#306 — the cover shows the 工作方式 block
and new chats carry it) and `9d8dfeb9` (#313 — 003 `covered` after the J4 walk), item 2
`TestBuildContinuePromptWorkInstructions` in `internal/store/onepager_test.go` and
`TestPrepareTaskCreateInjectsWorkInstructions` in `internal/api/projects_test.go` (6 + 3 subtests, mutant
red in #306), item 3 the J4 walk (#313). P6 closed early; the target date is unchanged.

**Why this and not features.** P5 gave a project a face for *which directories* it is made of. The thing a
person repeats by hand every day is *how work happens here* — the build command, the generated files nobody
edits, the doc to read first. Today that only fits in the One-Pager's Current Focus, which belongs to the main
line and is capped, or it is retyped into every new chat and lost when the chat ends. The signed
`KIN-PROJECT-003` already settles the durable source: a bounded `## 工作方式` section in `ONE_PAGER.md`, carried
by the digest that new chats already receive (`OnePagerDigestMaxRunes = 1200`), read-only on the cover with a
「让 Kin 改…」launcher — zero schema, zero new endpoint, no new editor and no new tab. Parity §7 names the same gap
("project instructions"), and the injection path (`maybeInjectProjectContext` → `BuildContinuePrompt`) already
exists, so the work is to make it carry this section, not to invent a second document.

**Done means** (each item names what proves it):
1. KIN-PROJECT-003 delivered: `## 工作方式` (aliases `How to work here`, `Instructions`) is parsed into the
   digest, at most 400 characters and still inside the existing 1200-rune budget; the cover shows the text the
   agent will actually receive, with 空 / 截断 / 读取失败+重试 / 离线 states and the launcher that pre-fills the
   composer without starting it; 390/1100 shots; the registry flips to `covered` with the tests that name
   `KIN-PROJECT-003` in the same PR.
2. The first prompt carries it: a test proves a new chat in a project with that section receives the text
   through `BuildContinuePrompt` (and a project without it receives nothing extra), and a mutant that drops the
   section from the digest turns that test red.
3. The block a person reads on the cover is the same text the agent gets in a new chat, on both widths — the
   story's J4 row walked, not only asserted in a unit test.

**Cut rule.** If item 1 is not green by the target, land it alone, keep item 3 queued, and say so in the weekly
retro. Do not extend the date.

**Out of scope** — routines 「清空已结束」/delete API (parked row 13: needs an ADR and Ethan's word), the `@`
object expansion (session / role / prompt shortcut: needs its own story), the §6 MCP config face (needs a
security pass), reading a project's `AGENTS.md` / `CLAUDE.md` (filesystem, future story), and anything that
would add a schema, a migration or a new endpoint.

## Closed phase (P7) — 手机上没被走查过的三件事
<!-- closed-phase: P7-phone-gestures target=2026-11-23T20:00 -->

Closed 2026-11-19, all three items landed: item 1 `baea0c98` (#318 the three phone gestures walked as
J12) and `dcbd6d24` (#326 J12 registered in the journey set), item 2 `76e95b65` (#330 the phone file
legs), `106995e8` (#340 Back restoring each tab) and `26419567` (#345 the KIN-RESULT-002 flip), item 3
`02504e57` (#316 KIN-MANAGE-001, KIN-RESULT-001 and KIN-RESULT-003 flipped, each naming its walk
test). P7 closed four days early; the target date is unchanged.

**Why this and not features.** P1–P6 proved the five flows on the Mac and most of the phone, but three pointer
gestures a person uses every day at 390 have no walk at all — the edge swipe back, the row swipe and the
long-press drag. The plan says it in as many words: `docs/plans/2026-11-14-ux-unification.md` §3 records that
the walks never simulate pointer gestures ("walk 不模拟指针手势"), and the drag order that already shipped
(#205) is proven by unit tests only. The file deep link has the same hole:
`/tasks/:id?panel=files&file=<path>` exists and has DOM tests, but no walk opens it on the phone and presses
Back, so a regression there is invisible to the gate. And the acceptance ledger underclaims:
`docs/product/stories/COVERAGE.md` is 12 `approved` / 4 `covered`, while the merged J5/J2/J8 walks already
assert three of those approved stories step by step. Closing these four gaps uses the walker and the throwaway
daemon that already exist — no new product surface, no schema, no endpoint.

**Done means** (throwaway daemon with the fake agent; each item names what proves it):
1. The phone's three pointer gestures are walked at 390 with real pointer events (a new J12 — J9–J11 are
   already the switch and notification walks): the edge swipe back follows the finger and returns to the
   list with its search and scroll intact; a row swipe opens its actions and closes without navigating; a
   long-press drag lifts the row, moves it, and the order survives a reload. A mutant that removes the
   gesture handler turns J12 red, and any defect the walk exposes is fixed in the same delivery.
2. KIN-RESULT-002's phone legs are walked: `/tasks/:id?panel=files&file=<path>` opens the source file,
   preview / source switches, and Back returns to the list or conversation with the pane state intact; the
   story flips to `covered` in `registry.json` with `COVERAGE.md` regenerated in the same PR.
3. The stories a merged walk already proves flip to `covered`, each naming the walk step that asserts it:
   KIN-MANAGE-001 (J5, the row-actions menu), KIN-RESULT-001 (J2/J8, the diff view) and KIN-RESULT-003
   (J2/J8, the line comment sent back to the conversation). A flip with no walk step is refused.

**Cut rule.** If item 1 is not green by the target, land it alone, keep 2–3 queued, and say so in the weekly
retro. Do not extend the date.

**Out of scope** — the parked rows stay parked on Ethan: F3 in-app PR writes (credential and permission
model), the browser panel tab (Electron `webview` ADR), the agent catalog cut 74 → ≤10, and queue rows 9
`R-steer-native`, 10 `R-queue-reorder`, 13 `R-routine-filter`, 15 `R-at-sessions`.

## Closed phase (P8) — 把签过字的承诺结算成事实
<!-- closed-phase: P8-settled-ledger target=2026-11-21T20:00 -->

Closed 2026-11-19, all four items landed: item 1 `b701c37b` (#333 PROJECT-002's 添加目录 and 移除
pressed at 390 and 1100), item 2 `c42a08ee` (#331 the four defaults reaching a new chat) and
`d8ff66c4` (#339 the settings walk), item 3 `3c45ab51` (#341 KIN-CONTINUE-002 at 390), item 4
`2a6eaa9e` (#342 KIN-CONTINUE-001's four sentences). The ledger is `approved 2 · covered 14`; the two
approved rows are KIN-NOTIFY-001 and KIN-SETTINGS-002, both waiting on Ethan. P8 closed two days
early; the target date is unchanged.

**Why this and not features.** The ledger says 8 `approved` / 8 `covered`, and the label now means
"nobody has checked" rather than "not built". Three facts from this week measure the gap. `KIN-PROJECT-002`'s
folder block shipped in #296 and its J4 walk already proved default → save → return, yet #315 deliberately
kept it `approved`, because the two verbs its acceptance names — 添加目录 and 移除 — were never pressed in a
real browser. `KIN-SETTINGS-001` promises four defaults (agent / 模型 / 设备 / 权限); the settings tabs
(通用 / Agents / Providers / 路由 / 高级) already ship, but the server settings store holds only
`agent.default` (`internal/server/server.go:343`); the other three are client-side keys (`kin_draft_model` /
`kin_draft_machine` in `ui/src/lib/draftChat.ts`, `kin_permission_mode` in `ui/src/lib/permissionMode.ts`)
that `NewChatPage` seeds a new chat from, and the sentence the story asks for —
"下一次新建对话会用上" — has no string in either locale. `KIN-CONTINUE-001` and `-002` each carry a walk in
J1/J2, but not the specific sentences they are made of. The gate runs tests; it does not run promises, so
these four stories stay `approved` forever unless someone walks the sentences themselves. Every item below
uses the walker, the throwaway daemon and the fake agent that already exist, and whatever a walk proves
false is fixed in the same delivery.

**Done means** (throwaway daemon with the fake agent; each item names what proves it):
1. `KIN-PROJECT-002` closes the two verbs #315 named: the J4 leg presses 添加目录 and 移除 at 390 and 1100,
   reads the confirm, saves, leaves and returns to the same order and default; the story flips to `covered`
   naming that step, and `COVERAGE.md` is regenerated in the same PR.
2. `KIN-SETTINGS-001` is settled field by field: for each of the four defaults, a walk changes it in
   settings, opens a new chat and asserts the new value arrived (or the field does not exist — say which, in
   the story, rather than inventing a surface). The row says what it affects in zh and en, and a failed read
   keeps the saved value instead of showing an empty form. A default that needs a new stored key is reported
   with its smallest additive shape before it is built.
3. `KIN-CONTINUE-002` is walked at 390: the document holds exactly one list (no drawer, no dock, no second
   copy), and Back from a conversation restores the search word and the scroll offset; the flip names the
   step.
4. `KIN-CONTINUE-001` is walked on four sentences: switching conversations leaves the shell and the composer
   nodes un-rebuilt (no full-page skeleton); a cold start at `/` on Mac returns to the last conversation,
   while at 390 it lands on the list (`KIN-CONTINUE-002` step 1); the phone list is 设备 → 项目 → 对话,
   and ⌘K lists actions and places but no conversation rows. Anything false is fixed in the same delivery.

**Cut rule.** At 11-21 20:00 land whatever is green, queue the rest with the reason, and do not extend the
number. The date assumes P7 closes by 11-19; if P7 lands on its own deadline (11-23), re-state this date when the
marker flips rather than carrying one that already passed. A flip with no walk step or test named is refused,
exactly as in P7 item 3.

**Out of scope** — `KIN-NOTIFY-001` (its last acceptance row needs a real iPhone), `KIN-SETTINGS-002` (needs
a packaged build), `KIN-CONTINUE-003` (its own surface; after P9), and every parked row above.

## Closed phase (P10) — 打开就要快
<!-- closed-phase: P10-open-fast target=2026-11-23T20:00 -->

Closed 2026-11-20, all three items landed: item 1 (`R-startup-handshake`) `903f3b5c` (#417) — health is
probed before `kin version` starts and a spawned daemon is polled at 50 ms, the handshake edge at a **595 ms**
median; item 2 (`R-window-before-daemon`) `b47032f1` (#418) — `window-ready-to-show` precedes
`sidecar-ready` in every run, the shell's own boot surface is what the person sees first, and the settled
console is captured as `rsi/state/shots/settled-console-shots/console-1100x760.png` and `console-390x844.png`
(`71f1d77b`, #425); item 3 (`R-remeasure`) `7e3776e0` (#420) — the desktop table was re-measured on `main`
with the load average, recorded as §「2026-11-20 — the window paints first」 of
`docs/plans/2026-11-19-startup-baseline.md`. Two related rows landed in the same window: `9a64408a` (#421)
took up the `engine-build` row P10 put out of scope (`engine-build` 188/190 → 0/0 ms, total-to-healthy
242/201 ms), and `ad009bef` (#423) drew the iOS wait cue on the shell and console splash. P10 closed early;
its target date is unchanged.

**Why this and not features.** Ethan's own report (「启动巨慢」, `rsi/state/dogfood/dogfood-20261118-four-defects.md`
D1) is finally a number, and it is the first thing every dogfood meets. The 2026-11-19 baseline
(`docs/plans/2026-11-19-startup-baseline.md`) measured the daemon at **407 ms** to healthy but the desktop window
at a median **2777 ms** to first paint, and **1552 ms** of that gap was the shell's own
`sidecar-start → sidecar-ready` handshake — longer than the daemon it was waiting for. The pre-daemon steps were
serial: `sidecar.ts` awaited a whole `kin version` process before its first health probe and polled every 250 ms;
#417 (`903f3b5c`) probes health first, starts the label beside it, and polls a spawned daemon at 50 ms, and the
2026-11-20 re-measure puts that edge at a **595 ms** median. P1–P9 never touched this path because no walk can
see it: the window is simply absent.

**Done means**
1. The handshake stops costing more than the daemon: no process spawn (`kin version`) is awaited in front of the
   health probe, the spawn wait polls at ≤50 ms, and the post-health version read starts as soon as health answers.
   Proven by behavioural tests on an injected handshake (not source strings) plus a mutant that restores the old
   order and turns them red, and measured by `./scripts/desktop-startup.sh --runs 3` before and after in the same
   session: `sidecar-start → sidecar-ready` median ≤ 700 ms on a quiet machine, with the load average recorded.
2. The window paints before the daemon answers: `window-ready-to-show` precedes `sidecar-ready`, the shell's own
   boot surface is what the person sees (never an Electron error page, never a blank frame), and the console
   replaces it once health answers without a second `window-first-load`. 390/1100 shots of the boot surface and of
   the settled console.
3. The number is reproducible from `main` by one command: the doc's stale "Until slice `-d` lands" lines are
   replaced by the current recipe, and its desktop table is re-measured on `main` with the load average rather than
   carried over from a branch.

**Out of scope** — the packaged `.dmg`/asar boot (the dev shell is what is measured), renderer hydration after
`did-finish-load`, the daemon's `engine-build` phase (207/226 ms; its own row after this phase), the phone, and
anything that starts a second daemon or opens `~/.kin`.

**Cut rule.** At 11-23 20:00 land what is green, queue the rest with the reason, and do not extend the date. If
item 2 is not green by then, land item 1 alone with its measured floor: it is the edge that costs the most, and
item 2 inherits whatever headroom it leaves.

## Closed phase (P11) — 控制台接管
<!-- closed-phase: P11-console-ready target=2026-11-24T20:00 -->

Closed 2026-11-20, all three items landed: item 1 (`R-console-interactive`) `890c15dd` (#427) — the
`console-interactive` mark is stamped on the shell's clock after the console's first commit, and the
re-measure puts the console usable **1113 ms** after launch, **155 ms** after `sidecar-ready` and **44 ms**
after `window-first-load` (3 runs, load recorded); item 2 (`R-console-handover`) `e62efa31` (#431) — the
pre-render account probe is bounded at `PRE_RENDER_DEADLINE_MS = 1500`, with the never-answers path proven in
a real browser at 390×844 and 1100×760; item 3 (`R-p11-reproduce`) `78ead790` (#436) — the number is one
command with no prior build step, `./scripts/desktop-startup.sh --runs 3 --json`, and the doc names what it
does not prove. P11 closed early; its target date is unchanged.

**Why this and not features.** P10 made the edge a person can see from outside the window cheap: the window
paints its own boot surface at a **555 ms** median and the daemon answers at a **1192 ms** median, both measured
on `b47032f1` (§「2026-11-20 — the window paints first」 of `docs/plans/2026-11-19-startup-baseline.md`). But the
console that replaces that surface finishes loading at a **1329 ms** median (`window-first-load`), and **nothing
measures when it can be used**. The same doc's "What this does not measure" paragraph says so: "renderer
parse/script time beyond `did-finish-load` (no CDP first-contentful-paint)". `ui/src/main.tsx:160-196` awaits
the auth probe before `createRoot().render()`, so "load finished" is not "usable", and until the probe resolves
the person still sees the static splash in `ui/index.html:81-82`. That is the last unmeasured edge of
「启动巨慢」, and every later fix needs its number.

**Done means**
1. The console's first usable moment is measured: one `console-interactive` mark through the existing
   `[kin-desktop] trace` channel, stamped on the shell's clock, emitted by the console document only after its
   first screen commits and at most once per launch; the runner gains it in its wait set — `console-interactive`
   added to `REQUIRED` (or an equivalent per-mark wait), so a run that never emits it fails instead of reporting
   a shorter table; `./scripts/desktop-startup.sh --runs 3` reports it while every existing mark keeps its
   meaning; a mutant that fires it early (or never) turns its test red; the `console-interactive − sidecar-ready`
   gap is recorded with the load average.
2. The handover is bounded and honest: the bound comes from item 1's number and is written down before the
   fix; the splash is never replaced by a blank frame or by an error a retry would clear; the fix re-measures
   in the same session, and 390/1100 shots show splash → console.
3. The number is reproducible from `main` by one command, and the doc names what it does not prove (the dev
   shell rather than the packaged `.dmg`, the renderer→shell IPC hop, "interactive" ≠ data loaded, the phone
   webview measured separately).

**Out of scope** — the packaged `.dmg`/asar boot; the daemon's remaining boot (242/201 ms to healthy after
`9a64408a`, `docs/plans/2026-11-20-engine-build.md`; its own row only if a number demands it); the phone
webview's first load (same console, separate measure); F4 switch latency (measured, not this phase); every
parked row in `rsi/state/STATUS.md`.

**Cut rule.** At 11-24 20:00 land what is green and queue the rest with its reason; do not extend the date. If
item 1 is not green by then, land it alone — the number is what every later fix is judged against.

## Closed phase (P12) — 切换要跟手
<!-- closed-phase: P12-switch-feel target=2026-11-26T20:00 -->

Closed 2026-11-20, all three items landed: item 1 — attribution: `520d32ee` (#444); the same run splits
`mac-area-to-area` p50 **81.6 ms** into dispatch **1.8**, projects read **1.3**, render-after-answer **78.6**
(total p90 **135.9**; render p90 **133.1**, max **160.9**), so the tail was the render, not the fetch
(`docs/plans/2026-11-20-switch-latency.md` table 2). Items 2–3 — the cut: `596b493f` (#445);
`mac-area-to-area` p90 **157.8 → 66.0 ms**, p50 **61.9 → 63.9 ms** (load 11.5 vs 23.3), bar met
(`63.9 ≤ 57.1 + 15`; `66.0 ≤ 1.25 × 63.9`), 390/1100 before/after shots in the PR body; the remaining ~60 ms
is the area route transition and page mount, named, not hidden. P12 closed early; its target date is unchanged.

**Why this and not features.** F4 is the one flow that is measured but not yet felt. On a warm console at
`71f1d77b`, `docs/plans/2026-11-20-switch-latency.md` times click → the destination's own content on the real
console, 10 runs per leg, with three guards that exit 2 instead of producing a number. The worst leg is
`mac-area-to-area`: p50 **99.2 ms**, p90 **150.8 ms** (range 64.9–155), against `mac-chat-to-chat` p50
**56.2 ms** and the phone leg 64.3 ms. The doc does not attribute the spread — "a cached task row, a faster
fetch, or frame alignment would all look like this" — and the owner's question ("is 99 ms 涩?") is still open.
The switch doc closes with exactly this hand-off ("this document is the baseline the next switch phase opens
from"), and P11 listed F4 switch latency as "measured, not this phase" in its Out of scope. The measurement was
the point; there is one now.

**Done means**
1. The spread is attributed, not guessed: the same script reports, per run on the page clock, how much of
   `mac-area-to-area` is the projects read and how much is the render after it answers, and the plan doc gains
   that split with the load average; a run that cannot attribute says so instead of reporting a number it did
   not measure.
2. The worst leg is cut with a before/after in one session: `mac-area-to-area` p50 lands within **15 ms** of
   the `mac-chat-to-chat` p50 measured in the same invocation, and its p90 is at most **1.25×** its own p50;
   guards (a) `destination-never-appeared`, (b) `shell-rebuilt` and (c) `splash-blank-or-error` still exit 2
   on `--break-target`, `--break-shell`, `--break-splash`, `--break-alert` and `--break-blank`, and the
   measured leg trips none of them.
3. The person's question is answerable from the branch: 390×844 and 1100×760 shots of a projects switch
   before/after and one "what the user sees now" sentence; if the bar is not reached by the target, the doc
   names the mechanism that is left and why, rather than moving the bar.

**Out of scope** — the phone→Hub→Mac network route (every number is loopback); the packaged `.dmg`/asar shell;
the daemon's boot; the reverse and alternating legs beyond what item 1 needs to attribute the forward leg;
every parked row in `rsi/state/STATUS.md`.

**Cut rule.** At 11-26 20:00 land what is green and queue the rest with its reason; do not extend the date. If
item 2 is not green, land item 1 and record the remaining mechanism with its number — a switch that explains
itself is what the next fix is judged against.

## Closed phase (P13) — 排队顺序归人
<!-- closed-phase: P13-queue-order target=2026-11-28T20:00 -->

Closed 2026-11-21, both items landed: item 1's daemon half `c9cb8ef8` (#448) — the ordered `position` column
and `PUT /api/tasks/{id}/prompts/order`, merged on the owner's 2026-11-20 18:25 authorization (the `hold` was
cleared by that decision, not bypassed) — and item 2 `c6939be4` (#478), the console's numbered rows and ‹ ›
controls (23/23 DOM tests, 13/13 mutants red; its 1110-line diff merged under the 2026-11-20 23:32 size waiver).
A person now reorders queued prompts and the agent answers in that order; P13 does not prove cross-device order
sync or reordering already-delivered turns (its Out of scope). P13 closed early; its target date is unchanged.

**Why this and not features.** The queue is the only way a second instruction reaches a running task, and the
person cannot change which one the agent answers next: delivery is `ORDER BY id ASC` in both the list and the
pop (`internal/store/pending_prompts.go:152`, `:185`), and the only edit is withdraw-and-retype
(`ui/src/lib/queuedPrompts.ts:123-138`). ADR 0033 (`docs/adr/0033-queued-prompt-order.md`, accepted 2026-11-20)
decided the order lives where the pop reads it: an additive `position` column, a `PUT` order route, and a
whole-queue `200` answer. The daemon half is PR #448; per MANDATE (migration + route) it is **held for Ethan**,
and the console half cannot start until it merges.

**Done means**
1. The order is the daemon's, not the screen's: `position` is written by one transactional setter, both the list
   and the pop read `position ASC, id ASC`, the `PUT /api/tasks/{id}/prompts/order` contract is the one in
   ADR 0033 (`200` = whole queue in the new order; `400` malformed/duplicate/non-positive; `404` = unknown task
   only; `409` = the ids are not exactly the current queue), OpenAPI and the generated client types carry it, and
   a populated v49 database upgrades with its old id order intact. Evidence: store + api behavioural tests, and
   mutants that put back `ORDER BY id` in each read turn red. **This item is #448 and lands only after Ethan
   approves the migration + route** (MANDATE).
2. A person can move a queued prompt up or down and the agent answers next in that order: the console re-reads
   the daemon's queue after the write and renders the daemon's order (never a local-only reorder), a stale list
   gets `409` → refetch + one honest sentence, the control is reachable and operable by keyboard, both locale
   files are updated, 390/1100 shots show the moved row and the following delivery, and a DOM test plus a
   mutant that reorders only locally turns red. No new event type; the existing poll + re-read is the
   convergence path.
3. One "what the user sees now" sentence with the queue length and the order the agent actually answered in, and
   the phase names what it does not prove: cross-device order sync and reordering already-delivered messages.

**Out of scope** — syncing the order between devices; reordering delivered/done turns; editing a queued message's
text (the pencil stays withdraw-and-refill); hiding ended routine runs; any queue UI redesign; new event types.

**Cut rule.** At 11-28 20:00 land what is green and queue the rest with its reason; do not extend the date. If
Ethan has not approved item 1 by then, record the block in that item's own line and do not start item 2 — a
console affordance over a route that does not exist would be a lie; do not merge the migration without his
approval to hit the date.

## Closed phase (P14) — 开屏必须有界，并能自愈
<!-- closed-phase: P14-boot-guard target=2026-11-22T20:00 -->

Closed 2026-11-21, `57abd128` (#482) merged 01:04. The splash is bounded: 12 s without a React mount reloads
once automatically, and the second deadline stops retrying and shows a visible, focused 「重新加载」 button —
the bound the 1.9 MB entry chunk and the 2026-11-20 tunnel stall (74 KB in 20 s, then nothing) needed.
`ui/src/bootGuard.dom.test.ts` names all 8 tests for the defect, and `ui/src/bootGuard.mutants.json`'s 3 mutants
(the mounted handover, the deadline, the second-state degradation) each turn the suite red. P14 does not prove a
first launch that waits on a slow but eventually complete download; the cold download is still in the start path,
and moving it out is P15's job.

**Why this and not features.** On 2026-11-20 10:21 EST the owner's phone panel sat on the splash wheel and had
to be force-quit twice. The measurement put the cause in two places: the first launch after a release downloads
the 1.9 MB entry chunk (the same file returned complete in 49 ms over the LAN, but the first tunnel attempt
received 74 KB in 20 s and stalled; the next three took 2.9–5.3 s), and `ui/index.html:82`'s splash is replaced
only by React's first render (`ui/src/main.tsx:179`), so a chunk that never executes leaves a wheel with no
timeout, no retry and no error surface. Bounding it is cheap and does not depend on the structural change.

**Done means**
1. A boot surface can never become a permanent wheel: 12 s without a React mount reloads once, a second failure
   shows a visible 「重新加载」 control that works after the network returns, and the first paint has no
   skeleton or blank frame (Watch 67).
2. Evidence: a test named for the defect plus a mutant that removes the retry or the visible control turns red;
   the 390 shell shows the control; the tunnel number above is quoted in the PR body as what the bound is for.
3. One "what the user sees now" sentence, and the phase names what it does not prove: a first launch that
   waits on a slow but eventually complete download.

**Out of scope** — moving the cold download out of the start path (that is P15); the native/RN rewrite
(DECISIONS 2026-11-20 23:47); route-level lazy splitting of `App.tsx` (collides with F1/F4's no-skeleton rule);
the desktop boot surface (settled in P10/P11).

**Cut rule.** At 11-22 20:00 land what is green and record the rest with its measure; do not extend the date. If
the tunnel-stall replay cannot be reproduced on the field, record what the unit test and mutant prove and park
the field proof as a followup — never report an unreplayed stall as verified.

## Parked phase (P15) — 手机先开包里的控制台，新版本后台整套换
<!-- closed-phase: P15-bundled-console target=2026-11-30T20:00 -->

**Parked 2026-11-21 (CEO, option ③).** The story is `blocked` and there is no current phase: the measured
benefit is at most 3.7 s (`docs/plans/2026-11-21-phone-console-baseline.md`), the failure it was meant to cover
is already bounded by P14 (#482), and its precondition (a Hub CORS allow-list or a Swift bridge) changes a
permission boundary for that 3.7 s. The design below is kept as the record; a future phase starts from a defect
the owner names, a dogfood finding, or his explicit ask to revive this one (`gh pr reopen 495` or a new story).

**Why this and not features.** P14 bounds the wheel but leaves the cold download in the start path. The phone
app already ships a console (`mobile/capacitor.config.ts:50` `webDir: "../web/dist"`), yet uses it only as a
fallback after a stored Hub fails (`:22-23`). One constraint must be settled first: `mobile/capacitor.config.ts:8-12`
records that the console signs in with a cookie and that the cookie and the relative `/api` calls are first-party
only when the page is loaded from the Hub origin, so a bundled copy served from the app's own origin has no Hub
session yet — the story has to settle how the bundled baseline reaches the Hub session/API, with an ADR if that
changes the auth semantics. The structural fix is to make that bundled copy the baseline and
treat the Hub's console as an update: verify a complete new set in the background, swap it in atomically, and
keep the previous complete version. This is the B half of the owner's 2026-11-20 defect; it needs a signed
story before any `ui/`/`mobile/` code.

**Done means**
1. `KIN-CONTINUE-006` exists with its contract, 6 frames, registry row and the one `IA.md` line, and is signed
   only after its review page (`R-continue-006-review`) exists and has been read.
2. The phone opens on the bundled console and is usable before any Hub download; the Hub's newer console is
   verified as a whole set (version, minimum Hub API compatibility, byte integrity) and swapped in atomically;
   the previous complete version still opens; a partial or mixed set is never switched in.
3. A stalled download, a partial set, a Hub answering 500, no network at all, and a Hub older than the app each
   show one honest sentence and a next action — never a wheel.
4. Evidence: tests named `KIN-CONTINUE-006`, a mutant that switches before the whole set verifies turns red,
   390 shots, and the story resolves the collision with the existing updater (`ui/src/main.tsx:104`
   `watchConsoleVersion`) instead of leaving two competing switchers.

**Out of scope** — the native/RN rewrite (DECISIONS 2026-11-20 23:47); the desktop shell upgrade (P10/P11;
`KIN-SETTINGS-002`); the queue order UI (P13); PWA re-deploy semantics; route-level lazy splitting.

**Cut rule.** At 11-30 20:00 land what is green and queue the rest with its reason; do not extend the date. If
the story is not signed by 11-24, record the block and do not start `ui/`/`mobile/` code — the contract itself
is the deliverable, and a console swap without a signed contract is a second updater nobody decided on.

## Closed phase (P9) — 把评审读进来，不用回 GitHub
<!-- closed-phase: P9-review-in-place target=2026-11-25T20:00 -->

Closed 2026-11-20, all three items landed: item 1's ADR `d2e621ba` (#347); the column it decided, `283e70ba` (#352,
owner-approved before merge — the `needs-ceo` stop was cleared, not bypassed), with
`pr_observations.reviews` at `internal/store/migrate.go:844` and ordered migration 049 at `:2678-2705`;
and the read half `301d345f` (#368) that fills it; `api/openapi.yaml:6810` documents `reviews` next to
`ci_summary`. The panel half is on `main` too — `3d60898b` (#375) renders the cached reviews via
`parseReviews` (`ui/src/lib/prObservation.ts:73`) in `ui/src/components/pr/PullRequestPanel.tsx:508` — and
#375 names item 3's evidence seam.

**Why this and not features.** P7/P8 settled the ledger: `KIN-CONTINUE-003` was covered by `d929cfa5` (#348),
and the only two `approved` rows are the ones that need Ethan (`KIN-NOTIFY-001`, `KIN-SETTINGS-002`), and
the one read a person still leaves the app for — on the flow where T3 Code is
strongest — is the review itself. The PR panel already names up to three failing checks (`ciLabel`,
`ui/src/lib/prObservation.ts:247`, fed by `ci_summary` end to end), and it has no author, no state and no body
for the reviews the same pull request carries, so "is this review asking me for something?" is answered on
GitHub, not in the conversation that produced the change.

**Done means** (evidence per item 3; the walk alone cannot prove this):
1. A decided, additive shape for the reviews the panel may read: an ADR that names one column on
   `pr_observations` (`internal/store/pr_observations.go`, table in `internal/store/migrate.go`) holding the
   reviews as JSON — author, state, body — written by the same explicit refresh that writes `ci_summary`, plus
   the ordered migration and both database tests AGENTS.md requires. **This half is delivered**: the owner
   approved the column before merge; it landed as `283e70ba` (#352, `pr_observations.reviews`, migration 049).
2. Once that column exists (or Ethan answers with a different shape), the panel renders each review's author,
   state and body from the cached snapshot, and keeps the failing-check names it already shows. A snapshot the
   panel cannot read says so in one line instead of looking empty. The reviews come from the same cached
   snapshot, so rendering them adds no GitHub call of its own; the one first-look query a never-checked branch
   already gets on open stays as it is. `api/openapi.yaml` documents the additive field next to `ci_summary`.
3. Evidence, named before the work starts: the walk cannot prove this today — `J2.json:68` asserts the
   "not in a GitHub repository" state and `journeys_seed.py` is API-only, so there is no seeded observation with
   a review. The PR says which seam it used (a dev-only seed route, or a DOM suite on the panel plus a Go test
   on the snapshot) and why that proves the same thing; faking it inside the walk is not allowed.

**Mechanism rows (rent, not phase items).** Both delivered 2026-11-19; do not re-derive.
The two 2026-11-19 follow-ups are **done** and must not be re-derived: the walk-mutant restore runs on
TERM/HUP/INT (`rsi/runtime/ux/walk-mutant-test.sh` `trap_restore_dist`, plus `scripts/mutants.py`'s signal
handler from #338) and a merge archives its sendback (#346 `6ea5b433`).

1. **The escalation ledger cannot say what it bought.** `c00f66fe` (#357): `review_note` records blocker/major
   lines (`rsi/runtime/dispatch.sh:136`); `f66b4144` (#360): `escalate.py:832` prints `Worth it: caught N of M` weekly.
2. **A number a person typed drifts.** `4640d9b3` (#356): `plan_status_prefix` writes `PLAN.md`'s `状态：…`
   count sentence from the registry; `--check` fails on drift (`plan_problems`, `scripts/stories.py:294`).

**Cut rule.** At 11-25 20:00 land what is green and queue the rest with its reason. The schema question is
settled — the column, the read half and the panel half are all on `main` — so nothing in P9 is still
queued; the registry is green (`python3 scripts/stories.py --check`: `16 (approved 2, covered 14)`, `ok`).
Do not extend the date.

**Out of scope** — `KIN-CONTINUE-003` (covered by `d929cfa5`; no longer a phase), PDF and Office preview (every
in-app path crosses a decided boundary: `internal/api/secure.go` sets
`object-src 'none'` with no `frame-src`, a PDF parser is a new dependency, and `window.open(blob:)` is denied by
`desktop/src/window.ts` and would land in the OS browser with an unresolvable URL — one ADR, then one PR), queue
reordering (needs a queue-order endpoint), 清空已结束 (needs a DELETE plus ADR), native steer (an agent
capability), the browser panel (`webview` ADR), `KIN-NOTIFY-001` and `KIN-SETTINGS-002` (Ethan), and every parked
row above.

## Closed phase (P5) — projects you can manage, not just open
<!-- closed-phase: P5-projects-manage target=2026-11-23T20:00 -->

Closed 2026-11-18, all three items landed: item 1 `a1e18155` (#296 — every root in saved order with 默认 on the
first; the editor adds, removes and re-defaults through one `PATCH {roots}`; Mac Popover, phone bottom sheet),
item 2 the same PR (the registry flipped to `approved` with its three registered tests), item 3 the same PR
(one root → cwd, several → picker; `KIN-PROJECT-002 the new-chat target follows the first root after a saved
reorder`). A saved order survives a reload: `SetProjectRoots` deletes and re-inserts, `listProjectRoots` reads
`ORDER BY rowid` (`TestProjectRootsKeepSavedOrder`). P5 closed five days early; the target date is unchanged.

**Why this and not features.** P4 proved the last two daily flows. The next most-used surface with no
management face is the project: `Project.roots` and `PATCH /api/projects/:id {roots}` already exist and
`SetProjectRoots` replaces the whole ordered list, but the cover renders `roots[0]` only — a project made
of several directories looks like a project with one, the default is invisible, and there is no way to
add, remove or re-order directories without calling the API by hand. The signed `KIN-PROJECT-002`
(2026-11-18) is the first story; parity §7 names it, and KIN-PROJECT-001 D2 keeps it inline, with no new
tab and no route change.

**Done means** (throwaway daemon with the fake agent; each item names what proves it):
1. KIN-PROJECT-002 delivered: the Mac cover lists every root in order with the first badged 默认, and the
   edit sheet adds / removes / promotes a root through one `PATCH {roots}` (replace-whole-list), with the
   loading, empty, one, many, saving, failure+retry and offline/read-only states the signed frames draw;
   390/1100 shots.
2. The phone cover and bottom sheet do the same at 390 (44px targets, paths wrap, no horizontal scroll),
   and the first delivery flips `KIN-PROJECT-002` to `approved` with its registered tests in the same PR.
3. The new-chat landing follows the saved first root (single root → cwd, multiple roots → directory
   picker), proven by `ui/src/lib/projectChats.test.ts`.

**Cut rule.** If item 1 is not green by the target, land it alone, keep 2–3 queued, and say so in the
weekly retro. Do not extend the date.

**Out of scope** — §6 MCP config face (needs a security pass; OAuth deferred) and per-project
instructions (prompt-first, needs its own story); the P4 parked rows (F3 in-app PR writes, browser panel
tab, agent catalog cut) stay parked on Ethan.

## Closing phase (P2) — mid-run control made real
<!-- closing-phase: P2-midrun-control target=2026-11-19T20:00 -->

Closed 2026-11-18, all three items landed: item 1 `7b0f6679` (#264), item 2 `305c5196` (#269, Stop ends the
round and accounts for its queue), item 3 `2838fc82` (#270, the contract negatives now run in `check.sh`).

**Why this and not features.** P1 closed the journeys that prove a person can start a chat, approve and
come back (#245 real send, #249 approve/deny, #251 deep link, #254 the mutant). The next most-used path has
no such proof: F2 mid-run control. The composer already carries the queue-vs-interrupt rule
(`TaskDetailPage.onComposer`, `interrupt: true`) and the fake agent can hold a turn open (`[seed] slow`,
`RSI_FAKE_SLOW_SECS`), yet nothing asserts that a message sent while the agent runs appears at once, that
the honest queued/interrupted copy is the one a person actually sees in the walk (the DOM tests cover the
copy itself), or that an explicit stop really ends
the run. A wrong answer here is the defect people notice first — a message that vanishes, or a node that
keeps "running" after Stop.

**Done means** (throwaway daemon with the fake agent; walker/seed PRs touch no `ui/` file, so `ux-gate.sh`
does not run on them — item 3's mutant is their verification):
1. A second message sent while the first turn is still open (`RSI_FAKE_SLOW_SECS=10`) renders in the
transcript before the first answer, and the walk matches the honest copy the composer emits (queued vs
interrupted+requeued) instead of trusting the source to contain it.
2. Stop ends the run: the task leaves `running` (row and header agree), the transcript shows the end
state, and a follow-up sent during the hold is either delivered or visibly cancelled — never dropped
silently. 390/1100 shots of the queued and stopped frames are stored.
3. A mutant is the proof, not a green run: removing the follow-up dispatch (or the `interrupt` flag) turns
the J3 walk (extended for the mid-run send) red with the detail GET held — the same surface #254 uses,
since a fast localhost keeps the default walk green — and `--check-spec` negatives run in `scripts/check.sh`
so weakening that J3 prompt-wait rule is red without a browser.

**Cut rule.** If item 1 is not green by the target, land 1 alone (it is the lost-message path and the one
that catches the most), keep 2–3 queued, and say so in the weekly retro. Do not extend the date.

## Closed phase (P1) — make the walk real
<!-- closed-phase: P1-walk-real target=2026-11-18T20:00 -->

Closed 2026-11-18, all four items landed: #245 `89d9c656` (J3 sends for real), #249 `e64b43f0` (J1
approve + deny), #251 `77ff0b77` (J7 deep link + Back), #254 `9d34c20e` (the mutant that turns the J3 walk
red with the task-detail GET held).

**Why it was the phase and not features.** The Astryx programme was done (62/62) and the console passed a
journey *walk*, but that walk never sent a message, never asserted an approve/deny result, and J7 landed
on a route nobody seeded. So the gate that was supposed to prove "a person can finish this" only proved
"the page renders". Every visible defect caught that week (a centred row, two names for one conversation,
a blank deep link) was caught by a human eye, not by the gate.

**Delivered** (throwaway daemon with the fake agent from `scripts/journeys_seed.py`; #245/#249 touched no
`ui/` file, so `ux-gate.sh` did not run on them — item 4's mutant was their verification):
1. J3 pressed Send for real: the composer emptied, the pending bubble + waiting row appeared **and
   stayed** across `/new` → `/tasks/:id`, the fake agent's reply rendered, 390/1100 shots stored (#245).
2. J1 opened the seeded conversation holding a real approval card, approved it (`gone` asserted), and
   denying was captured as well (#249).
3. J7 deep-linked to a seeded item and landed on that card, then Back returned to it (#251).
4. The J3 walk went red with the detail GET held when the pending-send handoff was removed
   (`walk-mutant-test.sh`, #254); the default walk on a fast localhost stays green, which is why the
   always-on guard is the `--check-spec` negative pair, not the walk.

## Cadence and urgency (mechanism, not vibes)
- **Every phase carries a date and a cut rule** in this file. No undated phase; if a phase has no
  date, the CEO writes one before the next lane is claimed.
- **Every patrol quotes `python3 rsi/runtime/pace.py`** — merges/24h, open→merge p50/p90, unshipped
  vs the release threshold, hours left in the phase — and says ahead or behind in one line.
- **Behind = a decision, not a push.** Two consecutive patrols whose `pace.py` line says BEHIND means
  cut scope or write `needs-ceo.md` with the trade-off; never "work harder" — `pace.py` is the one
  rate authority.
- **Stop the line for product defects.** A reproduced P0 on F1/F2/F5 (lost message, stuck approval,
  blank deep link) outranks any refactor in the queue; the CEO may preempt a lane and says why.
- **Refactors pay rent.** A pure refactor only enters the queue when it removes an observed cost
  (repeated gate minutes, repeated review finding, an inventory number that blocks a migration).

## How the loop improves itself
- **One loop change per week must land** via a clean `rsi/loop-guards` PR (merge.sh, lane.sh, prompts,
  roles). A week with zero is a red row in the weekly retro — the loop that only changes the product
  is not self-improving, it is just a conveyor.
- **The retro verifies the previous retro.** Each weekly retro opens with "last week's ≤3
  improvements: landed / dropped (why)" before it proposes new ones. Unverified improvements are
  wishes.
- **Three strikes become a guardrail.** A defect pattern seen three times graduates into a lint rule,
  a ratchet, a test, or a role-card change — never a third prose note. `docs/product/LESSONS.md`
  stays the inbox; guards are the exit.
- **Reviewer quality is measured, not assumed.** `rsi/runtime/reviewer-misses.py` runs from `main`
  and writes the per-reviewer ledger; the CEO demotes a reviewer with two misses in
  `ROUTING.md`, and prefers a reviewer that keeps finding blockers for that tier.
- **The fence moves.** Escalation thresholds, lane counts, budgets and caps live in `MANDATE.md` /
  `DECISIONS.md` with a one-line reversal; anything the loop has outgrown is raised by the CEO with a
  measurement, not by silently raising a limit.
