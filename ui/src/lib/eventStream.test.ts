import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../api/client";
import {
  hasSequenceGap,
  highestContiguousSeq,
  mergeEventsBySeq,
} from "./eventStream";

function ev(seq: number): TaskEvent {
  return {
    task_id: "t1",
    seq,
    type: "message",
    ts: seq,
    payload: {},
  };
}

describe("highestContiguousSeq", () => {
  it("returns 0 for empty", () => {
    expect(highestContiguousSeq([])).toBe(0);
  });

  it("tracks contiguous prefix, not max observed", () => {
    expect(highestContiguousSeq([ev(1), ev(2), ev(3)])).toBe(3);
    // Hole at 3: max observed is 5 but cursor stays at 2.
    expect(highestContiguousSeq([ev(1), ev(2), ev(4), ev(5)])).toBe(2);
    // Only out-of-order high seqs: no contiguous prefix.
    expect(highestContiguousSeq([ev(5), ev(7)])).toBe(0);
  });

  it("ignores non-positive seqs", () => {
    expect(highestContiguousSeq([{ seq: 0 }, { seq: -1 }, { seq: 1 }])).toBe(1);
  });
});

describe("hasSequenceGap", () => {
  it("detects holes relative to contiguous cursor", () => {
    expect(hasSequenceGap(2, 4)).toBe(true);
    expect(hasSequenceGap(2, 3)).toBe(false);
    expect(hasSequenceGap(2, 2)).toBe(false);
    expect(hasSequenceGap(2, 1)).toBe(false);
    expect(hasSequenceGap(0, 1)).toBe(false);
    expect(hasSequenceGap(0, 2)).toBe(true);
  });
});

describe("mergeEventsBySeq", () => {
  it("dedupes by seq and sorts ascending", () => {
    const a = ev(1);
    const b = ev(3);
    const b2 = { ...ev(3), type: "result" };
    const c = ev(2);
    const merged = mergeEventsBySeq([a, b], [c, b2]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(merged[2].type).toBe("result");
  });

  it("converges out-of-order live delivery into store order", () => {
    let local: TaskEvent[] = [];
    // Live stream delivers 1, then 4 (gap), then recovery fills 2,3, then 5.
    local = mergeEventsBySeq(local, [ev(1)]);
    expect(highestContiguousSeq(local)).toBe(1);
    expect(hasSequenceGap(1, 4)).toBe(true);

    local = mergeEventsBySeq(local, [ev(4)]);
    // Still hole — cursor must not jump to 4.
    expect(highestContiguousSeq(local)).toBe(1);

    local = mergeEventsBySeq(local, [ev(2), ev(3)]);
    expect(highestContiguousSeq(local)).toBe(4);

    local = mergeEventsBySeq(local, [ev(5)]);
    expect(local.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(highestContiguousSeq(local)).toBe(5);
  });

  it("handles duplicates without advancing cursor incorrectly", () => {
    let local = mergeEventsBySeq([], [ev(1), ev(2)]);
    local = mergeEventsBySeq(local, [ev(2), ev(1)]);
    expect(local.map((e) => e.seq)).toEqual([1, 2]);
    expect(highestContiguousSeq(local)).toBe(2);
    expect(hasSequenceGap(2, 2)).toBe(false);
  });
});
