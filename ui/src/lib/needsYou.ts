/**
 * The card the console holds for an event that is waiting on the user.
 *
 * Answering it is a request, so the card is the console's to build. What travels
 * with the anchor is this: which request it answers, so the card can be matched
 * to the transcript position it was asked at.
 */
export type PendingRef = { kind: "approval" | "question"; id: string };

/** One card waiting on the user, and where in the conversation it was asked. */
export type PendingEntry = {
  kind: PendingRef["kind"];
  id: string;
  /** Seq of the event that asked, when it is still in the loaded window. */
  seq: number | null;
};

/**
 * Reading order, which is also keyboard order.
 *
 * `j` / `k` walk this list, so it has to be the order the eye walks the
 * transcript: by the event each card was asked at, oldest first. A card whose
 * event has scrolled out of the loaded window has no place in the conversation
 * to sit at — it is rendered at the end of the stream — so it sorts last. Two
 * cards with no anchor keep the order the server listed them in rather than
 * swapping on every render.
 */
export function orderPending<T extends PendingEntry>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = a.entry.seq;
      const right = b.entry.seq;
      if (left === null && right === null) return a.index - b.index;
      if (left === null) return 1;
      if (right === null) return -1;
      return left - right;
    })
    .map(({ entry }) => entry);
}

/** The cards that have a place in the conversation, keyed for the stream. */
export function anchoredPendingIds<T extends PendingEntry>(entries: T[]): Set<string> {
  const anchored = new Set<string>();
  for (const entry of entries) {
    if (entry.seq !== null) anchored.add(entry.id);
  }
  return anchored;
}
