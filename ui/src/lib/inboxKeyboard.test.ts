import { describe, expect, it } from "vitest";
import {
  type InboxKeyState,
  inboxKeyboardArmed,
  inboxKeyOutcome,
  inboxViewState,
} from "./inboxKeyboard";
import type { InboxFocus } from "./inboxFocus";

const items = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];

/** No deep link: the cursor is the person's from the start. */
const live: InboxKeyState = { focusIdx: 0, cursorTakenOver: false, parkedQuestionId: null };
/** A deep link that named a question parked the cursor. */
const parked: InboxKeyState = { focusIdx: 0, cursorTakenOver: false, parkedQuestionId: "q1" };
/** ...and then the person pressed `j`. */
const taken: InboxKeyState = { focusIdx: 0, cursorTakenOver: true, parkedQuestionId: "q1" };

describe("what the page derives from the deep link", () => {
  // This derivation used to live in the page, where nothing could reach it. Three
  // one-token mutants there kept all 765 tests green, each restoring a bug this
  // module exists to prevent — including the previous round's demonstrated
  // "approval 0 is ringed and `a` decides it" on a question deep link. The page
  // now takes `armed` and `questionRinged` from here and derives nothing.
  const cursor = { focusIdx: 1, cursorTakenOver: false };

  it("parks only a question link, and rings exactly that question", () => {
    const onQuestion = inboxViewState({ kind: "question", id: "q1" }, cursor);
    expect(onQuestion).toEqual({ parkedQuestionId: "q1", armed: false, questionRinged: "q1" });
    // An approval link parks nothing and rings nothing on the question side: the
    // approvals' own ring is what marks it, and it is armed from the start.
    for (const focus of [
      { kind: "approval", id: "a2", idx: 1 },
      { kind: "missing", id: "gone" },
      { kind: "none" },
    ] as InboxFocus[]) {
      const view = inboxViewState(focus, cursor);
      expect(view.parkedQuestionId).toBeNull();
      expect(view.armed).toBe(true);
      expect(view.questionRinged).toBeNull();
    }
  });

  it("moves the ring off the question once the cursor is taken", () => {
    // Both halves have to move together. Ringing the question *and* arming the
    // approvals is the two-badges defect; arming the approvals while still
    // ringing the question is the same defect with one fewer pixel of evidence.
    const view = inboxViewState(
      { kind: "question", id: "q1" },
      { ...cursor, cursorTakenOver: true },
    );
    expect(view.armed).toBe(true);
    expect(view.questionRinged).toBeNull();
    expect(view.questionRinged).toBeNull();
  });

  it("arms the approvals for an id that names no card, rather than dead-ending both lists", () => {
    // `inboxKeyboardArmed` reads truthily and the walk-back reads truthily, so
    // these two agree. The `!== null` reading would leave `""` parked: nothing
    // ringed on either list and every key dead — the dead end this rule exists to
    // prevent, reached from a state nothing produces today.
    expect(inboxKeyboardArmed({ ...live, parkedQuestionId: "" })).toBe(true);
    expect(inboxViewState({ kind: "question", id: "" }, cursor).armed).toBe(true);
  });
});

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
      ringId: "a1",
    });
    expect(inboxKeyOutcome("k", items, parked)).toEqual({
      kind: "move",
      state: { ...parked, focusIdx: 2, cursorTakenOver: true },
      moved: "tookOver",
      ringId: "a3",
    });
  });

  it("names the card it just ringed, from whichever list that is", () => {
    // The page scrolls to `ringId` and nothing else. It used to pick between the
    // two sources itself, and swapping the arms of that ternary kept every test
    // green while scrolling to the card *behind* the ringed one — so the walk
    // back looked like a key that did nothing. These four pin the arms apart.
    expect(inboxKeyOutcome("j", items, parked)).toMatchObject({ ringId: "a1" });
    expect(inboxKeyOutcome("k", items, taken)).toMatchObject({ ringId: "q1" });
    // A plain move inside the list names a card too, so the page's "don't yank
    // the page" rule rests on `moved`, not on `ringId` being absent.
    expect(inboxKeyOutcome("j", items, live)).toMatchObject({ moved: "cursor", ringId: "a2" });
  });

  it("walks back out of the list to the parked question", () => {
    // A stray `j` used to be a one-way door: the question kept advertising its
    // `1`–`9` shortcuts while those keys did nothing, and only a reload brought
    // them back.
    expect(inboxKeyOutcome("k", items, taken)).toEqual({
      kind: "move",
      state: { ...taken, focusIdx: 0, cursorTakenOver: false },
      moved: "returned",
      ringId: "q1",
    });
    // Only from the top, and only when something is parked to go back to.
    expect(inboxKeyOutcome("k", items, { ...taken, focusIdx: 1 })).toEqual({
      kind: "move",
      state: { ...taken, focusIdx: 0 },
      moved: "cursor",
      ringId: "a1",
    });
    expect(inboxKeyOutcome("k", items, { ...live, focusIdx: 0 })).toEqual({
      kind: "move",
      state: { ...live, focusIdx: 0 },
      moved: "cursor",
      ringId: "a1",
    });
    // And once back, the approvals are disarmed again — that is the whole point.
    const back = inboxKeyOutcome("k", items, taken);
    expect(back.kind === "move" && inboxKeyboardArmed(back.state)).toBe(false);
  });

  it("still walks back when the approvals list has emptied out", () => {
    // Deciding the last approval empties the list. The way back must not vanish
    // with it, or the dead end is simply reached from the other side. The page
    // drops the takeover when the list empties, so this is the frame before that
    // effect lands.
    expect(inboxKeyOutcome("k", [], taken)).toEqual({
      kind: "move",
      state: { ...taken, cursorTakenOver: false },
      moved: "returned",
      ringId: "q1",
    });
    // ...but an empty list is still not something `j` can enter, and a parked
    // cursor with nowhere to go stays parked.
    expect(inboxKeyOutcome("j", [], taken)).toEqual({ kind: "none", state: taken });
    expect(inboxKeyOutcome("j", [], parked)).toEqual({ kind: "none", state: parked });
  });

  it("stops taking the cursor once live", () => {
    expect(inboxKeyOutcome("j", items, { ...live, focusIdx: 0 })).toEqual({
      kind: "move",
      state: { ...live, focusIdx: 1 },
      moved: "cursor",
      ringId: "a2",
    });
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(inboxKeyOutcome("j", items, { ...live, focusIdx: 2 })).toEqual({
      kind: "move",
      state: { ...live, focusIdx: 2 },
      moved: "cursor",
      ringId: "a3",
    });
    expect(inboxKeyOutcome("k", items, live)).toEqual({
      kind: "move",
      state: live,
      moved: "cursor",
      ringId: "a1",
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
