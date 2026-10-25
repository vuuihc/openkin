import { describe, expect, it } from "vitest";
import { type InboxKeyState, inboxKeyOutcome } from "./inboxKeyboard";

const items = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];

/** Live, cursor on the first approval. */
const live: InboxKeyState = { focusIdx: 0, cursorTakenOver: false, armed: true };
/** A deep link that named a question parked the cursor. */
const parked: InboxKeyState = { focusIdx: 0, cursorTakenOver: false, armed: false };

describe("the inbox keyboard model", () => {
  it("rings nothing and decides nothing while a question holds the focus", () => {
    // The first regression this file exists for: a `?focus=<questionId>` link
    // used to switch the whole handler off, so `j` and `k` stopped working too.
    expect(inboxKeyOutcome("a", items, parked)).toEqual({ kind: "none", state: parked });
    expect(inboxKeyOutcome("d", items, { ...parked, focusIdx: 2 })).toEqual({
      kind: "none",
      state: { ...parked, focusIdx: 2 },
    });
  });

  it("lets j enter the list at the top and k at the bottom, taking the cursor back", () => {
    // The whole transition, not just the index: the page reads `cursorTakenOver`
    // straight out of the returned state, so a press that reports the move but
    // not the takeover leaves the ring and the keyboard disagreeing.
    expect(inboxKeyOutcome("j", items, parked)).toEqual({
      kind: "move",
      state: { focusIdx: 0, cursorTakenOver: true, armed: true },
      tookOver: true,
    });
    expect(inboxKeyOutcome("k", items, parked)).toEqual({
      kind: "move",
      state: { focusIdx: 2, cursorTakenOver: true, armed: true },
      tookOver: true,
    });
  });

  it("stops taking the cursor over once live", () => {
    expect(inboxKeyOutcome("j", items, live)).toEqual({
      kind: "move",
      state: { ...live, focusIdx: 1 },
      tookOver: false,
    });
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(inboxKeyOutcome("j", items, { ...live, focusIdx: 2 })).toEqual({
      kind: "move",
      state: { ...live, focusIdx: 2 },
      tookOver: false,
    });
    expect(inboxKeyOutcome("k", items, live)).toEqual({
      kind: "move",
      state: live,
      tookOver: false,
    });
  });

  it("decides the ringed card", () => {
    expect(inboxKeyOutcome("a", items, { ...live, focusIdx: 1 })).toEqual({
      kind: "decide",
      id: "a2",
      decision: "approved",
      state: { ...live, focusIdx: 1 },
    });
    expect(inboxKeyOutcome("D", items, { ...live, focusIdx: 1 })).toEqual({
      kind: "decide",
      id: "a2",
      decision: "denied",
      state: { ...live, focusIdx: 1 },
    });
  });

  it("decides nothing when the ring's index has outlived its card", () => {
    // The second regression: `items[focusIdx] ?? items[0]` decided the *first*
    // approval whenever a decision shortened the list under the ring, so a
    // second press in the same rhythm acted on a card nobody had ringed. The
    // page clamps the index on shrink, and this is the backstop that makes the
    // rule true rather than merely unlikely.
    expect(inboxKeyOutcome("a", items, { ...live, focusIdx: 9 })).toEqual({
      kind: "none",
      state: { ...live, focusIdx: 9 },
    });
    // ...but a card that slid into a still-valid index is decided, which is what
    // clamping produces and is not the same thing as an out-of-range index.
    expect(inboxKeyOutcome("a", [{ id: "only" }], live)).toEqual({
      kind: "decide",
      id: "only",
      decision: "approved",
      state: live,
    });
  });

  it("ignores everything else, and an empty list entirely", () => {
    expect(inboxKeyOutcome("x", items, live)).toEqual({ kind: "none", state: live });
    expect(inboxKeyOutcome("Enter", items, live)).toEqual({ kind: "none", state: live });
    expect(inboxKeyOutcome("j", [], live)).toEqual({ kind: "none", state: live });
    expect(inboxKeyOutcome("a", [], live)).toEqual({ kind: "none", state: live });
  });
});
