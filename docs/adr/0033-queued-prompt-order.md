# ADR 0033: Queued Prompt Order Belongs to the Person

**Status:** Accepted as design (CEO, 2026-11-20). The migration + endpoint PR stays open with needs-ceo for Ethan.
**Date:** 2026-11-20
**Related:** `rsi/GOAL.md` P13 (F2 queue feel) · RSI queue row `R-queue-order-adr` · `internal/store/pending_prompts.go:139-146` (`pendingPromptsWatermarkTx`) · `internal/store/pending_prompts.go:150-170` (`ListPendingPrompts`) · `internal/store/pending_prompts.go:171-200` (`PopPendingPrompt`) · `internal/api/task_queue.go:20-28` (`queuedPromptEntry`) · `internal/api/task_queue.go:74-94` (`handleDeleteQueuedPrompt`) · `internal/api/api.go:464-465` (the two prompt routes) · `internal/store/migrate.go:881-894` (`migrationPendingPrompts`) · `internal/store/migrate.go:2320-2336` (migration 039) · `internal/store/migrate.go:3284-3307` (`ensurePendingPromptSchema`) · `internal/task/approvals.go:503-521` (`queuedFollowUp`) · `internal/task/approvals.go:647-648` (`deliverQueued`) · `internal/task/engine.go:3341-3352` (`settlePromptsQueuedDuringFinalization`) · `ui/src/lib/queuedPrompts.ts:33-44` (row ids are never reused) · `ui/src/lib/queuedPrompts.ts:123-138` (`startEdit`, the pencil) · `ui/src/lib/taskOrder.ts:2-12` (manual order overrides the clock) · `ui/src/api/client.ts:1176-1178` (`listQueuedPrompts`) · `ui/src/api/client.ts:1189` (`withdrawQueuedPrompt`) · `ui/src/pages/TaskDetailPage.tsx:562-589` (the queue poll)

## Context

A task that is already running accepts a follow-up instead of refusing it: `queuedFollowUp`
writes the visible message first, then appends the queue row (`internal/task/approvals.go:517-521`), and
the queue is the only way a prompt enters a busy task — "appended at the tail, delivered
from the head, one per turn" (`internal/task/approvals.go:508-510`). The person sees the message in the
conversation immediately, marked as waiting; the row is what says it has not been answered
yet.

**Delivery order is the row id.** Both reads say `ORDER BY id ASC` — the list at
`internal/store/pending_prompts.go:152`, the pop at `internal/store/pending_prompts.go:185` — and the pop is what decides
which message the agent answers next (`deliverQueued`, `internal/task/approvals.go:648`). A reorder that
only changes what the console draws would therefore be a lie: the agent would keep
answering the oldest message while the screen showed the new arrangement. The order has to
live where the pop reads it.

**The one edit today is withdrawal.** `handleDeleteQueuedPrompt` (`internal/api/task_queue.go:74-94`)
removes a row before delivery and writes the transcript note that says it will not be
answered; a 404 means the row already ran or another device took it. The console offers ×,
and a pencil that withdraws and refills the composer (`ui/src/lib/queuedPrompts.ts:123-138`,
`ui/src/api/client.ts:1189`), so the only way to change a queued instruction is to take it back and
retype it — losing its place and making the sender retype a message that was mostly right.

**Ids are identity, not just order.** `pendingPromptsWatermarkTx` reads `COUNT(*), MAX(id)`
inside the caller's transaction (`internal/store/pending_prompts.go:139-146`) so the finalize tail can tell
a message accepted after the transition from one the transaction already named; the settle
path compares `p.ID > reportedThroughID` (`internal/task/engine.go:3351`). The client assumes ids are
never reused: `withoutWithdrawn` keeps a withdrawn id out for the life of the page because
"row ids are never reused" (`ui/src/lib/queuedPrompts.ts:33-44`), and both × and the pencil key on it.
A scheme that renumbers rows breaks a daemon invariant and a client invariant at once.

**The console already converges without a new event type.** It re-reads the queue when
events land and keeps a 3-second poll while the task is not terminal
(`ui/src/pages/TaskDetailPage.tsx:562-589`), replacing the whole list rather than applying a delta. A
reorder changes no transcript event — events do not change once written — so the poll is
the convergence path, and the reorder response itself can carry the whole queue.

**The conversation list already answered the same question.** A person's manual order
overrides recency inside a bucket, and a status change must not undo the hand-placed order
(`ui/src/lib/taskOrder.ts:2-12`). There it is a local preference, so localStorage is enough. Here the
order decides delivery on the daemon, and the sender may be a phone while the node runs
elsewhere, so the order has to be durable on the node.

## Options considered

### (a) An additive `position` column — recommended

Add `position INTEGER NOT NULL DEFAULT 0` to `task_pending_prompts`, and order by
`position ASC, id ASC` in both the list and the pop. New rows append with
`COALESCE(MAX(position), 0) + 1`; the reorder endpoint rewrites positions 1..N in one
transaction.

- **Trade-off:** two keys now describe order, and the insert path must maintain the second
  one. There is one writer (`AppendPendingPrompt`, `internal/store/pending_prompts.go:91`), so that
  maintenance is one statement, and the id tiebreak keeps the order total when positions
  tie.
- Existing rows default to 0 and keep today's id order. The migration changes no behaviour
  by itself; only a reorder does.
- Ids stay stable: the watermark, the settle comparison and the client's row identity are
  untouched.
- Position values are sparse: a pop leaves a hole and nothing renumbers the survivors.
  Every pre-migration row ties at 0, which is why the id is the tiebreak; nothing may read
  `position` as an index.

### (b) Rewrite ids: delete and reinsert in the wanted order — rejected

- **Trade-off:** it needs no schema change, which is its only advantage.
- `pendingPromptsWatermarkTx` uses `MAX(id)` to distinguish new messages from named ones
  (`internal/store/pending_prompts.go:139-146`). Moving ids upward makes every reordered message look
  newer than the finalize watermark, so the settle path would report messages that were
  already named, or deliver them twice.
- Ids are the client's row identity (`ui/src/lib/queuedPrompts.ts:33-44`). A rewrite invalidates the
  withdrawn set, the optimistic rows and any answer that was already in flight.

### (c) Rewrite `queued_at` and order by it — rejected

- **Trade-off:** no new column and no new ordering clause; `queued_at` already exists and
  sorts.
- But `queued_at` is served and documented as when the message was sent
  (`internal/api/task_queue.go:27`, `json:"queued_at"`). Rewriting it to express a preference makes the
  API say something false to every client that reads it as a timestamp.
- Equal millisecond timestamps still need a tiebreak, so the id would remain a second key
  anyway — the same two-key shape as (a), with a lying field added.

**Recommendation: (a).** It is the only option that changes delivery without changing
identity or meaning.

**What would reverse this.** If a delivery path ever bypasses `PopPendingPrompt` (an
agent-side reservation, a second drain), the column would order the display and not the
delivery — the exact lie this ADR refuses — and this decision should be withdrawn until
that path is brought back through the queue. A second writer of `task_pending_prompts`
would reverse it for the same reason: `MAX(position) + 1` is only safe while
`AppendPendingPrompt` is the only insert.

## Endpoint contract (additive)

`PUT /api/tasks/{id}/prompts/order`

Body: `{"ids":[3,1,2]}` — every currently queued id, once, in the wanted delivery order.

- **200** returns the whole reordered queue in the GET shape plus `position`, not a delta.
- **400** for a malformed body or a duplicate/non-positive id — the list cannot be an order
  if an id appears twice.
- **404** for an unknown task, or for an id that is no longer queued because a turn
  boundary took it (the same "not queued" answer DELETE gives).
- **409** when the ids are not a permutation of the current queue: an id is missing, or one
  was never queued. The client refetches; the daemon's queue is the truth.
- **Idempotent:** sending the current order is a no-op 200 and returns the same queue.

Auth is the same as the existing prompt routes; no new scope.

**Live event: none.** A reorder writes no transcript event — the visible message already
exists and its wording does not change — so there is nothing to publish. The console
already reloads the queue on events and every 3 seconds while the task runs
(`ui/src/pages/TaskDetailPage.tsx:562-589`), and the 200 carries the whole queue for the caller. A later
queue event would buy latency for other devices, not correctness, and is not part of this
contract.

**Why the whole queue, not a delta.** An answer that lands after the reader moved on must
be droppable or replace a known state; a delta applied to a queue that changed in between
would compose two orders that never existed. The GET already returns the whole list
(`ui/src/api/client.ts:1176-1178`), and the reorder response matches it.

## Implementation plan (not this PR)

This ADR is documentation only: it creates no column, no route and no UI. The follow-up PR
that implements it stays open with `needs-ceo` for Ethan, because it adds a migration and a
route, and neither is taken on a model's judgement alone.

1. **Migration 050** — the next free version after `schemaVersion = 49` (`internal/store/migrate.go:10`);
   if another migration lands first, this becomes the number after it. Use the `user_seq`
   pattern: add `position` to `migrationPendingPrompts` (`internal/store/migrate.go:881-894`) so fresh
   installs and the migration-039 path produce it, add an `if v == 49` block, and extend
   `ensurePendingPromptSchema` (`internal/store/migrate.go:3284-3307`) to guard both columns with
   `pragma_table_info` + `ALTER TABLE ... ADD COLUMN position INTEGER NOT NULL DEFAULT 0`.
   Every path out of `migrate()` must reach the same shape.
2. **Store** — `SetPendingPromptOrder(ctx, taskID string, ids []int64) ([]PendingPrompt,
   error)` in `pending_prompts.go`, one transaction: read the task's ids, require the same
   set with no duplicates, then write positions 1..N with per-row
   `UPDATE ... WHERE id = ? AND task_id = ?`, and re-read the queue. Per-row updates are
   fine because the queue is what one person typed while one turn ran; if a queue ever
   reaches thousands, one `CASE` update replaces the loop. Change `AppendPendingPrompt`
   (`internal/store/pending_prompts.go:91`) to insert `COALESCE(MAX(position), 0) + 1` in the same
   statement. Change both reads (`internal/store/pending_prompts.go:152`, `internal/store/pending_prompts.go:185`) to
   `ORDER BY position ASC, id ASC`.
3. **API** — add ``Position int64 `json:"position"` `` to `queuedPromptEntry`
   (`internal/api/task_queue.go:20-28`), fill it in the GET, and add `handleUpdateQueuedPromptOrder`
   plus `r.Put("/prompts/order", ...)` beside the two routes at `internal/api/api.go:464-465`. 404/409
   come from typed store errors, not from a second read in the handler (a turn boundary
   can pop between the two). Idempotence falls out of writing the same positions again.
4. **UI** — drag with a pointer, and Alt+↑/↓ for keyboard, matching the convention
   `taskOrder.ts` already uses for the conversation list. Move the row optimistically, send
   the whole id list, and replace the local queue with the response; on 404/409 refetch and
   render the daemon's order rather than keeping the optimistic one. Rows stay keyed on
   `id`; focus follows the moved row and the move is announced.

**Tests the implementation must add:**

- `TestSetPendingPromptOrderPersistsAndPops` (store): after a reorder,
  `ListPendingPrompts` and `PopPendingPrompt` agree; an append after a reorder lands at the
  tail.
- `TestReorderQueuedPromptsRejectsNonPermutation` (api): a missing or extra id answers 409
  and changes nothing.
- `TestReorderQueuedPromptsIdempotent` (api): the current order twice answers 200 twice and
  the queue is unchanged.
- `TaskDetailPage.queueOrder.dom.test.tsx` (UI): a keyboard move sends one PUT and renders
  the response; a 409 refetches instead of keeping the optimistic order.
- Plus the contract's other two codes: 400 for a duplicate id, 404 for an id a turn
  boundary took between the caller's read and the write.

## Consequences

- The order a person sets is the order the agent answers in. The control is not decoration.
- A database upgraded from today keeps its queue exactly as it is: every existing row has
  `position = 0`, and the id tiebreak reproduces `ORDER BY id ASC`.
- The watermark and the client's row identity do not move. Withdrawal keeps its 404
  semantics; reorder adds a second answer (409) for "your list is stale".
- A reorder racing a delivery stays honest: if the head was popped first, the caller's id
  list is no longer the queue, so the daemon refuses rather than resurrecting a delivered
  message.
- Positions are an ordering key, not an index. Reading or displaying `position` as "number
  N in line" would be wrong after the first withdrawal.
- Cross-device ordering is last-writer-wins on the whole list. That is the same contract as
  the rest of the queue, and it is enough while two people do not reorder one queue at the
  same moment.

## Out of scope

- Reordering across tasks; each queue belongs to one task, and the conversation list's
  order is `taskOrder.ts`.
- Editing a delivered message; the transcript is immutable, and withdraw + resend remains
  the only edit.
- Changing the transcript on reorder; no event, no note (unlike withdrawal).
- P13's steer half; it needs an agent capability, and it stays parked.
- Fractional ranks or an offline merge protocol. (a) is a single integer on purpose; revisit
  if concurrent reorders from two devices become real.
