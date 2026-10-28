import { IonActionSheet } from "@ionic/react";
import type { ActionSheetButton } from "@ionic/core";
import { useState } from "react";
import { useT } from "../../i18n/react";
import { IconChevronDown } from "../icons";

export type SheetOption = {
  id: string;
  label: string;
  /** Destructive options are drawn in the danger colour by Ionic. */
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
 * A compact choice control for the phone.
 *
 * A native `<select>` on iOS opens a wheel that belongs to the system, not to
 * the console, and its closed state is a grey box that ignores the design
 * tokens. Ionic's action sheet is the same interaction the platform would
 * draw, themed by the console, and it already gets the safe area and the
 * touch-target size right — so every small choice on a page can be this one
 * control instead of a hand-tuned select per corner.
 */
export default function SheetSelect({
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
  const current =
    display ?? options.find((option) => option.id === value)?.label ?? placeholder ?? value;

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
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={`${label}${tr("common.labelSeparator")}${current}`}
        aria-haspopup="dialog"
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
