/**
 * Give a cold deep-linked pushed screen the parent the signed table names, so
 * system Back lands there. A true area root does not invent one: it is the
 * reader's peer-level starting point, not a pushed child, so system Back leaves
 * Kin.
 *
 * The signed parent table (`coldStartPhoneParent` in `areaNavigation.ts`) is
 * the single source of truth: a task or an imported session comes back to the
 * conversations root, a project detail to `/projects`, a machine task to
 * `/routines?device=<the original device>`, a settings section to `/settings`,
 * and the legacy Agent-operations destinations to `/settings?tab=operations`.
 * This module never guesses a "previous page".
 *
 * The in-app back button and the left-edge swipe use the same resolver
 * (`lib/phoneBack.ts`). The browser's own Back cannot: on the first entry of a
 * cold launch it leaves the app. The only place to fix that without a race is
 * before the router mounts: turn the single entry `[X]` into `[parent, X]`.
 * React Router reads `idx` from `history.state` when it starts, so the
 * synthesized parent is a real history entry the browser pops to, and the
 * router's own index stays truthful.
 *
 * It is deliberately narrow: phone layout only, only when the app has no
 * in-app entry behind it (`idx === 0`), and never for an area root.
 */
import { coldStartPhoneParent } from "./areaNavigation";
import { isPhoneLayout, registerRootEntry, rootParentState } from "./phoneNavigation";

function wasIndex(state: unknown): number {
  const idx = (state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && Number.isFinite(idx) ? idx : 0;
}

/** Returns whether a parent entry was synthesized. */
export function synthesizePhoneParent(win: Window = window): boolean {
  if (!isPhoneLayout(win)) return false;
  if (wasIndex(win.history.state) !== 0) return false;

  const here = win.location.pathname + win.location.search + win.location.hash;
  const parent = coldStartPhoneParent({
    pathname: win.location.pathname,
    search: win.location.search,
  });
  // A root (and `/`, which resolves to one) has no synthetic parent.
  if (parent === null) return false;

  const state = (win.history.state ?? {}) as Record<string, unknown>;
  const usr = typeof state.usr === "object" && state.usr !== null ? state.usr : undefined;
  // Record the synthesized parent in this tab's ledger and mark the deep link
  // as its child. Without both, the first push made before the parent ever
  // rendered cannot tell that it is already there, and synthesizes a second
  // one ([root, root, target]).
  const token = registerRootEntry(parent, 0);
  win.history.replaceState({ ...state, idx: 0 }, "", parent);
  win.history.pushState(
    {
      ...state,
      idx: 1,
      // React Router needs a location key; it never saw the original entry, so
      // there is no key to preserve.
      key: `kin-deep-${Math.random().toString(36).slice(2)}`,
      // React Router reads location state from `usr`, not from the history
      // state's top level.
      usr: rootParentState(token, usr, 0, parent),
    },
    "",
    here,
  );
  return true;
}
