import { useRef, type ReactNode } from "react";
import { useT } from "../../i18n/react";
import Sheet, { SheetSecondaryButton } from "../mobile/Sheet";
import { IconCheck } from "../icons";

/**
 * A list of actions on the console's own sheet.
 *
 * This replaces Ionic's `IonActionSheet`, which was the last thing in the
 * console drawn by a framework rather than by the token layer. The shape it
 * was used for is the same one every phone row needs: a title, a stack of
 * full-width choices, and one Cancel; a picker marks the current choice and a
 * destructive row takes the console's red ink instead of Ionic's unreadable
 * default.
 *
 * `Sheet` already owns the scrim, focus trap, Escape/Back dismissal, safe area
 * and the sheet surface, so this file is the list, not another modal.
 */
export type ActionSheetRow = {
  id: string;
  label: string;
  /** The current value in a picker. Marked for sight and for assistive tech. */
  selected?: boolean;
  /** A row that stops, deletes or otherwise cannot be undone. */
  destructive?: boolean;
  disabled?: boolean;
  /**
   * A second line under the label: the consequence of a row, or why a disabled
   * row cannot run. Shown for every row that sets it, and part of the row's
   * accessible name because it sits inside the button.
   */
  hint?: string;
  onSelect: () => void;
};

/**
 * The row button's classes, kept out of the JSX so the disabled treatment is
 * assertable. A disabled row recedes through its label's ink and loses the
 * hover/active fill; it never dims the whole button, because the `hint` under
 * the label is the reason the row cannot run and has to stay as readable as
 * any other muted body text on the sheet.
 */
export function actionSheetRowClass(
  row: Pick<ActionSheetRow, "disabled" | "destructive" | "selected">,
): string {
  return [
    "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-body transition-colors",
    row.destructive ? "text-kin-red-ink" : "text-kin-text",
    row.selected ? "bg-[var(--kin-fill-strong)] font-semibold" : "",
    row.disabled ? "cursor-default" : "hover:bg-[var(--kin-fill)] active:bg-[var(--kin-fill)]",
  ].join(" ");
}

/**
 * A disabled row's label is what recedes. The ink stays off the button so the
 * `hint` underneath keeps the contrast it has on an enabled row: it is the
 * sentence that explains the row, and it is the only thing on the sheet that
 * does.
 */
export function actionSheetLabelClass(row: Pick<ActionSheetRow, "disabled">): string {
  return row.disabled ? "w-full truncate text-kin-muted" : "w-full truncate";
}

export default function ActionSheet({
  open,
  onClose,
  title,
  subtitle,
  rows,
  anyWidth = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: ReactNode;
  rows: ActionSheetRow[];
  /** Keep a coarse-pointer tablet's sheet visible above the phone breakpoint. */
  anyWidth?: boolean;
}) {
  const tr = useT();
  // A row's action may navigate. The sheet's history entry is released in its
  // unmount cleanup, so running the action synchronously after `onClose()`
  // would push the next screen on top of a marker that is still current — and
  // Back would then show the same screen twice before leaving it.
  const pending = useRef<(() => void) | null>(null);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      onCloseComplete={() => {
        const action = pending.current;
        pending.current = null;
        action?.();
      }}
      title={title}
      subtitle={subtitle}
      anyWidth={anyWidth}
      bodyClassName="pb-2"
      footer={<SheetSecondaryButton onClick={onClose}>{tr("common.cancel")}</SheetSecondaryButton>}
    >
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              disabled={row.disabled}
              aria-current={row.selected ? "true" : undefined}
              onClick={() => {
                // The row runs from `onCloseComplete`, once the sheet's history
                // entry, focus trap and surface are gone. That is also what
                // makes a row that opens another layer safe: the next sheet
                // pushes onto a clean stack instead of racing this teardown.
                pending.current = row.onSelect;
                onClose();
              }}
              className={actionSheetRowClass(row)}
            >
              <span className="flex min-w-0 flex-1 flex-col items-start">
                <span className={actionSheetLabelClass(row)}>{row.label}</span>
                {row.hint ? (
                  <span className="whitespace-normal text-caption text-kin-muted">{row.hint}</span>
                ) : null}
              </span>
              {row.selected ? (
                <IconCheck size={14} className="flex-none text-kin-blue-ink" />
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
