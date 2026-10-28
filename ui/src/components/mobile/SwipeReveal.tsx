import { useRef, useState, type ReactNode } from "react";

/**
 * Swipe-to-reveal row actions for the phone's lists.
 *
 * A row slides left to uncover action chips pinned behind it. Touch has no
 * hover and no right-click, so this is how the reference exposes the same
 * row actions its long-press multi-select also carries — two gestures, one
 * set of actions, and the multi-select remains the keyboard-accessible path.
 *
 * The wrapper only claims horizontal drags (`touch-action: pan-y`): vertical
 * movement stays the list's own scroll. One row is open at a time, decided
 * by the parent, so opening one closes the previous one.
 *
 * The wrapper owns both gestures because it owns the pointer: once a drag
 * starts it captures the pointer, and a long-press must be able to cancel on
 * a move that the captured events now target at this element — a handler on
 * the row's own button would never see those moves.
 */
const REVEAL_WIDTH = 152; // px: two 76px action chips
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 8;

export default function SwipeReveal({
  open,
  onOpenChange,
  onLongPress,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Long-press on the row (multi-select entry). Optional: a row without
   *  batch actions has nothing to enter. */
  onLongPress?: () => void;
  /** Rendered behind the row, on the right, revealed by the swipe. */
  actions: ReactNode;
  children: ReactNode;
}) {
  const startX = useRef<number | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  // The last drag value actually applied, so a move back towards the origin
  // re-issues a changed transform instead of freezing the row mid-drag.
  const lastDrag = useRef(0);
  const [drag, setDrag] = useState<number | null>(null);
  const translate = open ? -REVEAL_WIDTH : 0;
  // A drag ends with a click the browser still fires on the row; that click
  // must not navigate (or toggle) after the row was just moved for its
  // actions. One-shot: the very next click event on this row is swallowed.
  // Armed on pointerup only: a cancelled gesture (the browser took the pan)
  // is followed by no click, and a suppression armed for nothing would eat
  // the next genuine tap.
  const suppressClick = useRef(false);

  const cancelLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    pressOrigin.current = null;
  };

  function onPointerDown(event: React.PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // A fresh gesture starts clean: whatever the previous one armed, it
    // belonged to that gesture's own follow-up click.
    suppressClick.current = false;
    startX.current = event.clientX;
    if (onLongPress) {
      pressOrigin.current = { x: event.clientX, y: event.clientY };
      longPressTimer.current = window.setTimeout(() => {
        longPressTimer.current = null;
        pressOrigin.current = null;
        onLongPress();
      }, LONG_PRESS_MS);
    }
    // The pointer may leave the row mid-drag; the capture keeps the moves
    // and the final up on this element. A synthetic pointer (a test, a
    // screen-reader driver) has no active pointer to capture, so the call
    // is best-effort.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // no active pointer — drag still works within this element
    }
  }

  function onPointerMove(event: React.PointerEvent) {
    const origin = pressOrigin.current;
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > MOVE_TOLERANCE_PX) {
      cancelLongPress();
    }
    if (startX.current === null) return;
    const dx = event.clientX - startX.current;
    // Only leftwards into the reveal; a rightward drag from an open row
    // closes it, a rightward drag on a closed row does nothing.
    const next = Math.min(0, Math.max(-REVEAL_WIDTH * 2, translate + dx));
    if (next !== lastDrag.current) {
      lastDrag.current = next;
      setDrag(next);
    }
  }

  function endDrag(event: React.PointerEvent) {
    cancelLongPress();
    if (startX.current === null) return;
    const dx = event.clientX - startX.current;
    startX.current = null;
    lastDrag.current = 0;
    setDrag(null);
    if (Math.abs(dx) < MOVE_TOLERANCE_PX) return; // a tap — the row's own handler owns it
    // Only a released drag is followed by the browser's own click; a
    // cancelled one is not.
    if (event.type === "pointerup") suppressClick.current = true;
    const next = translate + dx < -REVEAL_WIDTH / 2;
    if (next !== open) onOpenChange(next);
  }

  return (
    <div
      className="relative overflow-hidden"
      style={{ touchAction: "pan-y" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={(event) => {
        // The click that follows a drag is the browser's, not the user's:
        // swallow it before it reaches the row's own onClick.
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {/* Mounted only while open: a hidden-but-focusable action is worse than
          none (tab would reach an invisible button), and the row's own slide
          is the whole transition. */}
      {open ? (
        <div className="absolute inset-y-0 right-0 flex items-stretch" style={{ width: REVEAL_WIDTH }}>
          {actions}
        </div>
      ) : null}
      <div
        className="relative"
        style={{
          // An opaque cover: the revealed actions live behind this layer, and
          // without a background the row content would let them show through.
          background: "var(--kin-page)",
          transform: `translateX(${drag ?? translate}px)`,
          transition: drag === null ? "transform 180ms ease" : "none",
        }}
      >
        {children}
      </div>
    </div>
  );
}
