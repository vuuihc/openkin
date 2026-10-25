/**
 * The inbox's keyboard model, as a decision rather than a listener.
 *
 * A deep link that named a question parks the cursor: nothing is ringed, and
 * `a`/`d` do nothing, because the ring is what says which card a decision would
 * land on and there is no honest ring to draw on an approval the notification
 * was not about. `j`/`k` are navigation rather than a decision, so they work
 * while parked and take the cursor back — the first press entering the list at
 * the end that was asked for, since a step from an index nobody chose is not a
 * move anyone asked for.
 *
 * Kept out of the component so the parked state is covered by a test instead of
 * by reading the listener: the tree has no DOM test environment, and this is the
 * part of the page where getting it wrong is silent (a key that decides nothing,
 * or a key that decides the wrong card).
 */

export type InboxKeyAction =
  | { kind: "none" }
  /** Move the ring. `takesOver` means this press ended the parked state. */
  | { kind: "move"; idx: number; takesOver: boolean }
  | { kind: "decide"; id: string; decision: "approved" | "denied" };

const NONE: InboxKeyAction = { kind: "none" };

export function inboxKeyAction(
  key: string,
  items: readonly { id: string }[],
  { focusIdx, armed }: { focusIdx: number; armed: boolean },
): InboxKeyAction {
  if (!items.length) return NONE;

  const down = key === "j" || key === "J";
  const up = key === "k" || key === "K";
  if (down || up) {
    if (!armed) return { kind: "move", idx: down ? 0 : items.length - 1, takesOver: true };
    const last = items.length - 1;
    return {
      kind: "move",
      idx: down ? Math.min(last, focusIdx + 1) : Math.max(0, focusIdx - 1),
      takesOver: false,
    };
  }

  const decision =
    key === "a" || key === "A" ? "approved" : key === "d" || key === "D" ? "denied" : null;
  if (!decision) return NONE;
  // Nothing is ringed while a question holds the focus, and deciding the first
  // approval instead would be the worst kind of surprise.
  if (!armed) return NONE;

  const target = items[focusIdx] ?? items[0];
  return target ? { kind: "decide", id: target.id, decision } : NONE;
}
