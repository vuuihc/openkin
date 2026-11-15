/**
 * Task-level pins for the phone's conversation list.
 *
 * A pinned task lifts to the list's top section and leaves its project
 * bucket, exactly like the reference's Pinned group. This is a phone-side
 * preference, not a daemon record: the sidebar and the desktop do not know
 * about it, and nothing else needs to. It lives in localStorage the way the
 * sidebar's own project pin/archive prefs do.
 */

const STORAGE_KEY = "kin_pinned_tasks";

/** Read the pinned task ids, newest pin last. */
export function getPinnedTaskIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** Set a task's pin state; returns the new list for the caller's state. */
export function setTaskPinned(taskId: string, pinned: boolean): string[] {
  const current = getPinnedTaskIds();
  const next = pinned
    ? current.includes(taskId)
      ? current
      : [...current, taskId]
    : current.filter((id) => id !== taskId);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A pin must never break the list; the in-memory copy still answers.
  }
  return next;
}
