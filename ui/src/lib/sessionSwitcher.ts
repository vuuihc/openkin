/**
 * The session tab strip's marks, as data.
 *
 * The phone has exactly one conversation navigation surface — the list
 * (`KIN-CONTINUE-002`). The strip below is the Mac's, and this module now
 * carries only what it draws: a tab's dot and the pending-id set that feeds
 * it. A second, phone-only switcher was removed; it was a conversation list on
 * the conversation screen, which is the duplicate the signed story forbids.
 */
import { isTerminal, type Task } from "../api/client";

export type SwitcherStatus = "waiting" | "running" | "failed" | "unread" | "idle";

/**
 * Which mark a row carries. Precedence, not last-write-wins: a session that is
 * both running and waiting for an approval is waiting, and the two waiting
 * statuses outrank a spinner even when the pending lists have not caught up.
 */
export function switcherStatus(task: Task, viewed: boolean, waiting: boolean): SwitcherStatus {
  if (waiting || task.status === "waiting_approval" || task.status === "waiting_input") {
    return "waiting";
  }
  if (!isTerminal(task.status)) return "running";
  if (task.status === "failed") return "failed";
  if (task.status === "succeeded" && !viewed) return "unread";
  return "idle";
}

/** The states a tab has room to show: one dot, no words. */
export type TabMark = "waiting" | "failed" | "unread";

/**
 * The dot an open tab carries, if any.
 *
 * A tab is a session the reader already has open, so it carries the state a
 * switcher row carries and nothing else: a spinner on every busy tab would turn
 * the strip into a row of noise, and "idle" is what most tabs are most of the
 * time. `waiting` reads the pending lists as well as the status, like the sheet,
 * because the lists answer a moment earlier than the task row does.
 */
export function tabMark(task: Task | undefined, viewed: boolean, waiting: boolean): TabMark | null {
  // A tab can outlive the loaded page. Its row is gone but its block state is
  // not: the pending lists are keyed by task id and need no row.
  if (!task) return waiting ? "waiting" : null;
  const status = switcherStatus(task, viewed, waiting);
  return status === "waiting" || status === "failed" || status === "unread" ? status : null;
}

/** Task ids with something to answer: one approval or one question is enough. */
export function waitingTaskIds(
  approvals: readonly { task_id: string }[],
  questions: readonly { task_id: string }[],
): Set<string> {
  const ids = new Set<string>();
  for (const approval of approvals) if (approval.task_id) ids.add(approval.task_id);
  for (const question of questions) if (question.task_id) ids.add(question.task_id);
  return ids;
}
