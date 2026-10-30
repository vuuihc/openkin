/**
 * Returning from a conversation to the list puts the caret back on the row it
 * was opened from — the same row the reader was last looking at, which is also
 * where the list was scrolled.
 *
 * The handshake rides sessionStorage because the two screens are separate
 * routes: opening a row writes the id, the list takes it back once. A tab that
 * was closed, or a list opened cold, has nothing to take and leaves focus
 * alone.
 */
const KEY = "kin.returnToRow";

export function rememberRowReturn(id: string): void {
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    // No storage: the list simply opens at the top, as it always did.
  }
}

/** The row to focus, once — reads and clears the mark. */
export function takeRowReturn(): string | null {
  try {
    const id = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Focus the marked row once it is on screen; returns what is left of the mark.
 *
 * The list re-renders on every keystroke in its search, every status chip and
 * every live update, and a mark that survived its first successful focus would
 * pull the caret back onto the row each time — out of the search field the
 * reader had just tapped, on a phone closing the keyboard. Consuming it is
 * therefore part of focusing it, not an optimisation.
 */
export function consumeRowReturn(mark: string | null, root: ParentNode = document): string | null {
  if (!mark) return null;
  return focusRowFor(mark, root) ? null : mark;
}

/** Focus the list row for `id` if it is on screen. */
export function focusRowFor(id: string, root: ParentNode = document): boolean {
  const row = Array.from(root.querySelectorAll<HTMLElement>("[data-session-row]")).find(
    (element) => element.getAttribute("data-session-row") === id,
  );
  if (!row) return false;
  row.focus();
  return true;
}
