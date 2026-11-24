/**
 * KIN-MOBILE-001 R3 — the RN adapter for `ui/src/lib/taskOrder.ts`.
 *
 * The shared module keeps the phone list's manual conversation order in
 * `localStorage`, which the RN bundle may not reference (ADR 0036 §2). Its
 * ordering function is pure, so the adapter carries that function behind the
 * same signature and leaves the browser storage in the web module.
 *
 * R3 has no drag/reorder surface, so `phoneProjectBuckets` is called without
 * an `orders` map and this function is never reached at runtime; it exists so
 * the shared grouping module can be imported in place instead of forked.
 */

export type TaskOrder = Record<string, string[]>;

/**
 * Order one bucket's rows by its stored order.
 *
 * Same rule as the shared `applyTaskOrder`: undefined means no manual order;
 * unseen rows newer than the newest placed row lead, the stored ids follow in
 * their stored order, unseen older rows trail, and ids with no row are ignored.
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
