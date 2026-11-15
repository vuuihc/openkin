/* eslint-disable kin/no-raw-button -- The conversation row button and the
   inline hover/focus action buttons are moved verbatim out of SessionList.
   They are pre-existing controls, not a new surface, and restyling them onto
   the shared Button here would be a visual change this extraction must not
   make. */
import type { ReactNode } from "react";
import { useT } from "../../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../../lib/agentMention";
import type { PhoneSessionRow } from "../../lib/phoneSessionBuckets";
import { formatRelativeTime } from "../../lib/relativeTime";
import { rowSelectable } from "../../lib/sessionSelection";
import { sessionStatusDotClass } from "../../lib/sessionViewed";
import { taskCardStatusView } from "../../lib/taskCardStatus";
import HighlightedText from "../HighlightedText";
import { IconArchive, IconCheck, IconMachine, IconPin, IconRestore, IconTrash } from "../icons";
import SessionRowActions, {
  sessionRowActionsWidth,
  type SessionRowActionMode,
} from "../mobile/SessionRowActions";
import SwipeReveal from "../mobile/SwipeReveal";
import PendingBadge from "../ui/PendingBadge";
import type { SessionScopeFilter } from "../ui/SessionFilters";

/**
 * One conversation row, shared by the phone page and the Mac sidebar.
 *
 * The row owns only presentation and gesture: which conversation it is, what
 * to announce, and which actions the current container uncovers. Opening,
 * selecting, pinning, archiving, restoring and deleting are the parent's
 * handlers — the same set either way, so only the shortcut changes: inline
 * hover/focus controls in the sidebar, swipe and long-press on the page.
 *
 * `selectionMode` replaces the whole action surface with the selection control;
 * an imported row has no task and likewise carries no list actions.
 */
export type SessionRowProps = {
  row: PhoneSessionRow;
  deviceLabel: string;
  query: string;
  now: number;
  viewedIds: ReadonlySet<string>;
  pendingCount: number;
  active: boolean;
  onOpen: () => void;
  shell: "sidebar" | "page";
  coarse: boolean;
  selectionMode: boolean;
  selectionLocked: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onStartSelection: () => void;
  onLongPress: () => void;
  swipeOpen: boolean;
  onSwipeOpenChange: (open: boolean) => void;
  pinned: boolean;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRestore: () => void;
  scope: SessionScopeFilter;
};

export default function SessionRow({
  row,
  deviceLabel,
  now,
  viewedIds,
  pendingCount,
  active,
  onOpen,
  shell,
  coarse,
  selectionMode,
  selectionLocked,
  selected,
  onToggleSelect,
  onStartSelection,
  onLongPress,
  swipeOpen,
  onSwipeOpenChange,
  pinned,
  onPin,
  onArchive,
  onDelete,
  onRestore,
  scope,
  query,
}: SessionRowProps) {
  const tr = useT();
  const dot = row.task ? sessionStatusDotClass(row.task.status, viewedIds.has(row.task.id)) : null;
  const avatar = agentAvatarMeta(row.agentId);
  const label = [
    row.title,
    agentDisplayName(row.agentId),
    formatRelativeTime(row.at, now),
    row.task && dot ? tr(taskCardStatusView(row.task.status).labelKey) : "",
    pendingCount > 0 ? tr("sessions.pendingApprovals", { count: String(pendingCount) }) : "",
    row.remote ? deviceLabel || tr("machine.remote") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const gutter = shell === "sidebar" ? "px-2" : "px-4";

  const rowButton = (
    <button
      type="button"
      data-session-row={row.task?.id ?? row.session?.id}
      onClick={() => {
        if (selectionMode) {
          if (rowSelectable(row, scope) && !selectionLocked) onToggleSelect();
          return;
        }
        if (swipeOpen) {
          onSwipeOpenChange(false);
          return;
        }
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          if (!rowSelectable(row, scope) || selectionLocked) return;
          // Shift+Enter is the keyboard's long press: outside the mode it
          // enters through the same door as the pointer path.
          if (selectionMode) onToggleSelect();
          else onStartSelection();
        }
      }}
      aria-disabled={selectionMode && selectionLocked ? true : undefined}
      aria-label={label}
      aria-pressed={selectionMode ? selected : undefined}
      className={[
        "kin-row-press flex min-h-11 w-full items-center gap-2.5 py-2.5 text-left",
        gutter,
        selectionMode && selected ? "bg-[var(--kin-fill)]" : "",
        active ? "bg-[var(--kin-fill-strong)]" : "",
      ].join(" ")}
    >
      <span className="flex w-2 flex-none justify-center">
        {selectionMode && rowSelectable(row, scope) ? (
          <span
            className={[
              "flex h-4 w-4 items-center justify-center rounded-full border",
              selected
                ? "border-kin-blue bg-kin-blue text-kin-on-brand"
                : "border-[var(--kin-hairline-strong)]",
            ].join(" ")}
            aria-hidden
          >
            {selected ? <IconCheck size={10} strokeWidth={2.5} /> : null}
          </span>
        ) : dot ? (
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
        ) : null}
      </span>
      <span
        className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-micro font-semibold ${avatar.className}`}
        title={agentDisplayName(row.agentId)}
      >
        {avatar.initials}
      </span>
      <span
        className={[
          "min-w-0 flex-1 truncate leading-ui text-kin-text",
          shell === "sidebar" ? "text-body font-normal" : "text-subtitle font-medium",
        ].join(" ")}
      >
        <HighlightedText text={row.title} query={query} />
      </span>
      {row.remote && (
        <span
          className="flex-none text-kin-muted"
          title={deviceLabel || tr("machine.remote")}
          aria-hidden
        >
          <IconMachine size={12} />
        </span>
      )}
      <PendingBadge count={pendingCount} />
      {deviceLabel ? (
        <span className="max-w-[6rem] flex-none truncate text-caption leading-ui text-kin-muted">
          {deviceLabel}
        </span>
      ) : null}
      <span className="flex-none text-caption leading-ui text-kin-muted tabular-nums">
        {formatRelativeTime(row.at, now)}
      </span>
    </button>
  );

  // A row uncovers the strip that describes where it is. In the archive view
  // that is restore + delete, and only for a conversation that was archived on
  // its own: a live chat listed under an archived project is put back by the
  // project's own Restore, and a per-row "Restore" there would do nothing.
  if (selectionMode || !row.task) return rowButton;
  const mode: SessionRowActionMode | null = row.task.archived_at
    ? "archived"
    : scope === "archived"
      ? null
      : "active";
  if (!mode) return rowButton;

  // The desktop's overflow is hover/focus-revealed inline controls; the phone's
  // is the swipe strip. Both call the same handlers, so the feature set is the
  // same and only the gesture that uncovers it differs.
  if (shell === "sidebar" && !coarse) {
    return (
      <div
        className={[
          "group/session flex items-center rounded-lg",
          active ? "bg-[var(--kin-fill-strong)]" : "",
        ].join(" ")}
      >
        <div className="min-w-0 flex-1">{rowButton}</div>
        <div className="flex flex-none items-center gap-0.5 pr-2">
          {mode === "active" && (
            <RowIconButton
              label={pinned ? tr("sessions.unpin") : tr("sessions.pin")}
              onClick={onPin}
            >
              <IconPin size={12} />
            </RowIconButton>
          )}
          <RowIconButton
            label={mode === "archived" ? tr("sessions.restore") : tr("sessions.archive")}
            onClick={mode === "archived" ? onRestore : onArchive}
          >
            {mode === "archived" ? <IconRestore size={12} /> : <IconArchive size={12} />}
          </RowIconButton>
          <RowIconButton label={tr("sessions.delete")} onClick={onDelete} danger>
            <IconTrash size={12} />
          </RowIconButton>
        </div>
      </div>
    );
  }

  return (
    <SwipeReveal
      open={swipeOpen}
      onOpenChange={onSwipeOpenChange}
      onLongPress={onLongPress}
      width={sessionRowActionsWidth(mode)}
      actions={
        <SessionRowActions
          mode={mode}
          pinned={pinned}
          onPin={onPin}
          onArchive={onArchive}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      }
    >
      {rowButton}
    </SwipeReveal>
  );
}

function RowIconButton({
  label,
  onClick,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={[
        "touch-hide inline-flex h-6 w-6 items-center justify-center rounded-md text-kin-muted opacity-0 transition-opacity focus:opacity-100 group-hover/session:opacity-100",
        danger
          ? "hover:bg-kin-red/10 hover:text-kin-red-ink"
          : "hover:bg-[var(--kin-fill-strong)] hover:text-kin-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
