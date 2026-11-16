/**
 * The order of the open session tabs (localStorage), and every edit to it.
 *
 * This is one of the two lists a session has, and it is not the mounted set:
 * `sessionCache` answers "which sessions have a live component right now" and
 * lives in memory with its own cap, while this answers "which sessions are open
 * and in what order" and outlives the page. Keeping them apart is what makes a
 * refresh lazy: the order comes back from storage and draws a tab strip, and a
 * session mounts only when its tab is opened (see the P3 plan §2.6).
 *
 * Pure functions over `string[]` plus the two storage calls, so the edits are
 * testable without a DOM and without a browser.
 */

const STORAGE_KEY = "kin.sessionTabs.v1";

/**
 * How many tabs the strip holds.
 *
 * Not the same number as `MAX_CACHED_SESSIONS` (8, how many stay mounted):
 * that one is a memory budget, this one is the width of a bar someone has to
 * read. Over the cap the leftmost tab goes — it is never the one just opened,
 * which is appended at the right — and what it loses is a slot in the strip, not
 * the session, which stays in the list at `/sessions`.
 */
export const MAX_SESSION_TABS = 12;

/**
 * The order after opening (or revisiting) a tab.
 *
 * Appended at the right rather than inserted beside the active tab: a strip that
 * reshuffles on every open is the behaviour that makes tab bars hard to use.
 *
 * Returns its argument when nothing changes (already open, under the cap), so a
 * caller can use identity to decide whether there is anything to write.
 */
export function openSessionTab(order: string[], taskId: string): string[] {
  if (!taskId || order.includes(taskId)) return order;
  const next = [...order, taskId];
  return next.length > MAX_SESSION_TABS ? next.slice(next.length - MAX_SESSION_TABS) : next;
}

/** The order without a tab. Closing one that is not open is a no-op. */
export function closeSessionTab(order: string[], taskId: string): string[] {
  if (!taskId || !order.includes(taskId)) return order;
  return order.filter((id) => id !== taskId);
}

/**
 * The order with a tab moved `delta` places, wrapping at both ends.
 *
 * Wrapping rather than stopping at the ends because the keyboard model is the
 * terminal strip's roving focus (`TerminalTabs`), where the arrows wrap — one
 * strip in the app should not answer `ArrowLeft` at the first tab in two ways.
 *
 * The index is taken in the original order and used in the shortened one, which
 * is exactly the neighbour's slot; no off-by-one for an adjacent swap.
 */
export function moveSessionTab(order: string[], taskId: string, delta: number): string[] {
  const index = order.indexOf(taskId);
  if (index === -1 || order.length < 2 || delta === 0) return order;
  const target = (((index + delta) % order.length) + order.length) % order.length;
  const next = [...order];
  next.splice(index, 1);
  next.splice(target, 0, taskId);
  return next;
}

/**
 * What storage says, cleaned.
 *
 * Anything malformed is dropped rather than repaired: a tab that is not a
 * non-empty string is not a session id, and one that appears twice would give
 * `key`-less React children and a tab that cannot be closed.
 */
export function readSessionTabs(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string" || !value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out.length > MAX_SESSION_TABS ? out.slice(out.length - MAX_SESSION_TABS) : out;
  } catch {
    return [];
  }
}

export function writeSessionTabs(order: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // ignore quota / private mode: the strip still works for this page-load
  }
}

/**
 * The tab that takes over when this one closes.
 *
 * The one to its right, or the one to its left when it was last. `null` when
 * nothing is left, which is the caller's cue to leave the session routes. It is
 * also the tab that takes focus: closing removes the button that had it, and the
 * successor is both where you land and where you look.
 */
export function neighbourTab(order: string[], taskId: string): string | null {
  const index = order.indexOf(taskId);
  const rest = closeSessionTab(order, taskId);
  if (rest.length === 0) return null;
  if (index === -1) return rest[0] ?? null;
  // `index` in the original order is the position the right-hand neighbour had,
  // so after removal it is either that neighbour or past the new end.
  return rest[Math.min(index, rest.length - 1)] ?? null;
}

/**
 * Which tab carries the strip's one tab stop (roving tabindex, the ARIA tabs
 * pattern).
 *
 * The active tab when there is one — but the strip is drawn on routes where no
 * session is in front (`/sessions`, `/new`), and `tabIndex={-1}` on every tab is
 * a strip you can see and cannot enter: Tab walks past it, and the arrows that
 * only work once a tab has focus never get their chance. So with nothing
 * selected the first tab takes the stop, and the arrows move on from there.
 */
export function tabStopId(order: string[], activeId: string | null): string | null {
  if (order.length === 0) return null;
  return activeId !== null && order.includes(activeId) ? activeId : (order[0] ?? null);
}
