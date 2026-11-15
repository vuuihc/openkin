/**
 * Which waiting approvals deserve to float over the current screen.
 *
 * An approval blocks the agent that asked for it, and the places it is drawn
 * are the transcript of the task it belongs to and this floating card. A reader
 * working anywhere else — another conversation, settings, a project page — has
 * no other way to know that an agent somewhere has stopped, which is the one
 * state in this product that costs wall-clock time for every minute nobody
 * looks. The list's row-end count says *that* something waits; this card is the
 * place to answer it without leaving the screen.
 *
 * Two exclusions keep the card from becoming noise:
 *
 * - The conversation on screen already renders its own approval inline, next
 *   to the tool call that asked for it. That card is the better one — it has
 *   the transcript around it — and two live copies of one approval invite a
 *   reader to answer the same question twice.
 * - The inbox is the page that lists every waiting approval. A floating card
 *   over it would be the same queue twice, and the one on the page is the one
 *   with the context and the full list.
 *
 * Everything else floats. The list keeps the order it was given; which one is
 * shown is the card's decision, because that is about starving a queue rather
 * than about which screens a card belongs on.
 */

import type { Approval } from "../api/client";

export type FloatingContext = {
  /** The conversation on screen, which renders its own approvals inline. */
  visibleTaskId: string | null;
  /** The inbox is on screen; it already lists every waiting approval. */
  onInbox?: boolean;
};

export function floatingApprovals(approvals: Approval[], ctx: FloatingContext): Approval[] {
  if (ctx.onInbox) return [];
  if (!ctx.visibleTaskId) return approvals;
  return approvals.filter((approval) => approval.task_id !== ctx.visibleTaskId);
}
