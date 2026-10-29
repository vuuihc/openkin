/**
 * The phone's session switcher, as data.
 *
 * On a phone every session switch used to be back → list → open, because the
 * tab strip is desktop-only. The switcher is the phone's answer to that strip,
 * and it has one job: say which of the sessions in flight needs the reader
 * right now, and get there in one tap.
 *
 * That is why the status order is not the order the data arrives in. A session
 * blocked on an approval is the one thing that cannot make progress without a
 * human, so it outranks a spinner; a finished session nobody has looked at yet
 * is the next thing worth opening. "Waiting" is read from both places it can
 * appear: the task's own `waiting_approval` / `waiting_input` status, and the
 * pending approval and question lists, which also cover the moment before a
 * status update lands.
 */
import { isTerminal, type Task } from "../api/client";
import { projectLabel } from "./paths";
import { taskDisplayTitle } from "./taskTitle";

export type SwitcherStatus = "waiting" | "running" | "failed" | "unread" | "idle";

export type SwitcherRow = {
  id: string;
  title: string;
  project: string;
  /** Open in the tab strip, as opposed to a recent session behind it. */
  open: boolean;
  active: boolean;
  status: SwitcherStatus;
};

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

export function buildSwitcherRows(input: {
  /** Tab order: what the reader already has open, in strip order. */
  tabIds: readonly string[];
  /** The live task list, newest first (the order the list surfaces use). */
  tasks: readonly Task[];
  activeId: string | null;
  /** Sessions whose result the reader has already seen (`sessionViewed`). */
  viewedIds: ReadonlySet<string>;
  /** Task ids with a pending approval or question. */
  pendingIds: ReadonlySet<string>;
  /** Title for a tab whose row is not in the loaded page. */
  untitled: string;
  /** How many sessions to offer behind the open tabs. */
  recentLimit?: number;
}): SwitcherRow[] {
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const rows: SwitcherRow[] = [];

  const push = (row: SwitcherRow) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    rows.push(row);
  };

  // Open sessions first. A tab the list has not loaded (older than the page, or
  // just deleted) still gets a row: it is mounted and the reader can reach it,
  // and a switcher missing the session in front of them is worse than an
  // untitled row. Its block state still arrives from the pending lists, which
  // are keyed by task id and do not need the row.
  for (const id of input.tabIds) {
    const task = byId.get(id);
    if (!task) {
      push({
        id,
        title: input.untitled,
        project: "",
        open: true,
        active: id === input.activeId,
        status: input.pendingIds.has(id) ? "waiting" : "idle",
      });
      continue;
    }
    push({
      id,
      title: taskDisplayTitle(task) || input.untitled,
      project: projectLabel(task.cwd),
      open: true,
      active: id === input.activeId,
      status: switcherStatus(task, input.viewedIds.has(id), input.pendingIds.has(id)),
    });
  }

  const recentLimit = input.recentLimit ?? 12;
  let recent = 0;
  for (const task of input.tasks) {
    if (recent >= recentLimit) break;
    if (seen.has(task.id)) continue;
    push({
      id: task.id,
      title: taskDisplayTitle(task) || input.untitled,
      project: projectLabel(task.cwd),
      open: false,
      active: task.id === input.activeId,
      status: switcherStatus(task, input.viewedIds.has(task.id), input.pendingIds.has(task.id)),
    });
    recent += 1;
  }

  return rows;
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
