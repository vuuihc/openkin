/**
 * Give a cold deep-linked pushed screen a parent, so system Back lands on the
 * conversation list. The four root destinations do not invent that parent:
 * they are the reader's peer-level starting point, not a pushed child.
 *
 * The in-app back button and the left-edge swipe can synthesize `/sessions`
 * when the history has nothing behind it (`lib/phoneBack.ts`). The browser's
 * own Back cannot: on the first entry of a cold launch it leaves the app, and
 * the story promises that a conversation or another pushed detail opened from
 * a notification comes back to the list, not out of Kin
 * (KIN-CONTINUE-002, step 4; NAVIGATION R7).
 *
 * The only place to fix that without a race is before the router mounts: turn
 * the single entry `[X]` into `[/sessions, X]`. React Router reads `idx` from
 * `history.state` when it starts, so the synthesized parent is a real history
 * entry the browser pops to, and the router's own index stays truthful.
 *
 * It is deliberately narrow:
 * - phone layout only; the Mac keeps ordinary browser history,
 * - only when the app has no in-app entry behind it (`idx === 0`),
 * - not for `/` (the start route resolves it) and not for a root peer,
 *   including the conversation list's search / status / archive filters.
 */
import { isPhoneTabPath, listParentState, registerListEntry } from "./phoneNavigation";

const PHONE_QUERY = "(min-width: 768px)";

function wasIndex(state: unknown): number {
  const idx = (state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && Number.isFinite(idx) ? idx : 0;
}

/** Returns whether a parent entry was synthesized. */
export function synthesizePhoneParent(win: Window = window): boolean {
  if (!win.matchMedia || win.matchMedia(PHONE_QUERY).matches) return false;
  if (wasIndex(win.history.state) !== 0) return false;

  const here = win.location.pathname + win.location.search + win.location.hash;
  if (here === "/" || isPhoneTabPath(here)) return false;

  const state = (win.history.state ?? {}) as Record<string, unknown>;
  const usr = typeof state.usr === "object" && state.usr !== null ? state.usr : undefined;
  // Record the synthesized list in this tab's ledger and mark the deep link as
  // its child. Without both, the first push made before the list ever rendered
  // cannot tell that the parent is already there, and synthesizes a second
  // list ([list, list, target]).
  const token = registerListEntry("/sessions", 0);
  win.history.replaceState({ ...state, idx: 0 }, "", "/sessions");
  win.history.pushState(
    {
      ...state,
      idx: 1,
      // React Router needs a location key; it never saw the original entry, so
      // there is no key to preserve.
      key: `kin-deep-${Math.random().toString(36).slice(2)}`,
      // React Router reads location state from `usr`, not from the history
      // state's top level.
      usr: listParentState(token, usr, 0),
    },
    "",
    here,
  );
  return true;
}
