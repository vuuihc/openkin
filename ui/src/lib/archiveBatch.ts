/**
 * What a batch move across the archive did, row by row.
 *
 * Archiving and restoring a selection are the same shape of call as deleting
 * one: a round of independent requests, where a row that failed has to stay
 * selected so the retry is one tap, and the rows that worked have to reach the
 * live store as normal `task_update`s. The split is small but it is where the
 * two failure modes live — losing the failures (a retry now starts over) and
 * reporting the successes as failures (a toast about rows that moved) — so it
 * lives here with its own tests instead of inline in the page.
 */
import type { Task } from "../api/client";

export type ArchiveBatchOutcome = {
  /** The rows the daemon answered, in the order they were selected. */
  moved: Task[];
  /** The ids that did not move, in the same order — still selected for a retry. */
  failed: string[];
};

export function settleArchiveBatch(
  ids: readonly string[],
  results: readonly PromiseSettledResult<Task>[],
): ArchiveBatchOutcome {
  const moved: Task[] = [];
  const failed: string[] = [];
  ids.forEach((id, index) => {
    const result = results[index];
    if (result?.status === "fulfilled") moved.push(result.value);
    else failed.push(id);
  });
  return { moved, failed };
}
