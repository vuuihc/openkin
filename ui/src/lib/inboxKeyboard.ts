/**
 * The inbox's keyboard model, as a state transition rather than a listener.
 *
 * One rule underneath all of it: **a key acts on the card that is ringed, and a
 * card is ringed only while its keys are live.** Both halves have been broken
 * once, in opposite directions — the page has rung two cards at once, and has
 * decided a card nobody ringed.
 *
 * - A deep link that named a question *parks* the cursor: nothing in the
 *   approvals is ringed and `a`/`d` do nothing, because the ring is what says
 *   which card a decision would land on and there is no honest ring to draw on
 *   an approval the notification was not about. `j`/`k` are navigation rather
 *   than a decision, so they work while parked and take the cursor — the first
 *   press entering the list at the end that was asked for, since a step from an
 *   index nobody chose is not a move anyone asked for.
 * - `k` from the top of the list walks back out again, re-ringing the question.
 *   Without it a stray `j` was a one-way door: the question kept advertising its
 *   `1`–`9` shortcuts while those keys did nothing, and only a reload brought
 *   them back.
 * - A decision lands on the card the ring is on, or on nothing at all. Never on
 *   the first card of the list because the ring's index outlived its card.
 *
 * The transition is a value, so all of it is testable without a DOM — which is
 * the point: the tree has no DOM test environment, and this is the part of the
 * page where getting it wrong is silent.
 */

export type InboxKeyState = {
  /** Index into the approvals list that the ring is on. */
  focusIdx: number;
  /** Whether the person has moved the cursor themselves, ending any parked state. */
  cursorTakenOver: boolean;
  /** The question a deep link named, while it is still waiting. Null otherwise. */
  parkedQuestionId: string | null;
};

/**
 * Whether the approvals answer to keys.
 *
 * The single definition, exported rather than re-derived: the page's own copy of
 * this rule was a line no test could reach, so `armed = true` survived a full
 * mutation sweep while restoring the exact bug the rule exists to prevent.
 */
export function inboxKeyboardArmed(state: InboxKeyState): boolean {
  return state.parkedQuestionId === null || state.cursorTakenOver;
}

export type InboxKeyOutcome =
  | { kind: "none"; state: InboxKeyState }
  | {
      kind: "move";
      state: InboxKeyState;
      /**
       * `cursor` is a move inside the list. `tookOver` ended the parked state,
       * `returned` went back to it — both can land the ring somewhere the
       * person cannot see (approvals render above questions), so the page is
       * expected to bring it into view.
       */
      moved: "cursor" | "tookOver" | "returned";
    }
  | { kind: "decide"; id: string; decision: "approved" | "denied"; state: InboxKeyState };

export function inboxKeyOutcome(
  key: string,
  items: readonly { id: string }[],
  state: InboxKeyState,
): InboxKeyOutcome {
  const unchanged: InboxKeyOutcome = { kind: "none", state };
  if (!items.length) return unchanged;

  const down = key === "j" || key === "J";
  const up = key === "k" || key === "K";
  if (down || up) {
    const last = items.length - 1;
    if (!inboxKeyboardArmed(state)) {
      const next = { ...state, focusIdx: down ? 0 : last, cursorTakenOver: true };
      return { kind: "move", state: next, moved: "tookOver" };
    }
    // Back out of the list to the question the link named.
    if (up && state.cursorTakenOver && state.parkedQuestionId && state.focusIdx === 0) {
      const next = { ...state, focusIdx: 0, cursorTakenOver: false };
      return { kind: "move", state: next, moved: "returned" };
    }
    const idx = down ? Math.min(last, state.focusIdx + 1) : Math.max(0, state.focusIdx - 1);
    return { kind: "move", state: { ...state, focusIdx: idx }, moved: "cursor" };
  }

  const decision =
    key === "a" || key === "A" ? "approved" : key === "d" || key === "D" ? "denied" : null;
  if (!decision) return unchanged;
  // Nothing is ringed while a question holds the focus, and deciding the first
  // approval instead would be the worst kind of surprise.
  if (!inboxKeyboardArmed(state)) return unchanged;

  // No `?? items[0]`: a decision whose target the person cannot see is worse than
  // a keystroke that does nothing. The page clamps `focusIdx` when the list
  // shrinks, so this is a guard rather than a path.
  const target = items[state.focusIdx];
  if (!target) return unchanged;
  return { kind: "decide", id: target.id, decision, state };
}
