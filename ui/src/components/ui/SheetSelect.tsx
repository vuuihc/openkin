import { IonActionSheet } from "@ionic/react";
import type { ActionSheetButton } from "@ionic/core";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n/react";
import { useAnchoredPanel } from "../../hooks/useAnchoredPanel";
import { useMinWidth } from "../../hooks/useMinWidth";
import { IconCheck, IconChevronDown } from "../icons";

export type SheetOption = {
  id: string;
  label: string;
  /** Destructive options are drawn in the danger colour. */
  destructive?: boolean;
};

type Props = {
  /** The sheet's own heading, e.g. "Permission" — not a visible form label. */
  label: string;
  value: string;
  options: SheetOption[];
  onChange: (id: string) => void;
  /** Text on the trigger when the value is not one of the options. */
  display?: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Draws the chip's own hairline. Off inside a joined control (the composer's
   * agent ▸ model chip) whose container already draws one — two borders 1px
   * apart is the seam that reads as a rendering bug.
   */
  bordered?: boolean;
  /**
   * Extra classes for the trigger: the width cap and the ink, because a chip
   * that stands alone in a row and one joined to a sibling in the composer's
   * footer are not the same width and do not read at the same ink. The shape
   * (border, radius, padding, type size) stays the primitive's.
   */
  className?: string;
};

/**
 * A compact choice control with one shape per width.
 *
 * A native `<select>` on iOS opens a wheel that belongs to the system, not to
 * the console, and its closed state is a grey box that ignores the design
 * tokens. The phone therefore gets Ionic's action sheet — the interaction the
 * platform would draw, themed by the console, with the safe area and the
 * touch-target size already right.
 *
 * A Mac is not a phone: the same chip used to open that sheet in the middle of
 * a desktop window, over the composer it was configuring. Above the breakpoint
 * the chip opens a menu anchored to itself, the shape every other desktop
 * picker in the console uses. The two shapes share the trigger so the control
 * reads the same in both; only what it opens changes.
 */
export default function SheetSelect(props: Props) {
  const wide = useMinWidth(768);
  return wide ? <MenuSelect {...props} /> : <ActionSheetSelect {...props} />;
}

type ChipProps = {
  label: string;
  current: string;
  open: boolean;
  hasPopup: "dialog" | "menu";
  disabled?: boolean;
  bordered: boolean;
  className?: string;
  buttonRef?: RefObject<HTMLButtonElement>;
  onClick: () => void;
};

/** The face of the control, identical on both widths. */
function Chip({
  label,
  current,
  open,
  hasPopup,
  disabled,
  bordered,
  className,
  buttonRef,
  onClick,
}: ChipProps) {
  const tr = useT();
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`${label}${tr("common.labelSeparator")}${current}`}
      aria-haspopup={hasPopup}
      aria-expanded={open}
      title={current}
      className={[
        // `text-body`, not `text-caption`: this is a chosen value on a phone,
        // and 12px read as metadata rather than as the thing that was picked.
        "inline-flex flex-none items-center gap-1 rounded-lg bg-transparent px-1.5 py-0.5 text-body font-medium",
        bordered ? "border border-[var(--kin-hairline-strong)]" : "",
        "focus:outline-none focus:ring-1 focus:ring-kin-focus-ring",
        disabled ? "opacity-70 cursor-default" : "cursor-pointer hover:text-kin-text",
        className ?? "text-kin-text",
      ].join(" ")}
    >
      <span className="truncate">{current}</span>
      <IconChevronDown size={11} className="flex-none opacity-70" />
    </button>
  );
}

function labelOf(
  { value, options, display, placeholder }: Pick<Props, "value" | "options" | "display" | "placeholder">,
): string {
  return display ?? options.find((option) => option.id === value)?.label ?? placeholder ?? value;
}

function ActionSheetSelect({
  label,
  value,
  options,
  onChange,
  display,
  placeholder,
  disabled,
  bordered = true,
  className,
}: Props) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const current = labelOf({ value, options, display, placeholder });

  const buttons: ActionSheetButton[] = [
    ...options.map((option) => ({
      text: option.label,
      role: option.destructive ? ("destructive" as const) : undefined,
      cssClass: option.id === value ? "kin-sheet-selected" : undefined,
      // Ionic only marks a selected row for radio-style buttons, and those
      // keep the sheet open after a tap. This is a plain button that closes
      // the sheet, so the current value is named for assistive tech instead.
      htmlAttributes: option.id === value ? { "aria-current": "true" } : undefined,
      handler: () => onChange(option.id),
    })),
    { text: tr("common.cancel"), role: "cancel" },
  ];

  return (
    <>
      <Chip
        label={label}
        current={current}
        open={open}
        hasPopup="dialog"
        disabled={disabled}
        bordered={bordered}
        className={className}
        onClick={() => setOpen(true)}
      />
      <IonActionSheet
        isOpen={open}
        onDidDismiss={() => setOpen(false)}
        header={label}
        cssClass="kin-sheet"
        buttons={buttons}
      />
    </>
  );
}

/**
 * The desktop shape: a menu that grows out of the chip.
 *
 * Same rules as the permission chip's menu — measured from the viewport
 * because the composer's `overflow-x-auto` control row would clip an
 * absolutely positioned panel, portaled to <body> for the same reason,
 * Escape/outside/focus-out closes without answering, and choosing returns
 * focus to the chip so the keyboard does not fall to the top of the page.
 */
function MenuSelect({
  label,
  value,
  options,
  onChange,
  display,
  placeholder,
  disabled,
  bordered = true,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = labelOf({ value, options, display, placeholder });
  const anchor = useAnchoredPanel(open, triggerRef, {
    placement: "above",
    align: "left",
    width: 240,
    maxHeight: 360,
  });
  // The panel renders a layout effect after the click that opened it, so the
  // menu is not in the DOM on the render `open` first turns true. Keying the
  // focus step on the measured anchor is what makes it run when there is a
  // row to focus.
  const anchored = Boolean(anchor);

  useEffect(() => {
    if (!open) return;
    const inside = (node: Node | null) =>
      Boolean(node && (triggerRef.current?.contains(node) || menuRef.current?.contains(node)));
    const onPointerDown = (event: MouseEvent) => {
      if (inside(event.target as Node)) return;
      setOpen(false);
    };
    const onFocus = (event: FocusEvent) => {
      // Tabbing out closes the menu: it is a layer over the page, not a
      // section of the tab order that keeps going after the last item.
      if (inside(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Only the layer the reader is in answers the key. A menu left in the
      // corner closing on an Escape pressed somewhere else — and moving focus
      // to its chip — is worse than the menu staying open.
      if (!inside(event.target as Node) && !inside(document.activeElement)) return;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("focus", onFocus, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("focus", onFocus, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !anchored) return;
    // Opening with the keyboard lands on the current choice, not the first
    // row: the next arrow then moves relative to what is set.
    const rows = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    (menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]') ??
      rows?.[0])?.focus({ preventScroll: true });
  }, [open, anchored]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[Math.min(at + 1, items.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[Math.max(at - 1, 0)]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const pick = (id: string) => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    onChange(id);
  };

  return (
    <span className="relative inline-flex min-w-0 flex-none">
      <Chip
        label={label}
        current={current}
        open={open}
        hasPopup="menu"
        disabled={disabled}
        bordered={bordered}
        className={className}
        buttonRef={triggerRef}
        onClick={() => setOpen((value) => !value)}
      />
      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={label}
              onKeyDown={onMenuKeyDown}
              style={{
                left: anchor.left,
                width: anchor.width,
                maxHeight: anchor.maxHeight,
                top: anchor.top,
                bottom: anchor.bottom,
              }}
              className="fixed z-50 overflow-y-auto kin-scroll rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated p-1 shadow-e3"
            >
              {options.map((option) => {
                const selected = option.id === value;
                return (
                  <button
                    key={option.id || "__none"}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => pick(option.id)}
                    className={[
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                      "hover:bg-[var(--kin-fill-strong)] focus:bg-[var(--kin-fill-strong)] focus:outline-none",
                      option.destructive
                        ? "text-kin-red-ink"
                        : selected
                          ? "text-kin-text"
                          : "text-kin-secondary",
                    ].join(" ")}
                  >
                    <span className="min-w-0 flex-1 truncate text-body">{option.label}</span>
                    {selected ? (
                      <IconCheck size={13} className="flex-none text-kin-blue-ink" />
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
