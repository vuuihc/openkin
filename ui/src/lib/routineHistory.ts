import type { Task } from "../api/client";

/**
 * How many runs one page of a routine's history asks for. The tasks route caps
 * at the same number, so a page that came back full is the only "maybe more"
 * signal it gives — the response is a bare array, not a `{items, has_more}`.
 */
export const ROUTINE_HISTORY_PAGE = 10;

/**
 * How many rows one routine's list may hold while the editor stays open.
 *
 * "Load older" grows the list by a page at a time, and live runs keep arriving.
 * Neither is bounded by the page size, so the list needs an outer bound or a
 * long-lived editor on a busy routine would grow without one. Twenty pages is
 * more history than the panel can scroll through in a sitting.
 */
export const ROUTINE_HISTORY_MAX = 200;

/**
 * Fold one live task into a routine's loaded run list.
 *
 * A known id is the same run changing status, so it is replaced in place and
 * keeps its position.
 *
 * An unknown id is placed by its id, because the list is id-descending and a
 * task id is a ULID: a run that started after the fetch (a scheduled run, Run
 * now) is newer than everything loaded and lands at the front, while an old run
 * whose read state just changed belongs in its chronological place instead of
 * above newer rows. It can also be older than the paging cursor; the cursor is
 * tracked separately (`pageCursor`) so that fold cannot move it.
 *
 * An undefined list means the editor has not loaded that routine yet. A push
 * must not invent a partial history the fetch would then contradict; the fetch
 * is what decides what the editor starts with.
 *
 * The list is capped at ROUTINE_HISTORY_MAX rows, and so is an older page: the
 * bound is a property of the list, not of one of its two grow paths.
 */
export function foldRoutineRun(list: Task[] | undefined, task: Task): Task[] | undefined {
  if (!list) return undefined;
  const idx = list.findIndex((x) => x.id === task.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = { ...next[idx], ...task };
    return next;
  }
  const at = list.findIndex((x) => x.id < task.id);
  const next = at < 0 ? [...list, task] : [...list.slice(0, at), task, ...list.slice(at)];
  return next.length > ROUTINE_HISTORY_MAX ? next.slice(0, ROUTINE_HISTORY_MAX) : next;
}

/**
 * Merge one older page into a routine's loaded run list.
 *
 * A run that started while the older page was in flight can appear on both
 * sides of the cursor; keeping the first copy avoids a duplicate key and a
 * double row for the same run.
 *
 * The result is ordered by id, because the live list may already hold a run
 * older than this page: a push for a deep run (a mark-read, or an old run
 * finishing) is placed at the tail by `foldRoutineRun`. Appending the page
 * after it would show that deep row above rows that are newer than it.
 */
export function appendOlderRuns(list: Task[], page: Task[]): Task[] {
  const seen = new Set(list.map((x) => x.id));
  const merged = [...list, ...page.filter((x) => !seen.has(x.id))];
  // ULIDs sort by time as strings, so this is the same newest-first order the
  // daemon returns pages in. The cap matches the fold's.
  merged.sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
  return merged.length > ROUTINE_HISTORY_MAX ? merged.slice(0, ROUTINE_HISTORY_MAX) : merged;
}

/**
 * Clear unread on rows the console already knows are read.
 *
 * A fetch snapshot can predate a mark: a per-task mark publishes a task update
 * that patches the row afterwards, but "Mark all read" publishes nothing at
 * all. Reconciling every fetch — the initial page and each older one — is what
 * keeps a late response from resurrecting unread rows over a read badge.
 */
export function reconcileRoutineReads(
  tasks: Task[],
  allRead: boolean,
  knownRead: ReadonlySet<string>,
): Task[] {
  return tasks.map((x) => (allRead || knownRead.has(x.id) ? { ...x, routine_unread: false } : x));
}

/**
 * The cursor for the page below the one just applied, or "" when that page was
 * empty.
 *
 * The daemon's `before` is a ULID cursor ("id < before"), so the oldest id the
 * page returned is the boundary. It is deliberately not the oldest loaded row:
 * a live push can place a much older run at the tail, and asking below that id
 * would skip every run between the fetched boundary and it.
 */
export function pageCursor(page: Task[]): string {
  return page.length > 0 ? page[page.length - 1].id : "";
}
