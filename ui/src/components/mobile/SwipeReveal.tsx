import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
/** px: two 76px action chips, the default reveal. */
const REVEAL_WIDTH = 152;
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 8;
/** ms: the row's own slide back to rest; actions stay mounted until it ends. */
const SETTLE_MS = 180;

export default function SwipeReveal({
  open,
  onOpenChange,
  onLongPress,
  actions,
  /** How far the row slides to uncover its actions, in px. */
  width = REVEAL_WIDTH,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Long-press on the row (multi-select entry). Optional: a row without
   *  batch actions has nothing to enter. */
  onLongPress?: () => void;
  /** Rendered behind the row, on the right, revealed by the swipe. */
  actions: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  const startX = useRef<number | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  // The last drag value actually applied, so a move back towards the origin
  // re-issues a changed transform instead of freezing the row mid-drag.
  const lastDrag = useRef(0);
  const [drag, setDrag] = useState<number | null>(null);
  const translate = open ? -width : 0;
  // A drag ends with a click the browser still fires on the row; that click
  // must not navigate (or toggle) after the row was just moved for its
  // actions. The same goes for the click that ends a long press: it would
  // toggle off the selection the press just made. One-shot: the very next
  // click event on this row is swallowed. Armed on pointerup of a drag, or
  // when the long-press fires: a cancelled gesture is followed by no click,
  // and a fresh pointerdown clears whatever was armed for a click that never
  // came.
  const suppressClick = useRef(false);
  // Whether this gesture has taken the pointer. Capture is deliberately not
  // taken on pointerdown: a captured pointer's `pointerup` — and therefore
  // the browser's `click` — targets the capturing element, so every tap on a
  // button inside the row would be delivered to this wrapper instead. The
  // row could not be opened and its action chips could not be pressed. It is
  // taken once a drag actually starts, which is the only time moves outside
  // the row need to keep arriving here.
  const captured = useRef(false);
  // The strip is mounted from the first pixel of a drag, not on release: a
  // row sliding over an empty slot and then popping its actions in is a snap,
  // not a reveal. It is also kept for the 180ms the row takes to slide back,
  // so the chips travel away with the row instead of vanishing under it.
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<number | null>(null);
  const previousOpen = useRef(open);
  const actionsLayer = useRef<HTMLDivElement | null>(null);
  // Reachable only when the parent has committed the row open and no finger is
  // still moving it. Everything else is a strip the row still covers.
  const actionsInteractive = open && drag === null;

  const holdActionsWhileSettling = useCallback(() => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    setSettling(true);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      setSettling(false);
    }, SETTLE_MS);
  }, []);

  // A row closed by its parent — another row opened, a live update removed it —
  // slides back too, and its actions stay until that slide finishes.
  useEffect(() => {
    const wasOpen = previousOpen.current;
    previousOpen.current = open;
    if (open) {
      if (settleTimer.current !== null) {
        window.clearTimeout(settleTimer.current);
        settleTimer.current = null;
      }
      setSettling(false);
      return;
    }
    if (wasOpen) holdActionsWhileSettling();
  }, [open, holdActionsWhileSettling]);

  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  // `inert` is not in React 18's HTML typings, and `aria-hidden` alone leaves
  // the descendants in the tab order. The attribute is what the browser
  // enforces, so it is set on the node instead of passed as a prop.
  useEffect(() => {
    const layer = actionsLayer.current;
    if (!layer) return;
    if (actionsInteractive) layer.removeAttribute("inert");
    else layer.setAttribute("inert", "");
  }, [actionsInteractive, open, drag, settling]);

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
    captured.current = false;
    startX.current = event.clientX;
    if (onLongPress) {
      pressOrigin.current = { x: event.clientX, y: event.clientY };
      longPressTimer.current = window.setTimeout(() => {
        longPressTimer.current = null;
        pressOrigin.current = null;
        // The tap that ends this press is not a tap on the row.
        suppressClick.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    }
  }

  function onPointerMove(event: React.PointerEvent) {
    const origin = pressOrigin.current;
    if (
      origin &&
      Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > MOVE_TOLERANCE_PX
    ) {
      cancelLongPress();
    }
    if (startX.current === null) return;
    const dx = event.clientX - startX.current;
    // The drag is real: take the pointer so it keeps reporting here if the
    // finger leaves the row. A synthetic pointer (a test, a screen-reader
    // driver) has no active pointer to capture, so the call is best-effort.
    if (!captured.current && Math.abs(dx) > MOVE_TOLERANCE_PX) {
      captured.current = true;
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // no active pointer — the drag still works within this element
      }
    }
    // Only leftwards into the reveal; a rightward drag from an open row
    // closes it, a rightward drag on a closed row does nothing.
    const next = Math.min(0, Math.max(-width * 2, translate + dx));
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
    captured.current = false;
    lastDrag.current = 0;
    setDrag(null);
    if (Math.abs(dx) < MOVE_TOLERANCE_PX) return; // a tap — the row's own handler owns it
    // Only a released drag is followed by the browser's own click; a
    // cancelled one is not.
    if (event.type === "pointerup") suppressClick.current = true;
    const next = translate + dx < -width / 2;
    if (next !== open) onOpenChange(next);
    // A drag that ends with the row anywhere but fully open travels back to
    // rest; its strip stays for that same 180ms. A row that was open closes
    // through the prop change above, and the effect owns that timer, so this
    // only covers a drag that never opened (or never reached half-way).
    if (!next && !open) holdActionsWhileSettling();
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
      {/* Mounted from the first pixel of a drag through the end of the slide
          back. Until the parent commits the row open it is inert and takes no
          pointer: a hidden-but-focusable action is worse than none, and a
          second finger must not press a chip the row still covers. */}
      {open || drag !== null || settling ? (
        <div
          ref={actionsLayer}
          className="absolute inset-y-0 right-0 flex items-stretch"
          style={{ width, pointerEvents: actionsInteractive ? undefined : "none" }}
          aria-hidden={actionsInteractive ? undefined : true}
        >
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
