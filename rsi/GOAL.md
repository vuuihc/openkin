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

## Current phase (P2) — mid-run control made real
<!-- phase: P2-midrun-control target=2026-11-19T20:00 -->

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
the J3/J8 walk red with the detail GET held — the same surface #254 uses, since a fast localhost keeps the
default walk green — and `--check-spec` negatives run in `scripts/check.sh` so weakening the spec itself is
red without a browser.

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

**Delivered** (throwaway daemon with the fake agent from `scripts/journeys_seed.py`; the walker/seed PRs
touched no `ui/` file, so `ux-gate.sh` did not run on them — item 4's mutant was their verification):
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
- **Reviewer quality is measured, not assumed.** `rsi/runtime/reviewer-misses.py` (control-tree local
  until it lands) writes the per-reviewer ledger; the CEO demotes a reviewer with two misses in
  `ROUTING.md`, and prefers a reviewer that keeps finding blockers for that tier.
- **The fence moves.** Escalation thresholds, lane counts, budgets and caps live in `MANDATE.md` /
  `DECISIONS.md` with a one-line reversal; anything the loop has outgrown is raised by the CEO with a
  measurement, not by silently raising a limit.
