import { useRef, useState, type RefObject } from "react";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useMinWidth } from "../../hooks/useMinWidth";
import { useT } from "../../i18n/react";
import { IconChevronDown } from "../icons";
import ActionSheet from "./ActionSheet";
import Menu from "./Menu";

export type SheetOption = {
  id: string;
  label: string;
  /** Destructive options are drawn in the danger colour on the phone's action
   *  sheet. The desktop menu uses the shared `Menu` row ink for every row. */
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
  /** The trigger node, for a caller that needs to return focus to it. */
  buttonRef?: RefObject<HTMLButtonElement | null>;
};

/**
 * A compact choice control with one shape per width.
 *
 * A native `<select>` on iOS opens a wheel that belongs to the system, not to
 * the console, and its closed state is a grey box that ignores the design
 * tokens. The phone therefore gets the console's action sheet — the bottom
 * layer the rest of the phone UI already uses, with the safe area and the
 * touch-target size built in.
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
  buttonRef?: RefObject<HTMLButtonElement | null>;
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
  // The floor follows the pointer, not the viewport: an iPad in portrait is
  // 820px wide and still a thumb, so `.touch-lg`'s 768px query left this chip
  // at 24px beside 44px controls. A mouse keeps the dense face.
  const coarse = useCoarsePointer();
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
        coarse ? "min-h-11 min-w-11" : "",
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

function labelOf({
  value,
  options,
  display,
  placeholder,
}: Pick<Props, "value" | "options" | "display" | "placeholder">): string {
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
  buttonRef,
}: Props) {
  const [open, setOpen] = useState(false);
  const current = labelOf({ value, options, display, placeholder });

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
        buttonRef={buttonRef}
        onClick={() => setOpen(true)}
      />
      <ActionSheet
        open={open}
        onClose={() => setOpen(false)}
        title={label}
        rows={options.map((option) => ({
          id: option.id,
          label: option.label,
          destructive: option.destructive,
          selected: option.id === value,
          onSelect: () => onChange(option.id),
        }))}
      />
    </>
  );
}

/**
 * The desktop shape: a menu that grows out of the chip.
 *
 * The panel is the shared `Menu` on the shared `Popover` layer, not a copy of
 * its machinery: viewport measurement (the composer's `overflow-x-auto`
 * control row would clip an absolutely positioned panel), the body portal,
 * outside-pointer and Escape dismissal, focus moving in and back to the chip,
 * Tab containment and the IME guard all belong to that layer. What remains
 * here is the domain mapping — which option is checked, and what choosing one
 * means.
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
  buttonRef,
}: Props) {
  const [open, setOpen] = useState(false);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  // A caller-supplied ref is the trigger ref: anchoring and focus return read
  // the same node, so there is only one object to keep in step.
  const triggerRef = buttonRef ?? fallbackRef;
  const current = labelOf({ value, options, display, placeholder });

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
      <Menu
        open={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        label={label}
        items={options.map((option) => ({
          id: option.id,
          label: option.label,
          checked: option.id === value,
          onSelect: () => onChange(option.id),
        }))}
        placement="above"
        align="left"
      />
    </span>
  );
}
