import type { Task } from "../api/client";
import type { PendingByTask } from "./pendingCounts";

/**
 * The conversation list's attention view: *needs you* and *running*.
 *
 * These are combinations of existing statuses, never new statuses. `needs` is
 * the two waiting statuses plus any conversation that owns a pending approval
 * or question, because the pending item stays authoritative while a status lags
 * behind it. `running` is every state a live turn can be in, so a queued or
 * retrying conversation does not fall out of the view that promises "what is
 * moving".
 *
 * The vocabulary lives here rather than in `phoneSessionBuckets.ts`: the cloud
 * lanes own that module, and a shared import would make two views disagree
 * about which statuses wait. Keep this list next to the filters it serves.
 */

export type SessionAttentionFilter = "" | "needs" | "running";

const WAITING: ReadonlySet<string> = new Set(["waiting_approval", "waiting_input"]);
const IN_FLIGHT: ReadonlySet<string> = new Set(["running", "queued", "retrying"]);

/** Unknown or absent `?attention=` is "all", never a view nothing can match. */
export function normalizeAttentionFilter(raw: string | null): SessionAttentionFilter {
  return raw === "needs" || raw === "running" ? raw : "";
}

/**
 * Whether one row belongs to the selected view.
 *
 * Archived rows are already removed by `sessionFeedTasks` in the active scope
 * (and the archived scope ignores attention entirely), so this rule only has to
 * answer the status question.
 */
export function matchesAttention(
  task: Pick<Task, "id" | "status" | "archived_at">,
  attention: SessionAttentionFilter,
  pendingByTask: PendingByTask,
): boolean {
  if (!attention) return true;
  if (attention === "running") return IN_FLIGHT.has(task.status);
  return WAITING.has(task.status) || (pendingByTask.get(task.id)?.total ?? 0) > 0;
}

/**
 * The two numbers on the chip row.
 *
 * Counts read the first live page (`taskList.data`), not the older pages a
 * person loaded: a number that grows while scrolling is a number that cannot
 * be trusted. The pending half is global, because `pendingByTask` already is;
 * the same conversation is counted once whether it is waiting by status, by a
 * pending item, or both. A truly global running count needs an API aggregate —
 * a known limit of this view, not something a longer client-side merge fixes.
 */
export function attentionCounts(
  livePage: readonly Pick<Task, "id" | "status" | "archived_at">[],
  pendingByTask: PendingByTask,
): { needsYou: number; running: number } {
  const needsYouIds = new Set<string>(pendingByTask.keys());
  let running = 0;
  for (const task of livePage) {
    if (task.archived_at) continue;
    if (WAITING.has(task.status) || (pendingByTask.get(task.id)?.total ?? 0) > 0) {
      needsYouIds.add(task.id);
    }
    if (IN_FLIGHT.has(task.status)) running += 1;
  }
  return { needsYou: needsYouIds.size, running };
}
