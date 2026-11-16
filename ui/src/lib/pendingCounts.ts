/**
 * How many things wait on the reader, per conversation.
 *
 * A pending approval or question belongs to one task, and the conversation list
 * is where a person looks for it: the row that owns the work carries the count.
 * There is no separate inbox any more, so this is the whole answer to "where is
 * something waiting on me" — one number per row, summed over both kinds,
 * because from the row's point of view a question and an approval cost the same
 * wall-clock time: the agent is stopped until someone answers.
 *
 * The map is keyed by `task_id`. An item without one is not attributable to a
 * conversation and is dropped rather than counted under an empty key that no
 * row can match.
 */

import type { Approval, UserQuestion } from "../api/client";

export type PendingByTask = ReadonlyMap<string, number>;

export function pendingCountsByTask(pending: {
  approvals: Approval[];
  questions: UserQuestion[];
}): PendingByTask {
  const counts = new Map<string, number>();
  for (const item of [...pending.approvals, ...pending.questions]) {
    if (!item.task_id) continue;
    counts.set(item.task_id, (counts.get(item.task_id) ?? 0) + 1);
  }
  return counts;
}
