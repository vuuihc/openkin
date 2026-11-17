/**
 * The phone list's manual conversation order, one id list per bucket.
 *
 * A drag (or Alt+↑/↓) is a local preference, exactly like `taskPins.ts`: it
 * lives in localStorage, never syncs, and the sidebar and desktop do not know
 * about it. Once a bucket has an order, that order *replaces* the attention and
 * recency rule inside it — a status change or a new message must not put a
 * hand-placed row back where the clock says it belongs. Rows the stored order
 * has never seen (a conversation created or imported after the move) stay in
 * front of the placed ones, still in the incoming order, so a new chat is never
 * buried under an old manual arrangement.
 *
 * Bad storage reads as "no order": a broken preference must not break the list.
 */

const STORAGE_KEY = "kin_task_order";

export type TaskOrder = Record<string, string[]>;

/** Read every bucket's stored order; anything malformed is treated as absent. */
export function getTaskOrder(): TaskOrder {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: TaskOrder = {};
    for (const [bucketKey, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      const clean = ids.filter((id): id is string => typeof id === "string");
      if (clean.length > 0) out[bucketKey] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

function write(order: TaskOrder): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // A reorder must never break the list; the in-memory copy still answers.
  }
}

/** Replace one bucket's order, leaving the other buckets alone. */
export function setBucketOrder(bucketKey: string, ids: readonly string[]): void {
  write({ ...getTaskOrder(), [bucketKey]: [...ids] });
}

/** Forget one bucket's order; the bucket returns to attention + recency. */
export function clearBucketOrder(bucketKey: string): void {
  const order = getTaskOrder();
  if (!(bucketKey in order)) return;
  delete order[bucketKey];
  write(order);
}

/**
 * Order one bucket's rows by its stored order.
 *
 * `stored` undefined means the bucket has no manual order and the rows are
 * returned untouched (a copy, so callers can keep sorting). Otherwise unseen
 * rows come first in the order they arrived, the stored ids follow in their
 * stored order, and ids whose row is gone are ignored.
 */
export function applyTaskOrder<T extends { key: string }>(
  rows: readonly T[],
  stored: readonly string[] | undefined,
): T[] {
  if (!stored) return [...rows];
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const placed = new Set(stored);
  const fresh = rows.filter((row) => !placed.has(row.key));
  const seen = new Set<string>();
  const known: T[] = [];
  for (const id of stored) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byKey.get(id);
    if (row) known.push(row);
  }
  return [...fresh, ...known];
}
