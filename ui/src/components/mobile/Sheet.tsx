import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
 * and the one thing Ionic would add — swipe-to-dismiss — is not worth a second
 * design system owning the inside of the box.
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
  // The parent re-renders on every keystroke in some sheets (the composer's
  // controls), and an effect that depended on `onClose` would tear down and
  // re-run on each of those — restoring focus to the opener mid-typing.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

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
        const openInside = panelRef.current?.querySelector('[role="dialog"], [role="listbox"]');
        if ((origin && origin !== panelRef.current) || openInside) return;
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      // A light trap: a modal that lets Tab walk into the page behind it is a
      // modal only visually. Without focusable children the panel keeps focus.
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
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
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end md:hidden">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => onCloseRef.current()}
        className="kin-scrim-enter absolute inset-0 bg-black/55"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={[
          "kin-sheet-surface kin-sheet-enter relative z-10 flex max-h-[85dvh] flex-col rounded-t-2xl outline-none",
          "pb-[max(1rem,env(safe-area-inset-bottom))]",
          className,
        ].join(" ")}
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-[5px] w-9 flex-none rounded-full bg-[var(--kin-hairline-strong)]" />
        {title ? (
          <div className="flex-none px-4 pb-2 pt-3 text-center">
            <h2 className="truncate text-subtitle font-semibold">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 truncate text-caption text-kin-muted">{subtitle}</p>
            ) : null}
          </div>
        ) : null}
        <div className={["min-h-0 flex-1 overflow-y-auto kin-scroll px-4 pb-1", bodyClassName].join(" ")}>
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
