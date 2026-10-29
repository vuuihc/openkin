import type { Task } from "../api/client";

/**
 * The tail of the conversation list: the live page followed by the older rows
 * a person loaded, with the live store's newer copies taking precedence.
 *
 * The tail lives outside the live store on purpose (see `SessionsPage`), which
 * also means the store will never prune or refresh it. Without this merge a
 * deleted row stays tappable — it navigates to a 404 — and a run that finished
 * after its page loaded keeps the status it had, so it sits under a "Running"
 * filter that it no longer matches.
 *
 * `snapshot` answers with the store's row for an id (`null` when deleted,
 * `undefined` when the store has never heard of it), which is what makes the
 * precedence rule testable without a store.
 */
export type TaskSnapshot = (id: string) => Task | null | undefined;

export function mergeTaskTail(
  live: readonly Task[],
  tail: readonly Task[],
  snapshot: TaskSnapshot,
): readonly Task[] {
  // No tail is the common case, and keeping the live array's identity means
  // the memos downstream do not rebuild for a list that did not change.
  if (tail.length === 0) return live;
  const seen = new Set(live.map((task) => task.id));
  const merged = [...live];
  for (const task of tail) {
    if (seen.has(task.id)) continue;
    const current = snapshot(task.id);
    // Deleted while it sat in the tail: the store is the authority.
    if (current === null) continue;
    seen.add(task.id);
    merged.push(current ?? task);
  }
  return merged;
}
