import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { moveVelocity, SWIPE_FLING_VELOCITY, SWIPE_TOLERANCE_PX } from "../lib/swipeGesture";

/**
 * The phone's left-edge back gesture.
 *
 * A rightward drag that starts within `EDGE_START_PX` of the left edge pops
 * the current screen and lands on the list. It does not open anything: since
 * KIN-CONTINUE-002 the phone has no drawer, and the one gesture that used to
 * mean "navigation panel" now means the same thing as the header button and
 * the system back button (NAVIGATION R2/R3).
 *
 * The strip owns `touch-action: pan-y` (set by the caller) because the browser
 * decides at touch-down whether the pull is a pan; a root-level listener could
 * not stop a horizontal swipe from becoming a page pan. A mouse is left alone:
 * the desktop shell keeps its clicks and text selection.
 *
 * There is no transform to follow the finger — a page pop is not a drawer.
 * The gesture commits on release, by distance or by a rightward fling.
 */
export const EDGE_START_PX = 20;
/** How far right the finger must travel to pop without a fling. */
export const EDGE_COMMIT_PX = 64;

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  dx: number;
  velocity: number;
  active: boolean;
};

export type EdgeSwipeBack = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
};

export function useEdgeSwipeBack(enabled: boolean, onBack: () => void): EdgeSwipeBack {
  const gesture = useRef<Gesture | null>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  function begin(event: ReactPointerEvent<HTMLElement>) {
    if (!enabledRef.current || gesture.current) return;
    if (event.pointerType === "mouse" || event.button !== 0) return;
    if (event.clientX > EDGE_START_PX) return;
    const now = event.timeStamp || performance.now();
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastT: now,
      dx: 0,
      velocity: 0,
      active: false,
    };
  }

  function move(event: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    const now = event.timeStamp || performance.now();
    g.dx = dx;
    g.velocity = moveVelocity({ x: g.lastX, t: g.lastT }, event.clientX, now);
    g.lastX = event.clientX;
    g.lastT = now;
    if (!g.active) {
      // A finger that mostly moves vertically is scrolling the page under the
      // strip, not going back.
      if (Math.abs(dy) > SWIPE_TOLERANCE_PX && Math.abs(dy) > Math.abs(dx)) {
        gesture.current = null;
        return;
      }
      if (dx <= SWIPE_TOLERANCE_PX) {
        // A leftward drag is a row swipe, not this gesture; release the
        // candidate so the pointer's own target keeps it.
        if (dx < -SWIPE_TOLERANCE_PX) gesture.current = null;
        return;
      }
      g.active = true;
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // A synthetic pointer has nothing to capture; the drag still works
        // while the pointer stays over this element.
      }
    }
  }

  function end(event: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!g.active) return;
    if (g.dx > EDGE_COMMIT_PX || g.velocity > SWIPE_FLING_VELOCITY) onBackRef.current();
  }

  /**
   * The browser took the pointer: an OS edge gesture, a cancelled touch, or
   * the page losing the pointer mid-drag. That is never a Back from us — the
   * system may already be performing its own, and a fling sampled just before
   * the cancel would otherwise pop a second screen.
   */
  function cancel(event: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
  }

  return {
    onPointerDown: begin,
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: cancel,
  };
}
