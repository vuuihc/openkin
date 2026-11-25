import { describe, expect, it } from "@jest/globals";
import { isRowKey, moveRow, openRow } from "./listKeys";

/**
 * KIN-MOBILE-001 §2 — the conversation list's keyboard map.
 *
 * Pure functions only: which row an arrow lands on, where the ends hold, and
 * which row Enter may open. The ring and the route memory are the screen's,
 * proven in `ConversationList.test.tsx` and `ListScreen.test.tsx`.
 */

describe("KIN-MOBILE-001 §2 list keys", () => {
  it("KIN-MOBILE-001 §2: ArrowDown moves to the next conversation row", () => {
    expect(moveRow(["a1", "a2", "a3"], "a1", "ArrowDown")).toBe("a2");
  });

  it("KIN-MOBILE-001 §2: ArrowUp moves to the previous row and both ends hold", () => {
    expect(moveRow(["a1", "a2", "a3"], "a2", "ArrowUp")).toBe("a1");

    const ids = ["a1", "a2"];
    // No wraparound: the list is a document, not a carousel.
    expect(moveRow(ids, "a2", "ArrowDown")).toBe("a2");
    expect(moveRow(ids, "a1", "ArrowUp")).toBe("a1");
  });

  it("KIN-MOBILE-001 §2: a folded-away row does not trap the arrows", () => {
    const ids = ["a1", "a2", "a3"];
    // The ring stayed on a row a fold or a search hid: down enters at the
    // first visible row, up at the last.
    expect(moveRow(ids, "gone", "ArrowDown")).toBe("a1");
    expect(moveRow(ids, "gone", "ArrowUp")).toBe("a3");
    // An empty page keeps the id it cannot move.
    expect(moveRow([], "gone", "ArrowDown")).toBe("gone");
    expect(moveRow([], "gone", "ArrowUp")).toBe("gone");
  });

  it("KIN-MOBILE-001 §2: Enter opens only a present row", () => {
    const ids = ["a1", "a2", "a3"];
    expect(openRow(ids, "a2")).toBe("a2");
    expect(openRow(ids, "")).toBeNull();
    expect(openRow(ids, "gone")).toBeNull();
  });

  it("KIN-MOBILE-001 §2: other keys move nothing", () => {
    expect(isRowKey("Tab")).toBe(false);
    expect(isRowKey("a")).toBe(false);
    expect(isRowKey("Enter ")).toBe(false);
    expect(isRowKey("ArrowUp")).toBe(true);
    expect(isRowKey("ArrowDown")).toBe(true);
    expect(isRowKey("Enter")).toBe(true);
  });
});
