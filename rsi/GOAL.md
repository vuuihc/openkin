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
