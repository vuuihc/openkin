import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  dismissTopLayer,
  layerCount,
  pushLayerDismiss,
  subscribeLayers,
} from "../../lib/backStack";
import {
  insideHorizontalScroller,
  moveVelocity,
  prefersReducedMotion,
  SWIPE_TOLERANCE_PX,
} from "../../lib/swipeGesture";

/**
 * The phone's one modal surface.
 *
 * This replaces three hand-written sheets that each had their own scrim,
 * radius, safe-area arithmetic and focus handling — and each got a different
 * subset of them right. A sheet is a platform shape, so it is written once:
 * grabber, centred title, a scroll body, an optional footer, escape/scrim to
 * close, focus into the panel and back to the opener, and the bottom inset
 * re-applied because a `position: fixed` box escapes the shell's `.safe-pad`.
 *
 * It is deliberately not Ionic's `IonModal`. Ionic's modal would bring its own
 * encapsulated styles and its own dismissal choreography; the console's sheets
 * sit inside a themed surface (panel colour, hairlines, the console typeface)
 * and the one thing Ionic would add — swipe-to-dismiss — is written here, in
 * the same pointer vocabulary as the drawer, because the two gestures must
 * feel like one hand.
 */
export type SheetProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible name and the visible heading. Omit for a body-only sheet. */
  title?: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Extra classes on the panel (a wider max-height, a test hook). */
  className?: string;
  bodyClassName?: string;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A layer that floats above the sheet but is portaled out of it (so the
 * sheet's scrollport cannot clip it) announces itself here: the sheet then
 * keeps Tab inside both, stops claiming `aria-modal` over a subtree it does
 * not contain, and gives Back to the layer first.
 */
export function useSheetLayer(open: boolean, dismiss: () => void): void {
  const dismissRef = useRef(dismiss);
  useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);
  useEffect(() => {
    if (!open) return;
    return pushLayerDismiss(() => dismissRef.current());
  }, [open]);
}

export default function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  className = "",
  bodyClassName = "",
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const layers = useSyncExternalStore(subscribeLayers, layerCount, () => 0);
  // The parent re-renders on every keystroke in some sheets (the composer's
  // controls), and an effect that depended on `onClose` would tear down and
  // re-run on each of those — restoring focus to the opener mid-typing.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  /*
   * Pull-down dismissal.
   *
   * The grabber and title are always a handle. The body is one only while it
   * is scrolled to the top: once it has content above the fold, a downward
   * drag belongs to the scroll, not to the sheet, and stealing it would make
   * the list feel stuck. Movement is judged with the drawer's tolerance and
   * fling rules, so a pull and a swipe-through read the same.
   */
  const gripRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(0);
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastT: number;
    lastY: number;
    velocity: number;
    dragging: boolean;
    reduced: boolean;
  } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  // The entry animation would override the finger's transform for its 200ms
  // and then replay when a spring-back re-adds the class, so a sheet opened
  // by a pull never carries it.
  const [gestureDriven, setGestureDriven] = useState(false);

  const applyDragY = (next: number) => {
    dragRef.current = next;
    setDragY(next);
  };

  useEffect(() => {
    if (open) return;
    gesture.current = null;
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    applyDragY(0);
    setDragging(false);
    setGestureDriven(false);
  }, [open]);

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  /*
   * A downward pull on the body is a scroll gesture as far as the browser is
   * concerned, and `touch-action` cannot change after the finger has landed.
   * At the top there is nothing to scroll, but iOS still starts an overscroll
   * and cancels the pointer stream. Preventing that one native move (only
   * downward, only from the top) hands the gesture to the pointer handlers
   * above without taking away the upward swipe that does scroll the body.
   * React attaches touch listeners passively at the root, so this one is
   * registered directly.
   */
  useEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    if (!body) return;
    let active = false;
    let startX = 0;
    let startY = 0;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        active = false;
        return;
      }
      const touch = event.touches[0]!;
      startX = touch.clientX;
      startY = touch.clientY;
      active = body.scrollTop <= 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!active || event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (dy > SWIPE_TOLERANCE_PX && Math.abs(dy) > Math.abs(dx)) event.preventDefault();
    };
    body.addEventListener("touchstart", onTouchStart, { passive: true });
    body.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      body.removeEventListener("touchstart", onTouchStart);
      body.removeEventListener("touchmove", onTouchMove);
    };
  }, [open]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current) return;
    if (event.pointerType === "mouse") return;
    if (event.button !== 0) return;
    const target = event.target as Node;
    const fromGrip = gripRef.current?.contains(target) ?? false;
    const body = bodyRef.current;
    if (!fromGrip) {
      if (!body || !body.contains(target)) return;
      if (body.scrollTop > 0) return;
    }
    if (insideHorizontalScroller(event.target)) return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastT: event.timeStamp || performance.now(),
      lastY: event.clientY,
      velocity: 0,
      dragging: false,
      reduced: prefersReducedMotion(),
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    const now = event.timeStamp || performance.now();
    g.velocity = moveVelocity({ x: g.lastX, t: g.lastT }, event.clientY, now);
    g.lastX = event.clientX;
    g.lastY = event.clientY;
    g.lastT = now;
    if (!g.dragging) {
      if (Math.abs(dx) > SWIPE_TOLERANCE_PX && Math.abs(dx) > Math.abs(dy)) {
        gesture.current = null;
        return;
      }
      if (dy <= SWIPE_TOLERANCE_PX) return;
      g.dragging = true;
      setDragging(true);
      setGestureDriven(true);
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Synthetic pointer: the drag still works over this element.
      }
    }
    if (!g.reduced) applyDragY(Math.max(0, dy));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!g.dragging) {
      setDragging(false);
      return;
    }
    setDragging(false);
    const travelled = Math.max(0, g.reduced ? g.lastY - g.startY : dragRef.current);
    const panelHeight = panelRef.current?.offsetHeight ?? window.innerHeight;
    const threshold = Math.max(96, panelHeight * 0.25);
    if (travelled <= threshold && g.velocity <= 0.5) {
      applyDragY(0);
      return;
    }
    if (prefersReducedMotion()) {
      onCloseRef.current();
      return;
    }
    // Let the panel finish travelling down before the parent unmounts it;
    // the scrim is already fading with the same value.
    applyDragY(panelHeight);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onCloseRef.current();
    }, 180);
  }

  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A frame, not synchronously: the panel is mounted in this commit, and
    // focusing before the browser has laid it out scrolls the *page* to it.
    const focusTimer = window.setTimeout(() => panelRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // One Escape, one layer.
        //
        // This listener is on `window` in the capture phase, so it runs before
        // anything the sheet contains, and several rows open their own
        // popover: team dispatch (`role="dialog"`), the branch filter
        // (`role="listbox"`), the folder browser (a focused dialog in a
        // portal). Each closes itself on Escape, and each is opened *without*
        // moving focus into it, so the event target is usually still the
        // trigger. Two tests, because one is not enough:
        //
        //   - where the event came from: a portaled dialog keeps focus, and
        //     only the target can say the sheet is not the top layer;
        //   - what is open inside the panel: an unfocused popover is invisible
        //     to the target test, and closing the sheet under it left the next
        //     Escape with nothing to close.
        const target = event.target as Element | null;
        const origin = target?.closest?.('[role="dialog"], [role="listbox"]');
        // A layer owned by the sheet may be portaled out of the panel: the run
        // settings' option layers leave the scrollport so the sheet's body
        // cannot clip them. They still count as open inside, or the first
        // Escape would close the sheet under the options.
        const openInside =
          panelRef.current?.querySelector('[role="dialog"], [role="listbox"]') ||
          document.querySelector("[data-sheet-layer]");
        if ((origin && origin !== panelRef.current) || openInside) return;
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      // A light trap: a modal that lets Tab walk into the page behind it is a
      // modal only visually. Without focusable children the panel keeps focus.
      const items = [
        ...Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)),
        // A portaled layer is not inside the panel, but it is still part of
        // this modal: Tab walking out of it into the page behind would leave
        // the layer floating over a screen the keyboard had moved on from.
        ...Array.from(document.querySelectorAll<HTMLElement>("[data-sheet-layer]")).flatMap(
          (layer) => Array.from(layer.querySelectorAll<HTMLElement>(FOCUSABLE)),
        ),
      ];
      if (items.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    // Back is the phone's other way out. The sheet owns one history entry; a
    // layer on top registers with `backStack`, so the first Back closes the
    // layer and the sheet keeps its entry for the next one.
    const marker = `kin-sheet-${Date.now()}-${Math.random()}`;
    const base = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.pushState({ ...base, kinSheet: marker }, "");
    let closedByBack = false;
    const onPopState = () => {
      if (dismissTopLayer()) {
        // The layer is gone but the sheet stayed; put the entry back so the
        // next Back still has something to close.
        window.history.pushState({ ...base, kinSheet: marker }, "");
        return;
      }
      closedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);
    // The panel is `md:hidden`. Past that width it is invisible but still
    // mounted, and its Escape/Tab trap keeps eating keys meant for the page
    // behind it; closing on the breakpoint is what makes "hidden" mean gone
    // (a tablet rotation, or a phone window dragged wide).
    let media: MediaQueryList | null = null;
    const onMediaChange = () => {
      if (media?.matches) onCloseRef.current();
    };
    if (typeof window.matchMedia === "function") {
      media = window.matchMedia("(min-width: 768px)");
      media.addEventListener?.("change", onMediaChange);
    }
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("popstate", onPopState);
      // A sheet closed by its own controls gives the entry back, so Back keeps
      // meaning "leave this page" instead of walking through a sheet the
      // reader already put away. Closed-by-Back already consumed it.
      const current = window.history.state as { kinSheet?: string } | null;
      if (!closedByBack && current?.kinSheet === marker) window.history.back();
      media?.removeEventListener?.("change", onMediaChange);
      restoreRef.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const panelHeight = panelRef.current?.offsetHeight || window.innerHeight || 1;
  const scrimOpacity = dragY > 0 ? Math.max(0, 1 - dragY / panelHeight) : undefined;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end md:hidden">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => onCloseRef.current()}
        className="kin-scrim-enter absolute inset-0 bg-black/55"
        style={{
          opacity: scrimOpacity,
          transition: dragging ? "none" : "opacity 180ms ease-out",
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        // A portaled layer is not in this subtree; claiming `aria-modal` while
        // it is up would tell a screen reader the layer does not exist.
        aria-modal={layers > 0 ? undefined : true}
        aria-label={title}
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={[
          "kin-sheet-surface relative z-10 flex max-h-[85dvh] flex-col rounded-t-2xl outline-none",
          gestureDriven ? "" : "kin-sheet-enter",
          "pb-[max(1rem,env(safe-area-inset-bottom))]",
          className,
        ].join(" ")}
        style={{
          transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? "none" : "transform 180ms cubic-bezier(0.2, 0, 0, 1)",
        }}
      >
        <div ref={gripRef} className="flex-none" style={{ touchAction: "none" }}>
          <div className="flex h-6 items-center justify-center">
            <div
              aria-hidden="true"
              className="h-[5px] w-9 rounded-full bg-[var(--kin-hairline-strong)]"
            />
          </div>
          {title ? (
            <div className="flex-none px-4 pb-2 pt-1 text-center">
              <h2 className="truncate text-subtitle font-semibold">{title}</h2>
              {subtitle ? (
                <p className="mt-0.5 truncate text-caption text-kin-muted">{subtitle}</p>
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          ref={bodyRef}
          data-sheet-body=""
          className={["min-h-0 flex-1 overflow-y-auto kin-scroll px-4 pb-1", bodyClassName].join(
            " ",
          )}
        >
          {children}
        </div>
        {footer ? <div className="flex-none px-4 pt-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/** The one primary action a sheet is allowed. 48px, full width, brand fill. */
export function SheetPrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-12 w-full items-center justify-center rounded-xl bg-kin-blue px-4 text-subtitle font-semibold text-kin-on-brand transition-[filter] hover:brightness-110 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** A quiet action under the primary one — "Cancel", "Reset". */
export function SheetSecondaryButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-full items-center justify-center rounded-xl text-strong font-medium text-kin-secondary active:bg-[var(--kin-fill)]"
    >
      {children}
    </button>
  );
}
