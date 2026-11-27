import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "../../hooks/useAnchoredPanel";
import { isImeKeyEvent } from "../../lib/ime";

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

/**
 * Whether a selector match is a usable Tab stop, not just a match.
 *
 * A hidden control still matches `button:not([disabled])`: Tab containment
 * that trusts the selector alone wraps onto a control nobody can see, and the
 * next Tab lands on `<body>` while the dialog still claims to be modal.
 * `display: none` is not inherited in the computed style, so an ancestor
 * that hides the control has to be walked; `visibility` is inherited, so the
 * control's own computed value already speaks for its ancestors.
 */
function isUsableFocusTarget(element: HTMLElement, panel: HTMLElement): boolean {
  if (element.tabIndex < 0) return false;
  const own = window.getComputedStyle(element);
  if (own.visibility === "hidden" || own.visibility === "collapse") return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hasAttribute("inert")) return false;
    if (window.getComputedStyle(node).display === "none") return false;
    if (node === panel) break;
  }
  return true;
}

/** The stops a Tab press may visit in this panel, in document order. */
function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) =>
    isUsableFocusTarget(element, panel),
  );
}

/**
 * One open popover. The refs are read at event time, so a panel that is
 * portaled a render after `open` turns true, or a trigger the caller swaps,
 * never leaves a stale element behind in the registry.
 */
type PopoverLayer = {
  panelRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  /** The layer this one was opened from, when popovers nest. */
  parent: PopoverLayer | null;
};

/** The layers open right now, so one layer can see the others. */
const openLayers = new Set<PopoverLayer>();

/**
 * Escapes already answered during this dispatch. Document listeners run in
 * registration order, which React does not promise across renders, so the
 * topmost layer claims the event instead of assuming it runs last.
 */
const answeredEscapes = new WeakSet<Event>();

/** The popover whose panel is rendering this subtree, if any. */
const PopoverLayerContext = createContext<PopoverLayer | null>(null);

function depthOf(layer: PopoverLayer): number {
  let depth = 0;
  for (let cursor = layer.parent; cursor; cursor = cursor.parent) depth += 1;
  return depth;
}

/** Whether `layer` was opened from inside `ancestor`, at any depth. */
function isWithinLayer(layer: PopoverLayer, ancestor: PopoverLayer): boolean {
  for (let cursor = layer.parent; cursor; cursor = cursor.parent) {
    if (cursor === ancestor) return true;
  }
  return false;
}

/**
 * Everything this layer owns: its own panel and trigger, plus the panels and
 * triggers of layers opened from inside it. A nested popover portals its panel
 * to `<body>`, so DOM containment alone would call its panel "outside" and
 * dismiss the parent behind it.
 */
function reaches(layer: PopoverLayer, node: Node | null): boolean {
  if (!node) return false;
  if (layer.panelRef.current?.contains(node) || layer.triggerRef.current?.contains(node)) {
    return true;
  }
  for (const other of openLayers) {
    if (other === layer || !isWithinLayer(other, layer)) continue;
    if (other.panelRef.current?.contains(node) || other.triggerRef.current?.contains(node)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the chain of layers `layer` belongs to holds `node` — its own reach
 * or that of any layer it was opened from.
 *
 * Focus can sit on a parent panel's header while a nested layer is open. The
 * nested layer is still the one the reader opened last, and it must take the
 * first Escape even though the caret is in its parent: otherwise the parent's
 * handler runs first and the nested panel is left floating over a layer that
 * no longer exists.
 */
function chainReaches(layer: PopoverLayer, node: Node | null): boolean {
  for (let cursor: PopoverLayer | null = layer; cursor; cursor = cursor.parent) {
    if (reaches(cursor, node)) return true;
  }
  return false;
}

/**
 * The deepest open layer in focus's chain. One Escape belongs to one layer:
 * the deepest one, whatever order listeners run in.
 */
function topLayerAt(node: Node | null): PopoverLayer | null {
  let top: PopoverLayer | null = null;
  let topDepth = -1;
  for (const layer of openLayers) {
    if (!chainReaches(layer, node)) continue;
    const depth = depthOf(layer);
    if (depth >= topDepth) {
      top = layer;
      topDepth = depth;
    }
  }
  return top;
}

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
  /**
   * Whether the panel draws its own inner padding. A list that draws sheared
   * header/footer rows of its own (`BranchPicker`, `PlacePicker`) passes false:
   * the base `p-1.5` is emitted after the caller's `p-0` in the compiled
   * stylesheet, so a caller cannot turn it off with a class.
   */
  padded?: boolean;
  /**
   * Extra DOM this layer treats as its own for the outside-pointer test: a
   * selector matched against the target's ancestors. A caller whose content
   * opens layers the primitive does not build (a picker in `extraRows`) passes
   * their markers, so a press inside one is not read as "outside" and does not
   * dismiss this panel — unmounting the picker — before its click lands.
   * Pointer-only by design: Escape still answers to focus in this layer's
   * chain, so a key pressed elsewhere does not close a panel here.
   */
  pointerReach?: string;
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
 * skipping controls that cannot actually take focus, focus returning to the
 * trigger on Escape, and every document listener being removed on close.
 * Escape only answers when focus is in this layer — a panel in the corner must
 * not close on an Escape pressed in the conversation (TASTE rule 16) — and an
 * Escape during an IME composition belongs to the composition, not the layer.
 *
 * Popovers nest (a picker opened from a panel opened from the composer). A
 * layer therefore counts a nested layer's portaled panel as its own reach, and
 * exactly one Escape dismisses exactly one layer: the deepest open one in
 * focus's chain, independent of document-listener order. That holds even when
 * focus is on the parent's own header — the nested layer was opened last, so
 * it takes the first Escape.
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
  padded = true,
  pointerReach,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const parentLayer = useContext(PopoverLayerContext);
  const layerRef = useRef<PopoverLayer | null>(null);
  if (layerRef.current === null) {
    layerRef.current = { panelRef, triggerRef, parent: parentLayer };
  }
  const layer = layerRef.current;
  const generatedId = useId();
  const panelId = id ?? generatedId;
  const anchor = useAnchoredPanel(open, triggerRef, {
    placement,
    align,
    width,
    maxWidth,
    maxHeight,
    // The panel's own content height is what decides the side: a menu clamped
    // to a short column below its trigger hides its last rows behind an
    // invisible scrollbar, so the hook flips it after the panel mounts.
    panelRef,
  });
  // The panel is portaled a render after `open` turns true, so this is the
  // key that says "there is content to focus", not `open` itself.
  const anchored = Boolean(anchor);

  useEffect(() => {
    if (!open) return;
    // The caller may hand a different trigger ref on a later render; the
    // registry reads refs at event time, so keep the layer pointing at the
    // one the current render uses.
    layer.triggerRef = triggerRef;
    openLayers.add(layer);

    const onPointerDown = (event: PointerEvent) => {
      // A layer opened from inside this one is still this layer's reach: a
      // click in the nested panel must not dismiss the parent behind it.
      if (reaches(layer, event.target as Node)) return;
      // A layer the caller owns (not a `Popover`) is opted in by its markers;
      // see `pointerReach`. Pointer-only: Escape below stays scoped to focus in
      // this layer's chain.
      if (pointerReach && event.target instanceof Element && event.target.closest(pointerReach)) {
        return;
      }
      onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isImeKeyEvent(event)) return;
      // Only the layer the reader is in answers the key. A panel left open
      // elsewhere must not swallow an Escape meant for the conversation. A
      // nested layer counts as "where the reader is" anywhere in its chain.
      if (!chainReaches(layer, document.activeElement)) return;
      // Nested layers each install their own document listener, and React
      // gives no order guarantee across re-renders: the deepest layer under
      // focus claims the Escape, so one press dismisses one layer whether the
      // child's listener ran before or after this one.
      if (topLayerAt(document.activeElement) !== layer) return;
      if (answeredEscapes.has(event)) return;
      answeredEscapes.add(event);
      event.preventDefault();
      onOpenChange(false);
      // The panel is the thing holding focus and it is about to go away.
      // Without this the next Tab starts at the top of the page.
      triggerRef.current?.focus({ preventScroll: true });
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      openLayers.delete(layer);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange, triggerRef, layer, pointerReach]);

  useEffect(() => {
    if (!open || !anchored) return;
    const panel = panelRef.current;
    if (!panel) return;
    // Content that placed focus itself during the commit keeps it: a field
    // with `autoFocus`, a list that opens on the current choice. The panel's
    // fallback only fills an empty focus, it does not overrule the content.
    if (panel.contains(document.activeElement)) return;
    // A dialog with no focusable content still takes focus itself, so Escape
    // and Tab do not belong to whatever was focused before it opened. Hidden
    // controls are skipped: focusing one would put focus somewhere the reader
    // cannot see.
    const [first] = focusableWithin(panel);
    (first ?? panel).focus({ preventScroll: true });
  }, [open, anchored]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusableWithin(panel);
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
    <PopoverLayerContext.Provider value={layer}>
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
          "fixed z-50 overflow-y-auto kin-scroll rounded-2xl kin-glass-float focus:outline-none",
          padded ? "p-1.5" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </div>
    </PopoverLayerContext.Provider>,
    document.body,
  );
}
