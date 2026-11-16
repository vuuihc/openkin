import { describe, expect, it } from "vitest";
import { focusedId, resolveInboxFocus } from "./inboxFocus";

const approvals = [{ id: "ap-1" }, { id: "ap-2" }];
const questions = [{ id: "q-1" }];

describe("resolving the inbox deep link", () => {
  it("is nothing at all without a focus id", () => {
    // The ordinary inbox: no ring, no notice, and the keyboard cursor stays
    // wherever the page put it.
    expect(resolveInboxFocus(null, approvals, questions)).toEqual({ kind: "none" });
    expect(focusedId(resolveInboxFocus(null, approvals, questions))).toBe(null);
  });

  it("finds an approval and says where it is in the list", () => {
    // The index is not decoration: it is what moves the keyboard cursor, so a
    // ring and the `a`/`d` keys agree about which card is armed.
    const hit = resolveInboxFocus("ap-2", approvals, questions);
    expect(hit).toEqual({ kind: "approval", id: "ap-2", idx: 1 });
    expect(focusedId(hit)).toBe("ap-2");
  });

  it("finds a question", () => {
    const hit = resolveInboxFocus("q-1", approvals, questions);
    expect(hit).toEqual({ kind: "question", id: "q-1" });
    expect(focusedId(hit)).toBe("q-1");
  });

  it("reports an id that is in neither list instead of drawing a plain inbox", () => {
    // Handled on another device, expired, or outside the loaded window — the
    // page cannot tell those apart, so it says the one thing true of all three.
    const miss = resolveInboxFocus("gone", approvals, questions);
    expect(miss).toEqual({ kind: "missing", id: "gone" });
    expect(focusedId(miss)).toBe(null);
  });

  it("cannot be fooled by an inbox that is still loading", () => {
    // Before the first load both lists are empty, and every id looks missing;
    // the page must not draw the notice yet, which is why the resolution is
    // reported rather than acted on. This test pins the input, not the fix.
    expect(resolveInboxFocus("ap-1", [], [])).toEqual({ kind: "missing", id: "ap-1" });
  });

  it("prefers the approval when an id is somehow in both lists", () => {
    // Ids are unique across the two tables, so this cannot happen today. If it
    // ever does, one card is ringed rather than two.
    expect(resolveInboxFocus("dup", [{ id: "dup" }], [{ id: "dup" }])).toEqual({
      kind: "approval",
      id: "dup",
      idx: 0,
    });
  });
});
