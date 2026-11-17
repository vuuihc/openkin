// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { applyTaskOrder, clearBucketOrder, getTaskOrder, setBucketOrder } from "./taskOrder";

/**
 * The manual order is a phone-side preference, stored the way pins are: one
 * localStorage key, bad data reads as no preference, and a write failure never
 * breaks the list. The ordering itself is a pure function so the "new rows
 * first, stored rows after" rule — the rule that keeps a new conversation from
 * being buried under an old manual order — is testable without a browser.
 */

function rows(...keys: string[]): { key: string; at: number }[] {
  return keys.map((key, index) => ({ key, at: index }));
}

/** A row with an explicit clock, for the fresh-versus-older split. */
function row(key: string, at: number): { key: string; at: number } {
  return { key, at };
}

beforeEach(() => {
  localStorage.clear();
});

describe("applyTaskOrder", () => {
  it("applies a stored order inside its bucket and lists unseen rows first", () => {
    // `new` arrived after the order was stored; the stored rows follow in the
    // stored order, so a status change or a new message cannot undo the move.
    expect(applyTaskOrder(rows("a", "b", "c", "new"), ["c", "a", "b"])).toEqual([
      row("new", 3),
      row("c", 2),
      row("a", 0),
      row("b", 1),
    ]);
  });

  it("keeps unseen rows older than the newest placed row behind the order", () => {
    // "Load older" appends a page the move never saw. Those are old
    // conversations, not new ones: they belong under the hand-placed order,
    // while a genuinely newer row still goes in front.
    expect(
      applyTaskOrder([row("a", 30), row("old", 5), row("new", 40), row("b", 20)], ["b", "a"]),
    ).toEqual([row("new", 40), row("b", 20), row("a", 30), row("old", 5)]);
  });

  it("ignores stored ids that no longer exist", () => {
    expect(applyTaskOrder(rows("a", "c"), ["c", "gone", "a"])).toEqual([row("c", 1), row("a", 0)]);
  });

  it("returns rows unchanged for a bucket with no stored order", () => {
    expect(applyTaskOrder(rows("a", "b"), undefined)).toEqual(rows("a", "b"));
  });
});

describe("task order storage", () => {
  it("survives corrupt or non-array storage", () => {
    localStorage.setItem("kin_task_order", "not json");
    expect(getTaskOrder()).toEqual({});
    localStorage.setItem("kin_task_order", JSON.stringify(["a"]));
    expect(getTaskOrder()).toEqual({});
    localStorage.setItem("kin_task_order", JSON.stringify({ "/work/a": "nope" }));
    expect(getTaskOrder()).toEqual({});
    localStorage.setItem("kin_task_order", JSON.stringify({ "/work/a": [1, "a", null, "b"] }));
    expect(getTaskOrder()).toEqual({ "/work/a": ["a", "b"] });
  });

  it("clearBucketOrder removes only that bucket", () => {
    setBucketOrder("/work/a", ["a1", "a2"]);
    setBucketOrder("/work/b", ["b1"]);

    clearBucketOrder("/work/a");

    expect(getTaskOrder()).toEqual({ "/work/b": ["b1"] });
  });
});
