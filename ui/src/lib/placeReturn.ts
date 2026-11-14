/**
 * Returning from a destination to the list puts the caret back on the entry
 * that opened it — the last one the reader used, which is also where the list
 * was scrolled. The row handshake in `rowReturn.ts` does the same for a
 * conversation; this is its sibling for the phone footer and the new-chat
 * button.
 *
 * The mark rides sessionStorage because the list and the destination are
 * separate routes. A cold launch, or a destination reached from a notification,
 * has nothing to take and leaves focus alone.
 */
const KEY = "kin.returnToPlace";

/**
 * The ids the list page can return focus to. A stored value outside this set
 * is stale or foreign — the mark outlives a deploy — and must not reach the
 * attribute selector in `focusPlaceReturn`.
 */
const KNOWN_IDS = new Set(["routines", "agents", "settings", "new"]);

export function rememberPlaceReturn(id: string): void {
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    // No storage: the list simply opens at the top, as it always did.
  }
}

/** The entry to focus, once — reads and clears the mark. */
export function takePlaceReturn(): string | null {
  try {
    const id = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return id && KNOWN_IDS.has(id) ? id : null;
  } catch {
    return null;
  }
}

/** Drop the mark without using it: the draft became a conversation, so the
 *  new-chat button is no longer where the reader came from. */
export function forgetPlaceReturn(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // No storage: there is no mark to forget.
  }
}

/**
 * Focus the footer entry (or the new-chat button) for `id` if it is on screen.
 *
 * The id is one of our own literals (`routines`, `agents`, `settings`, `new`),
 * so it is safe in an attribute selector; there is no user text here to escape.
 */
export function focusPlaceReturn(id: string, root: ParentNode = document): boolean {
  const element = root.querySelector<HTMLElement>(`[data-phone-return="${id}"]`);
  if (!element) return false;
  element.focus();
  return true;
}
