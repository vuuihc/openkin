/**
 * KIN-MOBILE-001 §2 — the conversation list's keyboard map.
 *
 * Pure and React-free: the screen owns the ring and the route memory, and this
 * module owns only which row a key lands on. No wraparound at the ends — the
 * list is a document, not a carousel — and a row a fold or a query hid does
 * not trap the arrows: down enters at the first visible row and up at the last.
 */

export type RowKey = "ArrowUp" | "ArrowDown" | "Enter";

/** The three keys the list answers; every other key is the text caret's. */
export function isRowKey(key: string): key is RowKey {
  return key === "ArrowUp" || key === "ArrowDown" || key === "Enter";
}

/**
 * The row one arrow press lands on.
 *
 * `current` may name a row the visible page no longer holds (a project folded
 * or a search narrowed it away): down then enters at the first visible row and
 * up at the last. With no ring yet (`""`) both arrows enter at the first row —
 * the last row of a fresh list is off-screen and must not be reachable blind.
 * An empty page keeps the id it cannot move, and the ends hold instead of
 * wrapping.
 */
export function moveRow(
  ids: readonly string[],
  current: string,
  key: "ArrowUp" | "ArrowDown",
): string {
  if (ids.length === 0) return current;
  if (current === "") return ids[0]!;
  const index = ids.indexOf(current);
  if (index === -1) {
    return key === "ArrowDown" ? ids[0]! : ids[ids.length - 1]!;
  }
  if (key === "ArrowDown") {
    return index + 1 < ids.length ? ids[index + 1]! : current;
  }
  return index > 0 ? ids[index - 1]! : current;
}

/** Enter opens only a row the visible page holds; nothing else opens. */
export function openRow(
  ids: readonly string[],
  current: string,
): string | null {
  if (current === "" || !ids.includes(current)) return null;
  return current;
}
