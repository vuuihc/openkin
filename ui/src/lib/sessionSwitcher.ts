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

/** What the sessions control itself says: the strongest reason to open it. */
export type AttentionMark = "waiting" | "unread";

/**
 * The dot the sessions control carries on the phone.
 *
 * Two differences from a tab's dot, both deliberate. The session in front never
 * counts — the reader is looking at it, and a dot on the control that opens the
 * list you are already in says nothing. And a failure does not light it: a
 * failed session stays failed until it is retried or closed, so a dot that only
 * clears when the tab goes away would train the reader to stop seeing it. What
 * is left is work that arrived while the reader was elsewhere — blocked on a
 * person, or finished unseen — which is exactly what the sheet's first row is
 * for.
 */
export function attentionMark(
  rows: readonly Pick<SwitcherRow, "status" | "active">[],
): AttentionMark | null {
  let unread = false;
  for (const row of rows) {
    if (row.active) continue;
    if (row.status === "waiting") return "waiting";
    if (row.status === "unread") unread = true;
  }
  return unread ? "unread" : null;
}

/**
 * The words the sessions control takes, as locale keys rather than as text:
 * the page translates both it and the state it names.
 *
 * The dot alone cannot carry the state — it is `aria-hidden`, and a control
 * whose whole meaning is its accessible name must not depend on a colour — so
 * the state is part of the label whenever one is drawn. Kept here, next to the
 * rule that decides the mark, so the two cannot drift: a new mark cannot be
 * added without answering what the control says about it.
 */
/** The state each mark names in the control's label. A record, not a ternary:
 * adding an `AttentionMark` without a word for it is a type error, which is
 * what the comment above promises. */
const MARK_STATE_KEY: Record<AttentionMark, string> = {
  waiting: "switcher.waiting",
  unread: "switcher.unread",
};

export function switcherTriggerLabel(mark: AttentionMark | null): {
  key: string;
  stateKey?: string;
} {
  if (!mark) return { key: "switcher.title" };
  return { key: "switcher.titleMarked", stateKey: MARK_STATE_KEY[mark] };
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
