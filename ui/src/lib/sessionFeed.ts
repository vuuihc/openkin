/**
 * Which conversation rows the list renders, from the feeds it holds.
 *
 * Both scopes read the live page (plus the older pages a person asked for);
 * the archive view also reads a second page of conversations put away one by
 * one. The selection rules live here, away from the page, because each one
 * answers a question that is easy to get subtly wrong:
 *
 * - A conversation is on one side of the archive or the other. The live side
 *   drops archived rows even though the daemon already filters them, because a
 *   row archived from this screen is still in the loaded page until the next
 *   fetch. The archive side adds its own feed to the live page, because that
 *   view shows archived conversations *and* archived projects, and a project's
 *   chats are not archived rows.
 * - Rows are deduped by id: a conversation can arrive through both feeds, and
 *   a flatMap would show it twice under one heading.
 * - The status filter runs here as well as on the server. A filter change is a
 *   new list key, and the hook hands back an unloaded resource until the server
 *   answers; without local narrowing the previous filter's rows would sit under
 *   the new chip for a whole round trip.
 */
import type { Task } from "../api/client";

export type SessionFeedScope = "active" | "archived";

export function sessionFeedTasks(
  /** The live page merged with any older pages already fetched. */
  live: readonly Task[],
  /** The archive view's own feed; ignored in the active scope. */
  archivedFeed: readonly Task[],
  scope: SessionFeedScope,
  status?: string,
): readonly Task[] {
  const matchesStatus = (task: Task) => !status || task.status === status;
  const narrowed = status ? live.filter(matchesStatus) : live;
  if (scope !== "archived") {
    return narrowed.filter((task) => !task.archived_at);
  }
  const seen = new Set(narrowed.map((task) => task.id));
  return [
    ...narrowed,
    ...archivedFeed.filter(
      // The archive's "load older" tail sits outside the registered lists, so
      // the store prunes it through `taskSnapshot` alone — and that cannot
      // know about a flag. A row restored from this screen must leave with
      // everything else, so the side is checked from the row itself.
      (task) => Boolean(task.archived_at) && !seen.has(task.id) && matchesStatus(task),
    ),
  ];
}
