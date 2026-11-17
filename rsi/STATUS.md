# STATUS (seed — live copy is rsi/state/STATUS.md; keep ≤ 80 lines, last 48h of facts)

Updated: (seed)  Mode: running  NO_MERGE: no

## Queue (top = next; one item per pulse)

| ID | Item | Flow | Source | State |
|---|---|---|---|---|
| Q1 | New chat send → skeleton flash → same message. Seed the created task into the detail page and hand pending sends across the route so `/tasks/:id` frame 1 shows the same bubble + waiting row; restore brand wait on cold deep link only. | F1 | gap-log 2026-11-14 高 (`ui/src/pages/NewChatPage.tsx`, `TaskDetailPage.tsx:~1492`) | ready |
| Q2 | Ratchet + lint: add `ui_inventory` non-increase check and lint bans (new raw `<button>`, `createPortal`, magic `z-[n]`) to `scripts/check.sh`/eslint; baseline from current `main`. | all | AGENTS.md, ux-unification Batch A prelude | ready |
| Q3 | Kin facade primitives `Button`/`Menu`/`Popover` in `ui/src/components/ui/` (no new deps); migrate Composer bottom row (agent/model/permission/dir) so every picker opens the same way (TASTE 14), height stable, popover direction consistent. | F2 | 2026-11-07 dogfood complaint, TASTE 5/13/14 | ready |
| Q4 | Switching chats/projects never shows a full-page skeleton; keep shell and loaded content (TASTE 15). | F4 | TASTE 15, LESSONS | ready |
| Q5 | YOLO session still prompts for approval — find the path, write the failing test first. | F2 | dogfood 2026-11-09; LESSONS 2026-11-09 YOLO first-turn | ready |
| Q6 | UX unification Batch C (conversation + new path on facade). | F1 F4 | ux-unification | after Q3 |
| Q7 | Batch B four-zone shell; Batch D projects+routines; Batch E settings. | F4 F5 | ux-unification | after Q6 |
| Q8 | Steer: probe ACP/agent capability; native steer if supported, else honest interrupt+requeue copy. | F2 | lody-parity gap §3 | research |
| Q9 | Review loop: line-comment → send back to agent; one-button commit/push/PR. | F3 | lody-parity gap §2 | research |
| Q10 | Batch A (React 19 / Tailwind 4 / Astryx behind facade). | all | astryx-spike | after Q6, split by risk |

| P1 | **Make the walk real** (CEO next phase, Ethan 2026-11-17): J3 sends, J1 approves, J7 lands on a seeded item, ux-gate red on regression. | F1 F2 F5 | GOAL.md P1 | ready (top) |

## Last 48h
- (none yet)

## Blocked / needs CEO
- (none)
