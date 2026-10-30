import { useT } from "../../i18n/react";
import { IconArchive, IconPin, IconRestore, IconTrash } from "../icons";

/**
 * One action chip's width, in px.
 *
 * The chips and the distance the row slides are two halves of one measurement:
 * a strip wider than the slide leaves its last chip under the row's opaque
 * cover, mounted but invisible. Exporting the single chip width and deriving
 * the strip from it keeps the two in step when an action is added or resized.
 */
export const SESSION_ROW_ACTION_CHIP_WIDTH = 76;

/** How far a row in the list slides to reveal pin, archive and delete. */
export const SESSION_ROW_ACTIONS_WIDTH = 3 * SESSION_ROW_ACTION_CHIP_WIDTH;

/** The archived view uncovers two actions — restore and delete — not three. */
export const SESSION_ROW_RESTORE_ACTIONS_WIDTH = 2 * SESSION_ROW_ACTION_CHIP_WIDTH;

/** Which strip a row uncovers: the list's actions, or the archive's. */
export type SessionRowActionMode = "active" | "archived";

export function sessionRowActionsWidth(mode: SessionRowActionMode): number {
  return mode === "archived" ? SESSION_ROW_RESTORE_ACTIONS_WIDTH : SESSION_ROW_ACTIONS_WIDTH;
}

/**
 * The actions a phone row uncovers when it slides.
 *
 * In the list: pin, archive and delete. Delete is here, not only inside the
 * session, because the list is where old conversations are scanned and the
 * place they are discarded from; a row that could hide but not remove a
 * session would be the one list action missing. Archive puts this one
 * conversation away — not its project, which is a different question asked in
 * the drawer.
 *
 * In the archive view the same gesture uncovers what that view is for: put the
 * conversation back, or delete it from here rather than restoring it first
 * only to delete it from the list.
 *
 * `pinned` flips the pin chip's label the way the batch toolbar does: the
 * action on a pinned row is to take it out of the pinned bucket, and a chip
 * that still said "Pin" would name the opposite of what it does.
 */
export default function SessionRowActions({
  mode = "active",
  pinned = false,
  onPin,
  onArchive,
  onRestore,
  onDelete,
}: {
  mode?: SessionRowActionMode;
  pinned?: boolean;
  onPin?: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onDelete: () => void;
}) {
  const tr = useT();
  const chip =
    "flex flex-none flex-col items-center justify-center gap-1 text-caption font-medium";
  if (mode === "archived") {
    return (
      <>
        <button
          type="button"
          onClick={onRestore}
          aria-label={tr("sessions.restore")}
          title={tr("sessions.restore")}
          style={{ width: SESSION_ROW_ACTION_CHIP_WIDTH }}
          className={`${chip} bg-kin-blue/15 text-kin-blue-ink`}
        >
          <IconRestore size={16} />
          {tr("sessions.restore")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={tr("sessions.delete")}
          title={tr("sessions.delete")}
          style={{ width: SESSION_ROW_ACTION_CHIP_WIDTH }}
          className={`${chip} bg-kin-red/15 text-kin-red-ink`}
        >
          <IconTrash size={16} />
          {tr("sessions.delete")}
        </button>
      </>
    );
  }
  const pinLabel = pinned ? tr("sessions.unpin") : tr("sessions.pin");
  return (
    <>
      <button
        type="button"
        onClick={onPin}
        aria-label={pinLabel}
        title={pinLabel}
        style={{ width: SESSION_ROW_ACTION_CHIP_WIDTH }}
        className={`${chip} bg-[var(--kin-fill-strong)] text-kin-text`}
      >
        <IconPin size={16} />
        {pinLabel}
      </button>
      <button
        type="button"
        onClick={onArchive}
        aria-label={tr("sessions.archive")}
        title={tr("sessions.archive")}
        style={{ width: SESSION_ROW_ACTION_CHIP_WIDTH }}
        className={`${chip} bg-kin-orange/15 text-kin-orange-ink`}
      >
        <IconArchive size={16} />
        {tr("sessions.archive")}
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={tr("sessions.delete")}
        title={tr("sessions.delete")}
        style={{ width: SESSION_ROW_ACTION_CHIP_WIDTH }}
        className={`${chip} bg-kin-red/15 text-kin-red-ink`}
      >
        <IconTrash size={16} />
        {tr("sessions.delete")}
      </button>
    </>
  );
}
