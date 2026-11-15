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
  onSelect: () => void;
};

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
              className={[
                "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-body transition-colors",
                row.destructive ? "text-kin-red-ink" : "text-kin-text",
                row.selected ? "bg-[var(--kin-fill-strong)] font-semibold" : "",
                row.disabled
                  ? "opacity-40"
                  : "hover:bg-[var(--kin-fill)] active:bg-[var(--kin-fill)]",
              ].join(" ")}
            >
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
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
