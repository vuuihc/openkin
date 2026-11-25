/**
 * KIN-MOBILE-001 R3 — the list's split decision (KIN-CONTINUE-007 各面差异).
 *
 * A window at least 768pt wide is the signed 820-coarse-pointer surface: the
 * list keeps the same 304pt column KIN-CONTINUE-007 measured in the web
 * console, and the conversation sits beside it. Anything narrower is the phone
 * stack the routes already draw. The rule is pure so the route can ask it on
 * every resize and the answer cannot disagree with the tests.
 */

/** The signed boundary: 767pt is a stack, 768pt is a split. */
export const SPLIT_MIN_WIDTH = 768;

/** The signed left column, the same 304px KIN-CONTINUE-007 measured. */
export const SPLIT_LIST_WIDTH = 304;

export type ListLayout =
  | { mode: "stack" }
  | { mode: "split"; listWidth: typeof SPLIT_LIST_WIDTH };

export function splitFor(width: number): ListLayout {
  if (width < SPLIT_MIN_WIDTH) return { mode: "stack" };
  return { mode: "split", listWidth: SPLIT_LIST_WIDTH };
}
