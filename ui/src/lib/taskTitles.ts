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
const EVENT = "kin:task-titles";

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A reader that throws must not stop the other surfaces updating.
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

/**
 * Subscribe to local-title changes: this tab's writes and another tab's.
 *
 * The conversation list is not the only surface that draws a task's name — the
 * open conversation's header and a project cover's recent row draw it too — so
 * a rename has to reach every mounted reader, not only the one that wrote it.
 * Same shape as `subscribeSessionViewed` in `sessionViewed.ts`.
 */
export function subscribeTaskTitles(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") {
    return () => {
      listeners.delete(listener);
    };
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  // This tab's writes arrive through `listeners`; the window event exists for
  // listeners outside this helper, so subscribing to both would call a reader
  // twice for one rename.
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The local rename for one task out of a map, trimmed, or `""` when it has
 * none.
 *
 * The map is a parameter rather than read here so a surface that already holds
 * it (a subscribed header, the project cover's row builder) can stay a pure
 * function of what it was handed. `taskDisplayTitle` is the one expression
 * that composes it with the task's own title and prompt.
 */
export function localTaskTitle(
  taskId: string | null | undefined,
  localTitles: Record<string, string>,
): string {
  if (!taskId) return "";
  return (localTitles[taskId] ?? "").trim();
}

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
  // Every mounted reader re-reads; the writer already has the returned map.
  emit();
  return next;
}
