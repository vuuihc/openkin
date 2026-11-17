import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../../lib/agentMention";
import type { PhoneSessionRow } from "../../lib/phoneSessionBuckets";
import { formatRelativeTime } from "../../lib/relativeTime";
import { rowSelectable } from "../../lib/sessionSelection";
import { sessionStatusDotClass } from "../../lib/sessionViewed";
import { taskCardStatusView } from "../../lib/taskCardStatus";
import HighlightedText from "../HighlightedText";
import {
  IconArchive,
  IconCheck,
  IconMachine,
  IconMore,
  IconPin,
  IconRestore,
  IconTrash,
  IconX,
} from "../icons";
import SessionRowActions, {
  sessionRowActionsWidth,
  type SessionRowActionMode,
} from "../mobile/SessionRowActions";
import SwipeReveal, { type SwipeReorder } from "../mobile/SwipeReveal";
import ActionSheet, { type ActionSheetRow } from "../ui/ActionSheet";
import Button from "../ui/Button";
import Menu, { type MenuItem } from "../ui/Menu";
import PendingBadge from "../ui/PendingBadge";
import type { SessionScopeFilter } from "../ui/SessionFilters";

/**
 * One conversation row, shared by the phone page and the Mac sidebar.
 *
 * The row owns only presentation and gesture: which conversation it is, what
 * to announce, and which actions the current container uncovers. Opening,
 * selecting, pinning, archiving, restoring and deleting are the parent's
 * handlers — the same set either way. What changes is the surface those
 * actions live on: one trailing "More" trigger opens the console's shared
 * `Menu` on the Mac and its shared `ActionSheet` on a touch page, so managing
 * a conversation is one discoverable control instead of a row of hover-only
 * icons. Swipe remains a second, faster path on touch, and a completed hold —
 * where the containing list offers `reorder` — lifts the row to be dragged
 * into a new place. The trailing trigger stays the one way to the actions.
 *
 * `selectionMode` turns the row into a selection control. A row the toolbar
 * can act on keeps its trigger while selecting, holding the one way out; an
 * imported row has no task and likewise carries no list actions.
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
  onExitSelection: () => void;
  swipeOpen: boolean;
  onSwipeOpenChange: (open: boolean) => void;
  pinned: boolean;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRestore: () => void;
  scope: SessionScopeFilter;
  /** The row can be reordered by holding it; the list owns the resulting
   *  order. Absent while a search, a status filter or the archive scope is
   *  narrowing the list. */
  reorder?: SwipeReorder;
  /** This row is the one currently being dragged. */
  dragging?: boolean;
  /** How far the dragged row follows the finger, in px. */
  dragOffsetY?: number;
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
  onExitSelection,
  swipeOpen,
  onSwipeOpenChange,
  pinned,
  onPin,
  onArchive,
  onDelete,
  onRestore,
  scope,
  query,
  reorder,
  dragging = false,
  dragOffsetY = 0,
}: SessionRowProps) {
  const tr = useT();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
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
  // The row's title element is what the action trigger is described by, so a
  // screen reader hears which conversation a "More" belongs to.
  const titleId = `session-row-title-${row.task?.id ?? row.session?.id}`;

  // A row uncovers the strip that describes where it is. In the archive view
  // that is restore + delete, and only for a conversation that was archived on
  // its own: a live chat listed under an archived project is put back by the
  // project's own Restore, and a per-row "Restore" there would do nothing.
  const mode: SessionRowActionMode | null = !row.task
    ? null
    : row.task.archived_at
      ? "archived"
      : scope === "archived"
        ? null
        : "active";
  const canSelect = rowSelectable(row, scope);
  // While selecting, the trigger stays on a row the toolbar can act on: it is
  // the visible way out for anyone who entered by accident. A row that cannot
  // be selected has no batch action to offer and keeps no trigger.
  const showsActions = mode !== null && (selectionMode ? canSelect : true);
  // A mode can end while its surface is open (the row is archived from
  // elsewhere, multi-select starts): the surface is gone with the trigger, or
  // its action set is about to change under the reader, so the state must not
  // be left waiting to reopen the next time it appears.
  useEffect(() => {
    if (showsActions && !selectionMode) return;
    setMenuOpen(false);
    setSheetOpen(false);
  }, [showsActions, selectionMode]);

  const rowButton = (
    /* eslint-disable-next-line kin/no-raw-button --
       The conversation row is a full-width navigation target, not a
       button-shaped control: it is a list row that happens to be clickable,
       and the design system has no row primitive. Its actions are drawn with
       the shared Button, Menu and ActionSheet. */
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
        id={titleId}
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

  if (!showsActions) return rowButton;

  // The Mac sidebar is a pointer surface, so its actions open as the console's
  // shared menu (TASTE 3: a Mac row gets a menu, not a phone sheet). A touch
  // page gets the same list as the ActionSheet every other phone surface uses.
  const desktop = shell === "sidebar" && !coarse;
  const actionsLabel = `${tr("common.more")}: ${row.title}`;
  // One list feeds both surfaces, so the phone sheet and the Mac menu cannot
  // drift: while selecting there is exactly the exit; otherwise the way in
  // (only where the row is selectable) followed by the row's own edits.
  const rowActions: {
    id: string;
    label: string;
    icon?: ReactNode;
    destructive?: boolean;
    onSelect: () => void;
  }[] = selectionMode
    ? [
        {
          id: "exit-selection",
          label: tr("sessions.exitSelection"),
          icon: <IconX size={12} />,
          // Never disabled: the toolbar's Cancel is not, either. The point of
          // the mode is that there is always a way out.
          onSelect: onExitSelection,
        },
      ]
    : [
        ...(canSelect
          ? [
              {
                id: "select",
                label: tr("sessions.select"),
                icon: <IconCheck size={12} />,
                onSelect: onStartSelection,
              },
            ]
          : []),
        ...(mode === "archived"
          ? [
              {
                id: "restore",
                label: tr("sessions.restore"),
                icon: <IconRestore size={12} />,
                onSelect: onRestore,
              },
            ]
          : [
              {
                id: "pin",
                label: pinned ? tr("sessions.unpin") : tr("sessions.pin"),
                icon: <IconPin size={12} />,
                onSelect: onPin,
              },
              {
                id: "archive",
                label: tr("sessions.archive"),
                icon: <IconArchive size={12} />,
                onSelect: onArchive,
              },
            ]),
        {
          id: "delete",
          label: tr("sessions.delete"),
          icon: <IconTrash size={12} className="text-kin-red-ink" />,
          destructive: true,
          onSelect: onDelete,
        },
      ];
  const menuItems: MenuItem[] = rowActions.map(({ id, label, icon, onSelect }) => ({
    id,
    label,
    icon,
    onSelect,
  }));
  const sheetRows: ActionSheetRow[] = rowActions.map(({ id, label, destructive, onSelect }) => ({
    id,
    label,
    destructive,
    onSelect,
  }));

  // One trigger, whichever surface it opens. It sits in the row's tab order,
  // and the row's title is its description, so a screen reader hears which
  // conversation a "More" belongs to; the primitive owns the arrows, Escape
  // and focus return.
  const trigger = (
    <Button
      ref={triggerRef}
      // Not `quiet`: that variant's own `bg-transparent text-kin-text` are
      // utilities too, so a caller's `text-kin-muted` would race them in the
      // sheet. `default` keeps its surface in the `components` layer, which
      // every utility below overrides deterministically — the same mechanism
      // the chips use.
      variant="default"
      data-row-actions=""
      aria-label={tr("common.more")}
      aria-describedby={titleId}
      aria-haspopup={desktop ? "menu" : "dialog"}
      aria-expanded={desktop ? menuOpen : undefined}
      onClick={() => {
        if (desktop) setMenuOpen((open) => !open);
        else setSheetOpen(true);
      }}
      // The trigger is a button, not a drag surface: a press that starts on it
      // must not also arm SwipeReveal's hold, which would lift (or drag) the
      // row from underneath the sheet this tap is already opening.
      onPointerDown={desktop ? undefined : (event) => event.stopPropagation()}
      className={[
        "h-11 w-11 flex-none rounded-md bg-transparent p-0 text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text hover:brightness-100",
        desktop
          ? // Revealed on hover or focus like the icons it replaces; the 24px
            // box is the desktop density and `touch-hide` keeps it off touch.
            "touch-hide opacity-0 transition-opacity focus-visible:opacity-100 group-hover/session:opacity-100 sm:h-6 sm:w-6"
          : // The swipe strip is the surface in front once it is open: the
            // trigger would otherwise slide along with the row and sit beside
            // the chips as a fourth, redundant one. It returns when the row does.
            `mr-1${swipeOpen ? " invisible" : ""}`,
      ].join(" ")}
    >
      <IconMore size={desktop ? 14 : 16} />
    </Button>
  );

  if (desktop) {
    return (
      <div
        className={[
          "group/session flex items-center rounded-lg",
          active ? "bg-[var(--kin-fill-strong)]" : "",
        ].join(" ")}
      >
        <div className="min-w-0 flex-1">{rowButton}</div>
        <div className="flex flex-none items-center pr-2">{trigger}</div>
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          triggerRef={triggerRef}
          label={actionsLabel}
          items={menuItems}
          align="right"
        />
      </div>
    );
  }

  const touchRow = (
    <div className="flex items-stretch">
      <div className="min-w-0 flex-1">{rowButton}</div>
      <div className="flex flex-none items-center">{trigger}</div>
    </div>
  );
  const sheet = (
    <ActionSheet
      open={sheetOpen}
      onClose={() => setSheetOpen(false)}
      title={row.title}
      anyWidth={coarse}
      rows={sheetRows}
    />
  );

  // While selecting, the swipe strip and the long press belong to the
  // out-of-mode row; the row's only gesture here is the toggle, and the
  // trigger is only the exit.
  if (selectionMode) {
    return (
      <>
        {touchRow}
        {sheet}
      </>
    );
  }

  return (
    <>
      {/* The dragged row follows the finger while the rows around it have
          already made way in the DOM: a lift, not a screen transition, so
          there is deliberately no transition on this wrapper. */}
      <div
        className={dragging ? "relative z-10 shadow-e2" : undefined}
        style={dragging ? { transform: `translateY(${dragOffsetY}px)` } : undefined}
        data-dragging={dragging ? "" : undefined}
      >
        <SwipeReveal
          open={swipeOpen}
          onOpenChange={onSwipeOpenChange}
          // A completed hold starts a reorder where the list offers one; the
          // row's actions stay on the trailing trigger, which is now the one
          // way into the sheet.
          reorder={reorder}
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
          {touchRow}
        </SwipeReveal>
      </div>
      {sheet}
    </>
  );
}
