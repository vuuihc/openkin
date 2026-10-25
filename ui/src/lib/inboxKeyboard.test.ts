import { describe, expect, it } from "vitest";
import { inboxKeyAction } from "./inboxKeyboard";

const items = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];

describe("the inbox keyboard model", () => {
  it("rings nothing and decides nothing while a question holds the focus", () => {
    // The regression this file exists for: a `?focus=<questionId>` link used to
    // switch the whole handler off, so `j` and `k` stopped working too.
    expect(inboxKeyAction("a", items, { focusIdx: 0, armed: false })).toEqual({ kind: "none" });
    expect(inboxKeyAction("d", items, { focusIdx: 2, armed: false })).toEqual({ kind: "none" });
  });

  it("lets j enter the list at the top and k at the bottom, taking the cursor back", () => {
    expect(inboxKeyAction("j", items, { focusIdx: 0, armed: false })).toEqual({
      kind: "move",
      idx: 0,
      takesOver: true,
    });
    expect(inboxKeyAction("k", items, { focusIdx: 0, armed: false })).toEqual({
      kind: "move",
      idx: 2,
      takesOver: true,
    });
  });

  it("stops taking the cursor over once armed", () => {
    expect(inboxKeyAction("j", items, { focusIdx: 0, armed: true })).toEqual({
      kind: "move",
      idx: 1,
      takesOver: false,
    });
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(inboxKeyAction("j", items, { focusIdx: 2, armed: true })).toEqual({
      kind: "move",
      idx: 2,
      takesOver: false,
    });
    expect(inboxKeyAction("k", items, { focusIdx: 0, armed: true })).toEqual({
      kind: "move",
      idx: 0,
      takesOver: false,
    });
  });

  it("decides the ringed card, and the first one when the index is stale", () => {
    expect(inboxKeyAction("a", items, { focusIdx: 1, armed: true })).toEqual({
      kind: "decide",
      id: "a2",
      decision: "approved",
    });
    expect(inboxKeyAction("D", items, { focusIdx: 1, armed: true })).toEqual({
      kind: "decide",
      id: "a2",
      decision: "denied",
    });
    // A live update can drop the ringed card between the ring and the key.
    expect(inboxKeyAction("a", items, { focusIdx: 9, armed: true })).toEqual({
      kind: "decide",
      id: "a1",
      decision: "approved",
    });
  });

  it("ignores everything else, and an empty list entirely", () => {
    expect(inboxKeyAction("x", items, { focusIdx: 0, armed: true })).toEqual({ kind: "none" });
    expect(inboxKeyAction("Enter", items, { focusIdx: 0, armed: true })).toEqual({ kind: "none" });
    expect(inboxKeyAction("j", [], { focusIdx: 0, armed: true })).toEqual({ kind: "none" });
    expect(inboxKeyAction("a", [], { focusIdx: 0, armed: true })).toEqual({ kind: "none" });
  });
});
