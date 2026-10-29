/**
 * Which waiting approvals deserve to float over the current screen.
 *
 * An approval blocks the agent that asked for it, and until now it was only
 * visible in two places: the inbox, and the transcript of the task it belongs
 * to. A reader working anywhere else — another conversation, settings, the
 * project list — had no way to know that an agent somewhere had stopped, which
 * is the one state in this product that costs wall-clock time for every minute
 * nobody looks.
 *
 * The exclusions are what keep the floating card from becoming noise:
 *
 * - The inbox already lists every waiting approval, with room to show the diff
 *   and the queue. Floating a copy over it would be the same decision offered
 *   twice, at different sizes, on one screen.
 * - The conversation on screen already renders its own approval inline, next to
 *   the tool call that asked for it. That card is the better one — it has the
 *   transcript around it — and two live copies of one approval invite a reader
 *   to answer the same question twice.
 *
 * Everything else floats. The list keeps the order it was given; which one is
 * shown is the card's decision, because that is about starving a queue rather
 * than about which screens a card belongs on.
 */

import type { Approval } from "../api/client";

export type FloatingContext = {
  /** The inbox is on screen: it already lists all of these. */
  onInbox: boolean;
  /** The conversation on screen, which renders its own approvals inline. */
  visibleTaskId: string | null;
};

export function floatingApprovals(
  approvals: Approval[],
  ctx: FloatingContext,
): Approval[] {
  if (ctx.onInbox) return [];
  if (!ctx.visibleTaskId) return approvals;
  return approvals.filter((approval) => approval.task_id !== ctx.visibleTaskId);
}
