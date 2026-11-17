/**
 * Locally renamed conversations.
 *
 * A rename is this browser's name for a conversation, not a daemon record:
 * like a pin (`taskPins.ts`), it is written and read without the network so a
 * title that reads like the first line of a prompt can be fixed offline and
 * stays fixed after a reload. The sidebar and the phone list both draw from
 * this map; nothing else needs to know about it.
 */

const STORAGE_KEY = "kin_task_titles";

/** Read the local titles. Anything unreadable is simply no overrides. */
export function getLocalTaskTitles(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const titles: Record<string, string> = {};
    for (const [taskId, title] of Object.entries(parsed as Record<string, unknown>)) {
      // Hand-edited or half-written storage still has to answer with a title a
      // row can show: only non-blank strings count as a name.
      if (typeof title !== "string") continue;
      const trimmed = title.trim();
      if (trimmed) titles[taskId] = trimmed;
    }
    return titles;
  } catch {
    return {};
  }
}

/**
 * Set a task's local title; returns the new map for the caller's state.
 *
 * A blank title removes the entry rather than storing an empty name: the row
 * then falls back to the task's own title, which is "no override", not a row
 * with nothing written on it.
 */
export function setLocalTaskTitle(taskId: string, title: string): Record<string, string> {
  const current = getLocalTaskTitles();
  const trimmed = title.trim();
  const next = { ...current };
  if (trimmed) next[taskId] = trimmed;
  else delete next[taskId];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A rename must never break the list; the in-memory copy still answers.
  }
  return next;
}
