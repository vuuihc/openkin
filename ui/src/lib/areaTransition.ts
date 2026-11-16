/**
 * What kind of arrival a navigation is: an area switch, a push into a detail,
 * a pop back out, a content swap, or nothing at all.
 *
 * Depth is a table, not a guess from the URL. `resolveAreaRoute` already names
 * every route, and the name says whether the reader moved to a sibling surface
 * or one level deeper. Deriving depth from segment count would classify
 * `/settings?tab=agents` as a push, when it is a section of one page, and
 * `/inbox` as a sibling screen, when it redirects to `/sessions`; both would
 * animate a direction the reader never travelled. A new route name fails to
 * compile until it is classified here.
 *
 * Deliberately narrow, like `areaNavigation`: a `Location`-shaped
 * `{ pathname, search }` in, a plain string out. No React, router, `window` or
 * i18n import — the tests run in a plain Node process, and motion chosen by a
 * module that can read the browser is motion that depends on where it ran.
 */
import { resolveAreaRoute, type AreaRouteName, type LocationLike } from "./areaNavigation";

export type TransitionKind = "none" | "area" | "push" | "pop" | "swap";

/**
 * What should actually be drawn: the kind, `"fade"` when the reader asked for
 * reduced motion, or `"none"` when there is no arrival to show.
 */
export type TransitionMotion = "none" | "fade" | "area" | "push" | "pop";

/**
 * How deep each route sits inside its area.
 *
 * 0 is a surface drawn in place — the collection, the draft, a redirect, a
 * settings section. 1 is the one level a detail opens: a task, an agent
 * session, a project. Anything between two depth-1 routes is a swap, never a
 * push or a pop, because neither direction is true.
 */
export const ROUTE_DEPTH: Record<AreaRouteName, 0 | 1> = {
  "conversations.collection": 0,
  "conversations.new": 0,
  "conversations.inbox": 0,
  "conversations.approvals": 0,
  "conversations.task": 1,
  "conversations.agentSession": 1,
  "projects.collection": 0,
  "projects.detail": 1,
  "routines.root": 0,
  "routines.machineTask": 1,
  "settings.root": 0,
  "settings.section": 0,
  "settings.operations": 0,
};

/**
 * The transition between two locations.
 *
 * `null` on either side means the URL is unknown or malformed — a cold start,
 * a first paint, or a route this contract does not own — and the honest answer
 * is no direction at all rather than a guess.
 *
 * Same name and same id is the same place regardless of query: `?focus=`,
 * `?tab=`, `?search=` and `?device=` change what is shown inside the surface,
 * not which surface it is. Content that changes in place does not re-enter.
 */
export function routeTransition(from: LocationLike, to: LocationLike): TransitionKind {
  const before = resolveAreaRoute(from);
  const after = resolveAreaRoute(to);
  if (!before || !after) return "none";
  if (before.name === after.name && before.id === after.id) return "none";
  if (before.area !== after.area) return "area";

  const fromDepth = ROUTE_DEPTH[before.name];
  const toDepth = ROUTE_DEPTH[after.name];
  if (fromDepth === toDepth) return toDepth === 1 ? "swap" : "none";
  return toDepth > fromDepth ? "push" : "pop";
}

/**
 * The motion to draw for a kind.
 *
 * A swap or an in-place change stays silent for everyone: the content changes,
 * the page does not reload (TASTE 15). A reader who asked the OS for reduced
 * motion still gets an arrival, just the opacity fade the console has always
 * used, with no movement across the screen (TASTE 11).
 */
export function transitionMotion(kind: TransitionKind, reducedMotion: boolean): TransitionMotion {
  if (kind === "none" || kind === "swap") return "none";
  return reducedMotion ? "fade" : kind;
}
