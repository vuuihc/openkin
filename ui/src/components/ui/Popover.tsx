import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "../../hooks/useAnchoredPanel";

/**
 * The elements a dialog may hold focus on. The panel itself is focusable with
 * `tabIndex={-1}` but is deliberately not in this list: it is the fallback
 * when the content has nothing to focus, not a stop of its own.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export type PopoverProps = {
  /** Controlled: the caller owns the trigger's click and its `open` state. */
  open: boolean;
  /** Asked to close by an outside pointer or Escape. Never called on mount. */
  onOpenChange: (open: boolean) => void;
  /**
   * The element the panel hangs from. The caller already has it for the
   * trigger's own `aria-expanded` / `aria-controls`, so the primitive borrows
   * the same ref instead of wrapping the trigger in a second component.
   */
  triggerRef: RefObject<HTMLElement | null>;
  /** Accessible name of the dialog. The caller's visible label, not new text. */
  label: string;
  /** Panel id, so the caller's trigger can point `aria-controls` at it. */
  id?: string;
  children: ReactNode;
  /** Preferred side; the shared hook flips it when that side has no room. */
  placement?: "above" | "below";
  /** Edge of the trigger the panel lines up with. */
  align?: "left" | "right";
  /** Fixed width. Omit to match the trigger's measured width. */
  width?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Panel classes for the content's own density; shape stays the primitive's. */
  className?: string;
};

/**
 * A controlled, viewport-anchored panel portaled to `<body>`.
 *
 * `useAnchoredPanel` owns where it goes: the trigger often sits inside an
 * `overflow-*` strip (the composer's control row is one) where an absolutely
 * positioned panel is clipped, so placement is measured from the viewport and
 * re-measured on resize, scroll and the trigger's own size change.
 *
 * This primitive owns only the generic layer behavior: outside-pointer and
 * Escape dismissal, focus moving into the panel after the anchor has actually
 * been measured (a panel portaled from a layout effect is not in the DOM on
 * the render `open` first turns true), Tab staying inside while it is open,
 * focus returning to the trigger on Escape, and every document listener being
 * removed on close. Escape only answers when focus is in this layer — a panel
 * in the corner must not close on an Escape pressed in the conversation
 * (TASTE rule 16).
 *
 * Deliberately not owned: domain options, data loading, model/agent/permission
 * selection, arrow-key item navigation (the menu built on top owns its own
 * role and keys in Q3b), and the phone's bottom-sheet behavior — a desktop
 * popover must not become a sheet here.
 */
export default function Popover({
  open,
  onOpenChange,
  triggerRef,
  label,
  id,
  children,
  placement = "below",
  align = "left",
  width,
  maxWidth,
  maxHeight,
  className,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const panelId = id ?? generatedId;
  const anchor = useAnchoredPanel(open, triggerRef, {
    placement,
    align,
    width,
    maxWidth,
    maxHeight,
  });
  // The panel is portaled a render after `open` turns true, so this is the
  // key that says "there is content to focus", not `open` itself.
  const anchored = Boolean(anchor);

  useEffect(() => {
    if (!open) return;
    const inside = (node: Node | null) =>
      Boolean(node && (triggerRef.current?.contains(node) || panelRef.current?.contains(node)));

    const onPointerDown = (event: MouseEvent) => {
      if (inside(event.target as Node)) return;
      onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Only the layer the reader is in answers the key. A panel left open
      // elsewhere must not swallow an Escape meant for the conversation.
      if (!inside(document.activeElement)) return;
      event.preventDefault();
      onOpenChange(false);
      // The panel is the thing holding focus and it is about to go away.
      // Without this the next Tab starts at the top of the page.
      triggerRef.current?.focus({ preventScroll: true });
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange, triggerRef]);

  useEffect(() => {
    if (!open || !anchored) return;
    const panel = panelRef.current;
    if (!panel) return;
    // A dialog with no focusable content still takes focus itself, so Escape
    // and Tab do not belong to whatever was focused before it opened.
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus({ preventScroll: true });
  }, [open, anchored]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      event.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (active === last || active === panel)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  if (!open || !anchor) return null;

  return createPortal(
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      style={{
        left: anchor.left,
        width: anchor.width,
        maxHeight: anchor.maxHeight,
        top: anchor.top,
        bottom: anchor.bottom,
      }}
      className={[
        "fixed z-50 overflow-y-auto kin-scroll rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated p-1.5 shadow-e3 focus:outline-none",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>,
    document.body,
  );
}
