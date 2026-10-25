/**
 * The inbox's keyboard model, as a state transition rather than a listener.
 *
 * Two rules, and the page has broken each of them once:
 *
 * - A deep link that named a question *parks* the cursor: nothing is ringed and
 *   `a`/`d` do nothing, because the ring is what says which card a decision
 *   would land on and there is no honest ring to draw on an approval the
 *   notification was not about. `j`/`k` are navigation rather than a decision,
 *   so they work while parked and take the cursor back — the first press
 *   entering the list at the end that was asked for, since a step from an index
 *   nobody chose is not a move anyone asked for.
 * - A decision lands on the card the ring is on, or on nothing at all. Never on
 *   the first card of the list because the ring's index outlived its card.
 *
 * The transition is a value, so both rules are testable without a DOM — which is
 * the point: the tree has no DOM test environment, and this is the part of the
 * page where getting it wrong is silent (a key that decides nothing, or decides
 * the wrong card).
 */

export type InboxKeyState = {
  /** Index into the approvals list that the ring is on. */
  focusIdx: number;
  /** Whether the person has moved the cursor themselves, ending any parked state. */
  cursorTakenOver: boolean;
  /** False while a deep link that named a question holds the ring. */
  armed: boolean;
};

export type InboxKeyOutcome =
  | { kind: "none"; state: InboxKeyState }
  /**
   * The ring moved. `tookOver` means this press ended the parked state, so the
   * ring may have landed somewhere the person cannot see (approvals render above
   * questions) and the page is expected to bring it into view.
   */
  | { kind: "move"; state: InboxKeyState; tookOver: boolean }
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
    if (!state.armed) {
      const next = { ...state, focusIdx: down ? 0 : last, cursorTakenOver: true, armed: true };
      return { kind: "move", state: next, tookOver: true };
    }
    const idx = down ? Math.min(last, state.focusIdx + 1) : Math.max(0, state.focusIdx - 1);
    return { kind: "move", state: { ...state, focusIdx: idx }, tookOver: false };
  }

  const decision =
    key === "a" || key === "A" ? "approved" : key === "d" || key === "D" ? "denied" : null;
  if (!decision) return unchanged;
  // Nothing is ringed while a question holds the focus, and deciding the first
  // approval instead would be the worst kind of surprise.
  if (!state.armed) return unchanged;

  // No `?? items[0]`: a decision whose target the person cannot see is worse than
  // a keystroke that does nothing. The page clamps `focusIdx` when the list
  // shrinks, so this is a guard rather than a path.
  const target = items[state.focusIdx];
  if (!target) return unchanged;
  return { kind: "decide", id: target.id, decision, state };
}
