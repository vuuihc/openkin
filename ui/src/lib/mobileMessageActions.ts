import { useCallback, useSyncExternalStore } from "react";

/**
 * Mobile message actions are hidden until the message is tapped, and one
 * message is revealed at a time — the touch counterpart of the desktop's
 * hover, which does not exist on a phone. This module is the one shared
 * answer to "which message is revealed", so a second tap on the same message
 * hides it, revealing another hides the first, and a row re-renders without
 * its neighbours (each row subscribes to its own boolean).
 *
 * The state is deliberately module-level rather than React: the reveal has to
 * survive the stream's own re-renders (every websocket tick rebuilds the
 * turn list) and has no owner that outlives it. A key, not an index: turns
 * re-key on retry, and an index would point at a different message after the
 * list shifts.
 */

let revealedKey: string | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const setRevealedKey = (next: string | null) => {
  if (revealedKey === next) return;
  revealedKey = next;
  for (const listener of listeners) listener();
};

/** Toggle the actions of one message; revealing another hides the first. */
export const toggleMobileMessageActions = (messageKey: string) => {
  setRevealedKey(revealedKey === messageKey ? null : messageKey);
};

export const useMobileMessageActionsRevealed = (messageKey: string): boolean => {
  const getSnapshot = useCallback(() => revealedKey === messageKey, [messageKey]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * A tap on the message body reveals its actions; a tap that lands on a
 * control, a link, or the actions themselves does that control's job, and a
 * tap that ends a text selection leaves the actions alone (the selection is
 * the user's own errand, and revealing buttons under it would fight it).
 */
const INTERACTIVE_TARGET_SELECTOR =
  'a, button, input, textarea, select, summary, label, [role="button"], [role="link"], [role="menuitem"], [contenteditable="true"]';

export const isMessageActionsToggleTap = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  if (target.closest(INTERACTIVE_TARGET_SELECTOR)) return false;
  const selection = typeof window === "undefined" ? null : window.getSelection();
  return !selection || selection.isCollapsed;
};
