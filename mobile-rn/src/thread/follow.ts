/**
 * KIN-MOBILE-001 R4c — the phone's follow-the-stream policy, pure.
 *
 * The signed story says the stream may move the page only while the reader is
 * already at the live edge (`KIN-MOBILE-001.md:91`, 「用户手动上滚后不被自动滚回
 * 底部」). That is one rule with three transitions, kept here rather than in the
 * view so they can be tested without a renderer:
 *
 * - pinned when the scroll position is within `FOLLOW_BAND_PT` of the end;
 * - a drag that leaves the band unpins, and content growth then never scrolls;
 * - returning to the band re-pins, and growth follows the end again.
 *
 * The view feeds this module the platform's own scroll and content-size
 * numbers; the module never reads layout itself.
 */

/** How close to the end still counts as reading the live edge. */
export const FOLLOW_BAND_PT = 48;

export type ScrollMetrics = {
  offset: number;
  contentHeight: number;
  viewportHeight: number;
};

export type FollowState = {
  /** True while the reader is at (or within the band of) the end. */
  pinned: boolean;
};

/** A conversation opens on its newest segment: the reader starts pinned. */
export function initialFollow(): FollowState {
  return { pinned: true };
}

/**
 * Points between the current offset and the end. Content shorter than the
 * viewport cannot scroll, so it has no end to be away from.
 */
export function distanceFromEnd(metrics: ScrollMetrics): number {
  return Math.max(
    0,
    metrics.contentHeight - metrics.viewportHeight - metrics.offset,
  );
}

/** Fold one scroll event into the policy. */
export function onScroll(
  state: FollowState,
  metrics: ScrollMetrics,
): FollowState {
  const pinned = distanceFromEnd(metrics) <= FOLLOW_BAND_PT;
  return pinned === state.pinned ? state : { pinned };
}

export type GrowthDecision = {
  pinned: boolean;
  /** Whether the caller should scroll to the end after this growth. */
  scrollToEnd: boolean;
};

/**
 * Content grew (a streamed step, a new turn). Only a pinned reader is moved:
 * growth while the person reads further up must leave their place alone.
 */
export function onContentGrew(state: FollowState): GrowthDecision {
  return { pinned: state.pinned, scrollToEnd: state.pinned };
}
