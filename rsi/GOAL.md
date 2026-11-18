# GOAL — Kin RSI

**North star:** when Ethan dogfoods Kin in the morning it feels at least as good as T3 Code, and
in places (self-hosted Hub, routines, cost control, phone call-back) better. Every pulse must move one of
the five flows below closer to "passes without a human noticing".

## The five flows (each is judged by what the user sees, not by test counts)

| # | Flow | Pass means |
|---|---|---|
| F1 | New chat → send | Message and waiting row appear instantly and **never vanish**: no full-page skeleton, no blank area, header/title/composer stay mounted across `/new` → `/tasks/:id` (gap-log 2026-11-14 高). |
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

## Current phase (P7) — 手机上没被走查过的三件事
<!-- phase: P7-phone-gestures target=2026-11-23T20:00 -->

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

## Next phase (P8) — 把签过字的承诺结算成事实
<!-- next-phase: P8-settled-ledger target=2026-11-21T20:00 -->

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
a packaged build), `KIN-CONTINUE-003` (its own surface; next phase), and every parked row above.

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
