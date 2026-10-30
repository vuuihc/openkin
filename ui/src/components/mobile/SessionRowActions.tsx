import { useT } from "../../i18n/react";
import { IconArchive, IconPin, IconTrash } from "../icons";

/**
 * One action chip's width, in px.
 *
 * The chips and the distance the row slides are two halves of one measurement:
 * a strip wider than the slide leaves its last chip under the row's opaque
 * cover, mounted but invisible. Exporting the single chip width and deriving
 * the strip from it keeps the two in step when an action is added or resized.
 */
export const SESSION_ROW_ACTION_CHIP_WIDTH = 76;

/** How far the row slides to reveal its three actions. */
export const SESSION_ROW_ACTIONS_WIDTH = 3 * SESSION_ROW_ACTION_CHIP_WIDTH;

/**
 * The actions a phone row uncovers when it slides.
 *
 * Delete is here, not only inside the session, because the list is where old
 * conversations are scanned and the place they are discarded from; pin and
 * archive already live on this surface, and a row that could hide but not
 * remove a session would be the one list action missing. It is drawn in the
 * danger colour and its label is the button's accessible name, so the colour
 * is never the only signal.
 *
 * `pinned` flips the pin chip's label the way the batch toolbar does: the
 * action on a pinned row is to take it out of the pinned bucket, and a chip
 * that still said "Pin" would name the opposite of what it does.
 */
export default function SessionRowActions({
  pinned = false,
  onPin,
  onArchive,
  onDelete,
}: {
  pinned?: boolean;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const tr = useT();
  const pinLabel = pinned ? tr("sessions.unpin") : tr("sessions.pin");
  return (
    <>
      <button
        type="button"
        onClick={onPin}
        aria-label={pinLabel}
        title={pinLabel}
        style={{ width: SESSION_ROW_ACTION_CHIP_WIDTH }}
        className="flex flex-none flex-col items-center justify-center gap-1 bg-[var(--kin-fill-strong)] text-caption font-medium text-kin-text"
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
        className="flex flex-none flex-col items-center justify-center gap-1 bg-kin-orange/15 text-caption font-medium text-kin-orange-ink"
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
        className="flex flex-none flex-col items-center justify-center gap-1 bg-kin-red/15 text-caption font-medium text-kin-red-ink"
      >
        <IconTrash size={16} />
        {tr("sessions.delete")}
      </button>
    </>
  );
}
