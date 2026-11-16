import type { ReactNode } from "react";
import { useT } from "../../i18n/react";
import { IconArchive, IconPin, IconRestore, IconTrash } from "../icons";
import Button from "../ui/Button";

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
 * A chip's own surface.
 *
 * The chip is a tinted strip, not one of the three standard action weights, so
 * every surface token below is a utility: utilities sit above `components` in
 * `index.css`, and that is what lets the chip keep its tint while the facade
 * still supplies the geometry, press feedback and focus ring.
 */
const CHIP =
  "flex h-full flex-none flex-col items-center justify-center gap-0 rounded-sm p-0 text-caption font-medium hover:brightness-100";

/**
 * The actions a phone row uncovers when it slides.
 *
 * In the list: pin, archive and delete. Delete is here, not only inside the
 * session, because the list is where old conversations are scanned and the
 * place they are discarded from; a row that could hide but not remove a
 * session would be the one list action missing. Archive puts this one
 * conversation away — not its project, which is a different question asked in
 * the list.
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
  if (mode === "archived") {
    return (
      <>
        <Chip
          label={tr("sessions.restore")}
          onClick={onRestore}
          className="bg-kin-blue/15 text-kin-blue-ink"
        >
          <IconRestore size={16} />
        </Chip>
        <Chip
          label={tr("sessions.delete")}
          onClick={onDelete}
          className="bg-kin-red/15 text-kin-red-ink"
        >
          <IconTrash size={16} />
        </Chip>
      </>
    );
  }
  const pinLabel = pinned ? tr("sessions.unpin") : tr("sessions.pin");
  return (
    <>
      <Chip label={pinLabel} onClick={onPin} className="bg-[var(--kin-fill-strong)] text-kin-text">
        <IconPin size={16} />
      </Chip>
      <Chip
        label={tr("sessions.archive")}
        onClick={onArchive}
        className="bg-kin-orange/15 text-kin-orange-ink"
      >
        <IconArchive size={16} />
      </Chip>
      <Chip
        label={tr("sessions.delete")}
        onClick={onDelete}
        className="bg-kin-red/15 text-kin-red-ink"
      >
        <IconTrash size={16} />
      </Chip>
    </>
  );
}

function Chip({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick?: () => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <Button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{ width: SESSION_ROW_ACTION_CHIP_WIDTH }}
      className={`${CHIP} ${className}`}
    >
      {/* The facade wraps its content in one inline row; the chip's own
          column keeps the icon above the word that names the action. */}
      <span className="flex flex-col items-center justify-center gap-1">
        {children}
        {label}
      </span>
    </Button>
  );
}
