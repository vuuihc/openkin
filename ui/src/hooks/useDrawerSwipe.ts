import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  clamp,
  insideHorizontalScroller,
  moveVelocity,
  prefersReducedMotion,
  SWIPE_FLING_VELOCITY,
  SWIPE_TOLERANCE_PX,
} from "../lib/swipeGesture";

/**
 * The phone drawer's two gestures, in one place.
 *
 * Closed, a rightward drag that starts within `EDGE_START_PX` of the left
 * edge pulls the drawer out with the finger. Open, a leftward drag on the
 * panel or its scrim pushes it back. The same displacement/fling judgement
 * decides both, so opening and closing feel symmetric.
 *
 * The hook owns only the arithmetic and the transform progress; the drawer
 * DOM stays in `Sidebar`, where its links and insets live. `progress` is
 * 0 (closed, off-screen) to 1 (open): the drawer translates by
 * `(progress - 1) * 100%`, so it needs no measured width to render, while the
 * thresholds use the drawer's actual CSS width (`86vw` capped at `22rem`).
 *
 * A mouse is not a finger: the desktop shell must keep its clicks and text
 * selection. `pointerType` is the test, not the viewport, because an iPad runs
 * the desktop layout at ≥768px and still swipes.
 */
export const EDGE_START_PX = 20;
/** 22rem, the drawer's `max-md:max-w-[22rem]`; `w-[86vw]` is the other bound. */
export const DRAWER_MAX_WIDTH_PX = 352;
const SNAP_MS = 180;
/** A release past this share of the drawer commits it. */
const OPEN_FRACTION = 0.4;
/** The mirror for closing: below this share still visible closes. */
const CLOSE_FRACTION = 0.6;

export function drawerWidthFor(viewportWidth: number): number {
  return Math.min(viewportWidth * 0.86, DRAWER_MAX_WIDTH_PX);
}

type Gesture = {
  mode: "edge" | "drawer";
  pointerId: number;
  startX: number;
  startY: number;
  /** The drawer's position when the finger landed: 0 closed, width open. */
  startDrag: number;
  width: number;
  dragging: boolean;
  lastX: number;
  lastT: number;
  lastDx: number;
  velocity: number;
  reduced: boolean;
};

export type DrawerSwipe = {
  /** The drawer must render while a drag is in flight, before it is "open". */
  mounted: boolean;
  /** 0 closed → 1 open. Multiply by 100 for the drawer's own translate. */
  progress: number;
  /** True while the finger owns the transform: CSS transitions must be off. */
  dragging: boolean;
  /** True when this opening began as a drag, so the entry animation must not run. */
  gestureDriven: boolean;
  edgeProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  };
  drawerProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  };
};

export function useDrawerSwipe(open: boolean, onOpenChange: (open: boolean) => void): DrawerSwipe {
  const [drag, setDrag] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [gestureDriven, setGestureDriven] = useState(false);
  const dragRef = useRef<number | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const widthRef = useRef(0);
  const snapTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const applyDrag = (next: number | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const currentWidth = () => {
    if (widthRef.current > 0) return widthRef.current;
    return typeof window === "undefined" ? DRAWER_MAX_WIDTH_PX : drawerWidthFor(window.innerWidth);
  };

  // A pending settle must not fire into a drawer that has since been closed
  // by the route, a rotation, or the scrim.
  useEffect(() => {
    return () => {
      if (snapTimer.current !== null) window.clearTimeout(snapTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!open && dragRef.current === null) setGestureDriven(false);
  }, [open]);

  function settle(target: number) {
    if (snapTimer.current !== null) window.clearTimeout(snapTimer.current);
    setDragging(false);
    const finish = () => {
      snapTimer.current = null;
      applyDrag(null);
      if (target > 0 && !openRef.current) onOpenChangeRef.current(true);
      else if (target === 0 && openRef.current) onOpenChangeRef.current(false);
    };
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    applyDrag(target);
    snapTimer.current = window.setTimeout(finish, SNAP_MS);
  }

  function begin(event: ReactPointerEvent<HTMLElement>, mode: Gesture["mode"]) {
    if (gesture.current) return;
    // A mouse keeps its clicks, selections, and drags: this is a finger path.
    if (event.pointerType === "mouse") return;
    if (event.button !== 0) return;
    if (dragRef.current !== null) return;
    if (mode === "edge") {
      if (openRef.current) return;
      if (event.clientX > EDGE_START_PX) return;
    } else {
      if (!openRef.current) return;
      if (insideHorizontalScroller(event.target)) return;
    }
    const width = drawerWidthFor(window.innerWidth);
    widthRef.current = width;
    suppressClick.current = false;
    gesture.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startDrag: mode === "edge" ? 0 : width,
      width,
      dragging: false,
      lastX: event.clientX,
      lastT: event.timeStamp || performance.now(),
      lastDx: 0,
      velocity: 0,
      reduced: prefersReducedMotion(),
    };
  }

  function move(event: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    g.lastDx = dx;
    const now = event.timeStamp || performance.now();
    g.velocity = moveVelocity({ x: g.lastX, t: g.lastT }, event.clientX, now);
    g.lastX = event.clientX;
    g.lastT = now;
    if (!g.dragging) {
      // A finger that mostly moves vertically is scrolling the list behind
      // the strip, not pulling the drawer.
      if (Math.abs(dy) > SWIPE_TOLERANCE_PX && Math.abs(dy) > Math.abs(dx)) {
        gesture.current = null;
        return;
      }
      const crossed = g.mode === "edge" ? dx > SWIPE_TOLERANCE_PX : dx < -SWIPE_TOLERANCE_PX;
      if (!crossed) {
        // A drag the wrong way is not this gesture; release the candidate so
        // the pointer's own target keeps it (a row's left swipe, a scroll).
        if (Math.abs(dx) > SWIPE_TOLERANCE_PX) gesture.current = null;
        return;
      }
      g.dragging = true;
      suppressClick.current = true;
      setDragging(true);
      setGestureDriven(true);
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // A synthetic pointer has nothing to capture; the drag still works
        // while the pointer stays over this element.
      }
    }
    if (!g.reduced) applyDrag(clamp(g.startDrag + dx, 0, g.width));
  }

  function end(event: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!g.dragging) {
      setDragging(false);
      return;
    }
    // Reduced motion never wrote a drag value; the pointer's travel is the
    // position the threshold should judge.
    const position = clamp(
      g.reduced ? g.startDrag + g.lastDx : (dragRef.current ?? g.startDrag),
      0,
      g.width,
    );
    const commit =
      g.mode === "edge"
        ? position > g.width * OPEN_FRACTION || g.velocity > SWIPE_FLING_VELOCITY
        : !(position < g.width * CLOSE_FRACTION || g.velocity < -SWIPE_FLING_VELOCITY);
    settle(commit ? g.width : 0);
  }

  const edgeProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => begin(event, "edge"),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  };
  const drawerProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => begin(event, "drawer"),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  const width = currentWidth();
  const progress = drag === null ? (open ? 1 : 0) : drag / width;

  return {
    mounted: open || drag !== null,
    progress,
    dragging,
    gestureDriven,
    edgeProps,
    drawerProps,
  };
}
