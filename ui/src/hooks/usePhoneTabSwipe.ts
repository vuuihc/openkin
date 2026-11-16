import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useOverlayOwnsTouch } from "../lib/overlayOwnsTouch";
import {
  insideHorizontalScroller,
  moveVelocity,
  SWIPE_FLING_VELOCITY,
  SWIPE_TOLERANCE_PX,
} from "../lib/swipeGesture";

/** px: enough deliberate travel that a tap or a diagonal scroll is not a tab. */
export const PHONE_TAB_COMMIT_PX = 64;

function belongsToAnInteraction(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  // Rows and links own their swipe / tap. Widgets own their click, drag and
  // selection; in particular a settings range slider must not change screens.
  if (
    target.closest(
      "a,button,input,textarea,select,[contenteditable],[role='dialog'],[data-kin-sheet],[data-kin-bottom-sheet],[data-phone-swipe]",
    )
  )
    return true;
  return insideHorizontalScroller(target);
}

type Gesture = {
  pointerId: number;
  x: number;
  y: number;
  lastX: number;
  lastTime: number;
  dx: number;
  velocity: number;
  horizontal: boolean;
  multiTouch: boolean;
};

export function usePhoneTabSwipe(enabled: boolean, switchTab: (direction: number) => void) {
  const gesture = useRef<Gesture | null>(null);
  const enabledRef = useRef(enabled);
  const switchRef = useRef(switchTab);
  const overlayOwnsTouch = useOverlayOwnsTouch();
  enabledRef.current = enabled && !overlayOwnsTouch;
  switchRef.current = switchTab;

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!enabledRef.current) return;
    if (!event.isPrimary) {
      if (gesture.current) gesture.current.multiTouch = true;
      return;
    }
    if (event.pointerType === "mouse" || event.button !== 0) return;
    if (belongsToAnInteraction(event.target)) return;
    const now = event.timeStamp || performance.now();
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastTime: now,
      dx: 0,
      velocity: 0,
      horizontal: false,
      multiTouch: false,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    const now = event.timeStamp || performance.now();
    g.dx = dx;
    g.velocity = moveVelocity({ x: g.lastX, t: g.lastTime }, event.clientX, now);
    g.lastX = event.clientX;
    g.lastTime = now;
    if (!g.horizontal && Math.abs(dy) > SWIPE_TOLERANCE_PX && Math.abs(dy) > Math.abs(dx)) {
      gesture.current = null; // The page's vertical scroll owns this finger.
      return;
    }
    if (!g.horizontal && Math.abs(dx) <= SWIPE_TOLERANCE_PX) return;
    g.horizontal = true;
  }

  function finish(event: ReactPointerEvent<HTMLElement>, cancelled = false) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (cancelled || g.multiTouch || !g.horizontal) return;
    const direction =
      g.dx < -PHONE_TAB_COMMIT_PX || g.velocity < -SWIPE_FLING_VELOCITY
        ? 1
        : g.dx > PHONE_TAB_COMMIT_PX || g.velocity > SWIPE_FLING_VELOCITY
          ? -1
          : 0;
    if (direction) switchRef.current(direction);
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finish(event),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finish(event, true),
  };
}
