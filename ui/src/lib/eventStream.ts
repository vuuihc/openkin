import type { TaskEvent } from "../api/client";

/**
 * Highest contiguous sequence present in the local event list.
 *
 * Task event sequences are task-local and start at 1. The UI cursor must track
 * the highest contiguous value — never the maximum observed sequence — so a hole
 * (e.g. 1,2,4) keeps the cursor at 2 until 3 is recovered from the durable log.
 */
export function highestContiguousSeq(events: readonly { seq: number }[]): number {
  if (events.length === 0) return 0;
  const seqs = new Set<number>();
  for (const e of events) {
    if (Number.isFinite(e.seq) && e.seq > 0) seqs.add(e.seq);
  }
  let cursor = 0;
  while (seqs.has(cursor + 1)) cursor += 1;
  return cursor;
}

/**
 * True when `incomingSeq` cannot be explained by a contiguous append after
 * `contiguousSeq` (i.e. the stream has a hole that requires REST recovery).
 */
export function hasSequenceGap(contiguousSeq: number, incomingSeq: number): boolean {
  if (!Number.isFinite(incomingSeq) || incomingSeq <= 0) return false;
  // Duplicate or already-covered seq is not a gap.
  if (incomingSeq <= contiguousSeq) return false;
  // Contiguous next is fine; anything further means at least one missing seq.
  return incomingSeq > contiguousSeq + 1;
}

/** Merge by seq (last write wins) and return ascending order. */
export function mergeEventsBySeq(prev: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  const map = new Map<number, TaskEvent>();
  for (const e of prev) map.set(e.seq, e);
  for (const e of incoming) map.set(e.seq, e);
  return Array.from(map.values()).sort((a, b) => a.seq - b.seq);
}
