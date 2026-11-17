/**
 * The phone list's manual conversation order, one id list per bucket.
 *
 * A drag (or Alt+↑/↓) is a local preference, exactly like `taskPins.ts`: it
 * lives in localStorage, never syncs, and the sidebar and desktop do not know
 * about it. Once a bucket has an order, that order *replaces* the attention and
 * recency rule inside it — a status change or a new message must not put a
 * hand-placed row back where the clock says it belongs. A row the stored order
 * has never seen stays in front of the placed ones only when it is newer than
 * the newest placed row, still in the incoming order, so a new chat is never
 * buried under an old manual arrangement. An unseen row that is older (a page
 * loaded by "Load older" after the move) stays behind the placed order, where
 * its own clock puts it.
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
 * rows newer than the newest placed row come first in the order they arrived,
 * the stored ids follow in their stored order, unseen older rows trail in
 * arrival order, and ids whose row is gone are ignored.
 */
export function applyTaskOrder<T extends { key: string; at: number }>(
  rows: readonly T[],
  stored: readonly string[] | undefined,
): T[] {
  if (!stored) return [...rows];
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const placed = new Set(stored);
  const seen = new Set<string>();
  const known: T[] = [];
  for (const id of stored) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byKey.get(id);
    if (row) known.push(row);
  }
  // Only a row newer than the newest placed one counts as fresh. An older page
  // ("Load older") also arrives unseen, and putting it in front would bury the
  // hand-placed order under conversations the move never saw.
  let newestKnown = -Infinity;
  for (const row of known) if (row.at > newestKnown) newestKnown = row.at;
  const fresh: T[] = [];
  const trailing: T[] = [];
  for (const row of rows) {
    if (placed.has(row.key)) continue;
    if (row.at > newestKnown) fresh.push(row);
    else trailing.push(row);
  }
  return [...fresh, ...known, ...trailing];
}
