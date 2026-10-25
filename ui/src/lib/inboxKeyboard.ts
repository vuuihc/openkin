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

import type { InboxFocus } from "./inboxFocus";

export type InboxKeyState = {
  /** Index into the approvals list that the ring is on. */
  focusIdx: number;
  /**
   * Whether the person has moved the cursor themselves, suspending any parked
   * state. `returned` hands it back.
   */
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
 *
 * Truthy, not `!== null`, so it agrees with the walk-back below: an id that names
 * no card parks nothing. Reading `""` as parked would leave the ring on neither
 * list *and* the keys dead on both — the shape of the very dead end this rule
 * exists to prevent, arrived at from a state nothing can currently produce.
 */
export function inboxKeyboardArmed(state: InboxKeyState): boolean {
  return !state.parkedQuestionId || state.cursorTakenOver;
}

/**
 * Everything the inbox derives from the deep link and the cursor.
 *
 * Here rather than in the page because the rule and the ring have to read the
 * *same* state, and a page free to pass the rule something else can ring one card
 * while arming the keys for another — which is how this page broke twice, in both
 * directions. The page now derives nothing: it draws `questionRinged`, rings
 * `armed && i === focusIdx`, and hands `inboxKeyOutcome` the same three values
 * this computed from.
 */
export type InboxView = {
  /** The question a `?focus=` link parked the cursor on, if nobody has left yet. */
  parkedQuestionId: string | null;
  /** Whether the approvals answer to keys — and so whether their ring is drawn. */
  armed: boolean;
  /** The question wearing the ring, or null. Exactly one card is ever ringed. */
  questionRinged: string | null;
};

export function inboxViewState(
  focus: InboxFocus,
  cursor: { focusIdx: number; cursorTakenOver: boolean },
): InboxView {
  const parkedQuestionId = focus.kind === "question" ? focus.id : null;
  const keyState: InboxKeyState = {
    focusIdx: cursor.focusIdx,
    cursorTakenOver: cursor.cursorTakenOver,
    parkedQuestionId,
  };
  const armed = inboxKeyboardArmed(keyState);
  // The ring moves with the cursor, so a question left ringed after a `j` would
  // put two cards on screen both claiming to be the one the notification named —
  // measured in a browser, not theorised.
  return { parkedQuestionId, armed, questionRinged: armed ? null : parkedQuestionId };
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
      /**
       * The card that now wears the ring, named by the transition rather than
       * re-derived by the page. The page's own ternary picked between the two
       * sources and no test could tell its arms apart; swapping them scrolled to
       * the card *behind* the one being ringed, which looks like a key that did
       * nothing.
       */
      ringId: string | null;
    }
  | { kind: "decide"; id: string; decision: "approved" | "denied"; state: InboxKeyState };

export function inboxKeyOutcome(
  key: string,
  items: readonly { id: string }[],
  state: InboxKeyState,
): InboxKeyOutcome {
  const unchanged: InboxKeyOutcome = { kind: "none", state };

  const down = key === "j" || key === "J";
  const up = key === "k" || key === "K";

  // Walk back out to the parked question. Checked before the empty-list guard on
  // purpose: deciding the last approval of the list empties it, and the way back
  // must not disappear with it — that is the same dead end this exists to close,
  // arrived at from the other side. (The page also drops the takeover when the
  // list empties, so this is the backstop for the frame before that effect runs.)
  if (up && state.cursorTakenOver && state.parkedQuestionId && state.focusIdx === 0) {
    const next = { ...state, focusIdx: 0, cursorTakenOver: false };
    return { kind: "move", state: next, moved: "returned", ringId: state.parkedQuestionId };
  }

  if (!items.length) return unchanged;

  if (down || up) {
    const last = items.length - 1;
    if (!inboxKeyboardArmed(state)) {
      const next = { ...state, focusIdx: down ? 0 : last, cursorTakenOver: true };
      return {
        kind: "move",
        state: next,
        moved: "tookOver",
        ringId: items[next.focusIdx]?.id ?? null,
      };
    }
    const idx = down ? Math.min(last, state.focusIdx + 1) : Math.max(0, state.focusIdx - 1);
    return {
      kind: "move",
      state: { ...state, focusIdx: idx },
      moved: "cursor",
      ringId: items[idx]?.id ?? null,
    };
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
