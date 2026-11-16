/**
 * Which conversation rows the batch toolbar may act on.
 *
 * The live list selects any conversation. The archive view's batch action is
 * Restore, so it selects only what was put away: a project's live chats are
 * put back with the project's heading, and restoring one by itself would be a
 * write that changes nothing while still reporting success.
 *
 * Kept here rather than inside the page so the rule has one definition and a
 * test: the row's checkbox, the tap, the keyboard, select-all, the selected
 * count and the "the list moved" prune all have to agree, and a row that is
 * selectable in one of those and not the others is a toolbar that lies about
 * what it will do.
 */
import type { PhoneProjectBucket, PhoneSessionRow } from "./phoneSessionBuckets";

export type SessionSelectionScope = "active" | "archived";

export function rowSelectable(row: PhoneSessionRow, scope: SessionSelectionScope): boolean {
  if (!row.task) return false;
  return scope !== "archived" || Boolean(row.task.archived_at);
}

/** Every selectable row's task id, in list order. */
export function selectableTaskIds(
  buckets: readonly PhoneProjectBucket[],
  scope: SessionSelectionScope,
): string[] {
  return buckets.flatMap((bucket) =>
    bucket.rows.filter((row) => rowSelectable(row, scope)).map((row) => row.task!.id),
  );
}
