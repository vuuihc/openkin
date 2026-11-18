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
 * A files address is a queue, not one push (KIN-RESULT-002). The reader opened
 * `/tasks/<id>?panel=files&file=…` from a conversation, so Back has to stop at
 * the file list and then at that conversation before the list:
 *
 *     /sessions → /tasks/<id> → /tasks/<id>?panel=files → …&file=…
 *
 * The address alone names every stop, so a cold launch can synthesize the
 * whole queue. The list-parent marker sits on the conversation — the entry
 * directly above the list — because `listIsDirectParent` refuses a marker
 * minted for another depth; the panel entries above it are ordinary pushes.
 *
 * It is deliberately narrow:
 * - phone layout only; the Mac keeps ordinary browser history,
 * - only when the app has no in-app entry behind it (`idx === 0`),
 * - not for `/` (the start route resolves it) and not for a root peer,
 *   including the conversation list's search / status / archive filters,
 * - the extra stops only for a `/tasks/<id>` address that explicitly names the
 *   files panel. Every other pushed deep link keeps `[/sessions, X]`.
 */
import { isPhoneTabPath, listParentState, registerListEntry } from "./phoneNavigation";
import { parseWorkspaceLink, patchWorkspaceLink } from "./workspaceDeepLink";

const PHONE_QUERY = "(min-width: 768px)";
/** The one route a files-panel address hangs off. */
const TASK_PATH = /^\/tasks\/[^/]+\/?$/;

function wasIndex(state: unknown): number {
  const idx = (state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && Number.isFinite(idx) ? idx : 0;
}

/**
 * The addresses between the list and a files deep link, nearest-last, or null
 * when the address is not the files panel.
 *
 * The conversation is the same task with `panel` and `file` removed (any other
 * parameter is kept, so a `?focus=` link still carries it to its own
 * consumer); the file list is `panel=files` with no `file`. A `file` the panel
 * would refuse is not a file address at all: the page rewrites that entry to
 * the list on arrival, so synthesizing a list stop for it would leave two
 * copies of the list above the conversation.
 */
function workspaceTrail(pathname: string, search: string): string[] | null {
  if (!TASK_PATH.test(pathname)) return null;
  const link = parseWorkspaceLink(search);
  // A lone `file` with no `panel` names no panel; it is a stale leftover.
  if (!link?.explicit) return null;
  const conversation = `${pathname}${patchWorkspaceLink(search, null)}`;
  if (!link.file) return [conversation];
  const list = `${pathname}${patchWorkspaceLink(search, { panel: "files", file: null })}`;
  return [conversation, list];
}

/** Returns whether a parent entry was synthesized. */
export function synthesizePhoneParent(win: Window = window): boolean {
  if (!win.matchMedia || win.matchMedia(PHONE_QUERY).matches) return false;
  if (wasIndex(win.history.state) !== 0) return false;

  const here = win.location.pathname + win.location.search + win.location.hash;
  if (here === "/" || isPhoneTabPath(here)) return false;

  const state = (win.history.state ?? {}) as Record<string, unknown>;
  const usr = typeof state.usr === "object" && state.usr !== null ? state.usr : undefined;
  // Read the address before `replaceState` moves the document to the list:
  // the queue is derived from the deep link, not from where the synthesis is
  // about to put the browser.
  const trail = workspaceTrail(win.location.pathname, win.location.search) ?? [];
  // Record the synthesized list in this tab's ledger and mark the deep link as
  // its child. Without both, the first push made before the list ever rendered
  // cannot tell that the parent is already there, and synthesizes a second
  // list ([list, list, target]).
  const token = registerListEntry("/sessions", 0);
  win.history.replaceState({ ...state, idx: 0 }, "", "/sessions");

  // React Router needs a location key per entry; it never saw the original
  // entry, so there is no key to preserve. One seed keeps the synthesized
  // entries derived from the same launch.
  const seed = Math.random().toString(36).slice(2);
  trail.forEach((url, i) => {
    win.history.pushState(
      {
        ...state,
        idx: i + 1,
        key: `kin-deep-${seed}-${i + 1}`,
        // The conversation is the entry directly above the list; the panel
        // entries above it are ordinary pushes with no marker.
        usr: i === 0 ? listParentState(token, usr, 0) : usr,
      },
      "",
      url,
    );
  });
  win.history.pushState(
    {
      ...state,
      idx: trail.length + 1,
      key: trail.length === 0 ? `kin-deep-${seed}` : `kin-deep-${seed}-${trail.length + 1}`,
      // React Router reads location state from `usr`, not from the history
      // state's top level.
      usr: trail.length === 0 ? listParentState(token, usr, 0) : usr,
    },
    "",
    here,
  );
  return true;
}
