import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Dialog as AstryxDialog,
  DialogHeader,
  Layout,
  LayoutContent,
  LayoutFooter,
} from "@astryxdesign/core";

// @astryxdesign/core's Dialog calls CSS.escape(titleId) inside a mount effect
// even when closed, and jsdom omits globalThis.CSS.
if (typeof globalThis.CSS?.escape !== "function") {
  const escape = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  globalThis.CSS = Object.assign(globalThis.CSS ?? {}, { escape }) as typeof CSS;
}

/** Astryx's dismissal policies: `info` (Escape + backdrop), `form` (Escape), `required` (neither). */
export type DialogPurpose = "info" | "form" | "required";

export type DialogProps = {
  /** Controlled: the caller owns the open state. */
  open: boolean;
  /**
   * Asked to close by Escape, a backdrop press or the close control. Never
   * called for `required`, and only a request: a dirty-form guard may refuse
   * it and the dialog stays open.
   */
  onOpenChange: (open: boolean) => void;
  /** Accessible name, and the visible title the header renders. */
  label: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Dismissal policy; defaults to `info`. */
  purpose?: DialogPurpose;
  /** Preferred width. Numbers are pixels, strings are used as-is. */
  width?: number | string;
  /** Focus target after close; defaults to whatever was focused on open. */
  finalFocusRef?: RefObject<HTMLElement | null>;
  /** Extra classes on the dialog surface. Shape and dismissal stay the facade's. */
  className?: string;
};

/**
 * Kin's desktop modal, on Astryx's native `<dialog>`.
 *
 * The platform already owns most of a modal: `showModal()` enters the top
 * layer, makes the page behind inert, and keeps native focus and Escape
 * semantics. Astryx adds the controlled-React parts — the purpose policy, Tab
 * containment, and a header whose title names the dialog and takes initial
 * focus — so this is composition, not a second implementation.
 *
 * Kin's contribution is its call sites' contract: `open` / `onOpenChange`, a
 * visible `label`, `footer` as an action row, and focus return a caller can
 * point at a specific control. The return runs after Astryx closed the
 * element, so `finalFocusRef` wins over the opener. The dialog only *asks* to
 * close, which is what lets a leave guard veto Escape and keep the draft.
 *
 * Deliberately not owned: history entries, swipe dismissal, safe-area
 * arithmetic and the bottom-sheet shape. Those belong to the phone `Sheet`,
 * which stays the platform surface until F5c2 re-bases it on Astryx's
 * BottomSheet without changing its public API.
 */
const Dialog = forwardRef<HTMLDialogElement, DialogProps>(function Dialog(
  {
    open,
    onOpenChange,
    label,
    children,
    footer,
    purpose = "info",
    width,
    finalFocusRef,
    className,
  },
  ref,
) {
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const hasOpenedRef = useRef(false);

  // A layout effect lands before the dialog's passive effects move focus to
  // the title, and only the closed -> open edge captures, so the title is
  // never mistaken for the opener.
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
    }
    wasOpenRef.current = open;
  }, [open]);

  // Astryx closes the <dialog> and returns focus to the opener in its own
  // effect; this parent effect runs after that child effect, so a caller's
  // finalFocusRef can override the default without racing it.
  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true;
      return;
    }
    if (!hasOpenedRef.current) return;
    hasOpenedRef.current = false;
    (finalFocusRef?.current ?? openerRef.current)?.focus({ preventScroll: true });
  }, [open, finalFocusRef]);

  return (
    <AstryxDialog
      ref={ref}
      isOpen={open}
      onOpenChange={onOpenChange}
      purpose={purpose}
      width={width}
      aria-label={label}
      className={className}
    >
      <Layout
        header={
          <DialogHeader
            title={label}
            // A required flow has no exit control: only the action the caller
            // renders can finish it. Other purposes get Astryx's close control,
            // which asks through the same onOpenChange as Escape.
            onOpenChange={purpose === "required" ? undefined : onOpenChange}
          />
        }
        content={<LayoutContent>{children}</LayoutContent>}
        footer={footer ? <LayoutFooter hasDivider>{footer}</LayoutFooter> : undefined}
      />
    </AstryxDialog>
  );
});

export default Dialog;
