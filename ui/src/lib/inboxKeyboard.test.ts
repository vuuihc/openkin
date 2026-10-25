import { describe, expect, it } from "vitest";
import { type InboxKeyState, inboxKeyboardArmed, inboxKeyOutcome } from "./inboxKeyboard";

const items = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];

/** No deep link: the cursor is the person's from the start. */
const live: InboxKeyState = { focusIdx: 0, cursorTakenOver: false, parkedQuestionId: null };
/** A deep link that named a question parked the cursor. */
const parked: InboxKeyState = { focusIdx: 0, cursorTakenOver: false, parkedQuestionId: "q1" };
/** ...and then the person pressed `j`. */
const taken: InboxKeyState = { focusIdx: 0, cursorTakenOver: true, parkedQuestionId: "q1" };

describe("whether the approvals answer to keys", () => {
  // Exported rather than re-derived in the page: the page's own copy of this
  // rule was a line no test could reach, and `armed = true` survived a full
  // mutation sweep while restoring the exact bug the rule prevents.
  it("is false only while a question is parked and nobody has moved the cursor", () => {
    expect(inboxKeyboardArmed(live)).toBe(true);
    expect(inboxKeyboardArmed(parked)).toBe(false);
    expect(inboxKeyboardArmed(taken)).toBe(true);
  });
});

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

  it("lets j enter the list at the top and k at the bottom, taking the cursor", () => {
    // The whole transition, not just the index: the page reads `cursorTakenOver`
    // straight out of the returned state, so a press that reports the move but
    // not the takeover leaves the ring and the keyboard disagreeing.
    expect(inboxKeyOutcome("j", items, parked)).toEqual({
      kind: "move",
      state: { ...parked, focusIdx: 0, cursorTakenOver: true },
      moved: "tookOver",
    });
    expect(inboxKeyOutcome("k", items, parked)).toEqual({
      kind: "move",
      state: { ...parked, focusIdx: 2, cursorTakenOver: true },
      moved: "tookOver",
    });
  });

  it("walks back out of the list to the parked question", () => {
    // A stray `j` used to be a one-way door: the question kept advertising its
    // `1`–`9` shortcuts while those keys did nothing, and only a reload brought
    // them back.
    expect(inboxKeyOutcome("k", items, taken)).toEqual({
      kind: "move",
      state: { ...taken, focusIdx: 0, cursorTakenOver: false },
      moved: "returned",
    });
    // Only from the top, and only when something is parked to go back to.
    expect(inboxKeyOutcome("k", items, { ...taken, focusIdx: 1 })).toEqual({
      kind: "move",
      state: { ...taken, focusIdx: 0 },
      moved: "cursor",
    });
    expect(inboxKeyOutcome("k", items, { ...live, focusIdx: 0 })).toEqual({
      kind: "move",
      state: { ...live, focusIdx: 0 },
      moved: "cursor",
    });
    // And once back, the approvals are disarmed again — that is the whole point.
    const back = inboxKeyOutcome("k", items, taken);
    expect(back.kind === "move" && inboxKeyboardArmed(back.state)).toBe(false);
  });

  it("stops taking the cursor once live", () => {
    expect(inboxKeyOutcome("j", items, { ...live, focusIdx: 0 })).toEqual({
      kind: "move",
      state: { ...live, focusIdx: 1 },
      moved: "cursor",
    });
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(inboxKeyOutcome("j", items, { ...live, focusIdx: 2 })).toEqual({
      kind: "move",
      state: { ...live, focusIdx: 2 },
      moved: "cursor",
    });
    expect(inboxKeyOutcome("k", items, live)).toEqual({
      kind: "move",
      state: live,
      moved: "cursor",
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
