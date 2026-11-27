/**
 * How many things wait on the reader, per conversation.
 *
 * A pending approval or question belongs to one task, and the conversation list
 * is where a person looks for it: the row that owns the work carries the count.
 * There is no separate inbox any more, so this is the whole answer to "where is
 * something waiting on me". The row names the kind it counts — approvals,
 * questions, or both — while the nav badge still sums the two, because from the
 * badge's point of view both kinds mean the same thing: the agent is stopped
 * until someone answers.
 *
 * The map is keyed by `task_id`. An item without one is not attributable to a
 * conversation and is dropped rather than counted under an empty key that no
 * row can match.
 */

import type { Approval, UserQuestion } from "../api/client";

/** What one conversation waits on, split by kind so its row can name it. */
export type PendingCounts = {
  approvals: number;
  questions: number;
  total: number;
};

export type PendingByTask = ReadonlyMap<string, PendingCounts>;

/** The one empty record every consumer defaults to, so no call site allocates
 *  a fresh zero object per row and none has to spell the three fields. */
export const EMPTY_PENDING: PendingCounts = Object.freeze({
  approvals: 0,
  questions: 0,
  total: 0,
});

export function pendingCountsByTask(pending: {
  approvals: Approval[];
  questions: UserQuestion[];
}): PendingByTask {
  const counts = new Map<string, PendingCounts>();
  const add = (taskId: string, kind: "approvals" | "questions") => {
    const current = counts.get(taskId) ?? EMPTY_PENDING;
    counts.set(taskId, {
      approvals: current.approvals + (kind === "approvals" ? 1 : 0),
      questions: current.questions + (kind === "questions" ? 1 : 0),
      total: current.total + 1,
    });
  };
  for (const item of pending.approvals) {
    if (item.task_id) add(item.task_id, "approvals");
  }
  for (const item of pending.questions) {
    if (item.task_id) add(item.task_id, "questions");
  }
  return counts;
}
