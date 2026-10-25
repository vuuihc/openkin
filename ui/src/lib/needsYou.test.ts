import { describe, expect, it } from "vitest";
import { anchoredPendingIds, orderPending, type PendingEntry } from "./needsYou";

function entry(
  id: string,
  seq: number | null,
  kind: PendingEntry["kind"] = "approval",
): PendingEntry {
  return { kind, id, seq };
}

describe("orderPending", () => {
  it("walks the transcript, not the order the server listed them in", () => {
    const ordered = orderPending([entry("c", 40), entry("a", 12), entry("b", 30)]);

    expect(ordered.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("puts the cards with no anchor last, in the order they came in", () => {
    // No anchor means the asking event scrolled out of the loaded window, so the
    // card is painted at the end of the stream. Keyboard order has to agree with
    // where the eye finds it, or `j` jumps somewhere the user cannot see.
    const ordered = orderPending([
      entry("later", 50),
      entry("orphan-1", null),
      entry("orphan-2", null),
    ]);

    expect(ordered.map((e) => e.id)).toEqual(["later", "orphan-1", "orphan-2"]);
  });

  it("keeps approvals and questions on one axis", () => {
    // They are answered in different cards but they block the same turn, so the
    // user walks them in the order the agent asked.
    const ordered = orderPending([entry("q2", 20, "question"), entry("a1", 5), entry("a2", 11)]);

    expect(ordered.map((e) => e.id)).toEqual(["a1", "a2", "q2"]);
  });

  it("has nothing to order for no cards", () => {
    expect(orderPending([])).toEqual([]);
  });
});

describe("anchoredPendingIds", () => {
  it("separates the cards that have a place in the conversation", () => {
    const anchored = anchoredPendingIds([entry("in-window", 7), entry("scrolled-out", null)]);

    expect([...anchored]).toEqual(["in-window"]);
  });
});
