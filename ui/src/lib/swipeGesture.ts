/**
 * The small vocabulary shared by the phone's swipe gestures.
 *
 * Two gestures exist: the navigation drawer (edge-drag to open, drag to
 * close) and the bottom sheet's pull-down. Both need the same "did this
 * become a drag?" tolerance, the same fling threshold, and the same answer to
 * "does this finger belong to a scrollable region?" Keeping them in one place
 * is what makes the two feel like one hand rather than two implementations.
 */

/** px: below this a pointer is still a tap, not a drag. */
export const SWIPE_TOLERANCE_PX = 8;

/** px/ms: a release this fast commits before the displacement threshold. */
export const SWIPE_FLING_VELOCITY = 0.4;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * `prefers-reduced-motion` removes the follow-the-finger part of a gesture,
 * not the gesture: the thresholds still decide, the surface just does not
 * travel with the finger. A platform that cannot answer gets the full shape.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Whether a gesture that started on `target` belongs to a horizontally
 * scrollable strip (a code block, a chip row). Those keep their own pan, and
 * a drawer or sheet must not steal the rightward drag that scrolls them back.
 */
export function insideHorizontalScroller(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  let node: Element | null = target;
  while (node && node !== document.body) {
    if (node instanceof HTMLElement) {
      const overflowX = window.getComputedStyle(node).overflowX;
      if (
        (overflowX === "auto" || overflowX === "scroll") &&
        node.scrollWidth > node.clientWidth + 1
      ) {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

/** Instant velocity of the last move, in px/ms. */
export function moveVelocity(previous: { x: number; t: number }, x: number, t: number): number {
  const dt = t - previous.t;
  // A pointer sample closer than one display frame cannot express a real
  // finger speed; treating it as a fling would let a coalesced pair of events
  // (or a synthetic one) commit a half-inch drag.
  return dt >= 4 ? (x - previous.x) / dt : 0;
}
