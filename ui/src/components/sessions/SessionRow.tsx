import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useT } from "../../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../../lib/agentMention";
import { isImeKeyEvent } from "../../lib/ime";
import type { PhoneSessionRow } from "../../lib/phoneSessionBuckets";
import { formatRelativeTime } from "../../lib/relativeTime";
import { rowSelectable } from "../../lib/sessionSelection";
import { sessionStatusDotClass } from "../../lib/sessionViewed";
import { taskCardStatusView } from "../../lib/taskCardStatus";
import HighlightedText from "../HighlightedText";
import {
  IconArchive,
  IconCheck,
  IconMore,
  IconPencil,
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
import type { SessionScopeFilter } from "../ui/SessionFilters";
import TextInput from "../ui/TextInput";

/**
 * One conversation row, shared by the phone page and the Mac sidebar.
 *
 * The row owns only presentation and gesture: which conversation it is, what
 * to announce, and which actions the current container uncovers. Opening,
 * selecting, renaming, pinning, archiving, restoring and deleting are the
 * parent's handlers — the same set either way. A rename is the one edit that
 * happens here, in place: the title position becomes a field, and the parent
 * only stores the result. What changes is the surface those
 * actions live on: one trailing "More" trigger opens the console's shared
 * `Menu` on the Mac and its shared `ActionSheet` on a touch page, so managing
 * a conversation is one discoverable control instead of a row of hover-only
 * icons. Swipe remains a second, faster path on touch, and a completed hold
 * opens the very same sheet — unless the list offers a reorder, where the
 * hold lifts the row and the trailing trigger stays the one way to the
 * actions. Either way there are no invisible mode changes.
 *
 * `selectionMode` turns the row into a selection control. A row the toolbar
 * can act on keeps its trigger while selecting, holding the one way out; an
 * imported row has no task and likewise carries no list actions.
 */
export type SessionRowProps = {
  row: PhoneSessionRow;
  /** The machine a pinned row came from. Pinning lifts the row out of the
   *  device heading that names every other row's machine, so this one names
   *  it on its own face; empty for every row under a heading (KIN-CONTINUE-001). */
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
  /** Save a new local title for this conversation. The parent owns storage,
   *  so the row never waits on a write and never navigates. */
  onRename: (title: string) => void;
  onArchive: () => void;
  onDelete: () => void;
  onRestore: () => void;
  scope: SessionScopeFilter;
  /** True while Alt+↑/↓ would move this row; the row then carries the hint. */
  reorderHint?: boolean;
  /** The row can be dragged into a new place by holding it; the list owns the
   *  resulting order. Absent while a search, a status filter or the archive
   *  scope is narrowing the list, and for imported rows. */
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
  onRename,
  onArchive,
  onDelete,
  onRestore,
  scope,
  query,
  reorderHint = false,
  reorder,
  dragging = false,
  dragOffsetY = 0,
}: SessionRowProps) {
  const tr = useT();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Renaming happens in the row itself: the title position becomes a field,
  // so the same edit works on the phone and in the Mac sidebar without a
  // dialog, a route or a network round trip.
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  // A blank save is refused in place and says why, rather than closing on a
  // no-op the person would read as "it saved".
  const [renameError, setRenameError] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  // Whether ending the edit should put the keyboard back on the row. A blur
  // moves focus somewhere on purpose and must not be pulled back.
  const returnFocusToShell = useRef(false);
  const setShell = useCallback((node: HTMLElement | null) => {
    shellRef.current = node;
  }, []);
  const dot = row.task ? sessionStatusDotClass(row.task.status, viewedIds.has(row.task.id)) : null;
  const avatar = agentAvatarMeta(row.agentId);
  // A run is a task spawned by a routine; an ordinary chat carries no
  // `routine_id`. The marker is part of the row's sentence as well as its
  // metadata, so a screen reader hears "this is a run" before the actions.
  const routineRun = Boolean(row.task?.routine_id);
  // One status, in words (KIN-CONTINUE-007): what needs the person first, then
  // what is still working, then a failed end before the routine marker, then
  // that it is over. Every tone that can draw a dot names itself, so a state is
  // never a colour alone.
  const agent = agentDisplayName(row.agentId);
  const at = formatRelativeTime(row.at, now);
  const statusView = row.task ? taskCardStatusView(row.task.status) : null;
  const status =
    pendingCount > 0
      ? tr("sessions.statusPendingCount", { count: String(pendingCount) })
      : statusView?.tone === "approval"
        ? tr(
            row.task?.status === "waiting_input"
              ? "sessions.statusWaitingInput"
              : "sessions.statusWaitingApproval",
          )
        : statusView?.tone === "running"
          ? tr("sessions.statusRunning")
          : statusView?.tone === "failed"
            ? tr("sessions.statusFailed")
            : routineRun
              ? tr("sessions.routineRun")
              : statusView?.tone === "completed"
                ? tr("sessions.statusSucceeded")
                : statusView?.tone === "canceled"
                  ? tr("sessions.statusCanceled")
                  : "";
  // The row's second line says who ran it, when, and one status; a pinned row
  // additionally names its machine, because pinning lifts it out of the device
  // heading that says it for every other row. In the 304px column the line is
  // narrower than the slots at caption size, so the agent — the constant, and
  // the one part the avatar already hints at — is what ellipsizes; the time,
  // the status and the device keep their own boxes and stay readable. The
  // accessible name is the whole sentence, so a screen reader reads the title
  // once.
  const label = [row.title, agent, at, status, deviceLabel].filter(Boolean).join(" · ");
  const gutter = shell === "sidebar" ? "px-2" : "px-4";
  // The Mac sidebar is a pointer surface with a keyboard: its edit is confirmed
  // with Enter. A touch surface has neither key, so it draws explicit controls.
  const desktop = shell === "sidebar" && !coarse;
  // Within the sidebar, density follows the pointer: a mouse packs the row at
  // the scale's 36px step; a finger — the phone page, or the sidebar on an
  // iPad — keeps the 44px target it can actually hit. The page shell stays
  // roomy for a mouse too, which is the whole rule `desktop` already states.
  const dense = desktop;
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
  // The status's tone, said in words at the top of the menu: a conversation
  // that is queued, running or retrying is still being worked on. It follows
  // the tone alone, archived or not — archiving does not stop a run, so an
  // archived conversation that is still going must warn before Delete too. It
  // is information, not a lock: every edit below it stays available. It is only
  // added in the non-selection branch — while selecting, the menu is the one
  // way out.
  const runningNow = statusView?.tone === "running";
  // A mode can end while its surface is open (the row is archived from
  // elsewhere, multi-select starts): the surface is gone with the trigger, or
  // its action set is about to change under the reader, so the state must not
  // be left waiting to reopen the next time it appears.
  useEffect(() => {
    if (showsActions && !selectionMode) return;
    setMenuOpen(false);
    setSheetOpen(false);
    // A mode can change under an open editor; the edit ends with the actions
    // that opened it, and the row it would return to may be gone.
    returnFocusToShell.current = false;
    setRenaming(false);
  }, [showsActions, selectionMode]);

  // The field takes the keyboard as it appears, with the whole title selected
  // so typing replaces the old name rather than appending to it.
  useEffect(() => {
    if (!renaming) return;
    const field = renameInputRef.current;
    field?.focus({ preventScroll: true });
    field?.select();
  }, [renaming]);

  // Back to the row once the edit is over. The shell is a button again by the
  // time this runs, whichever way the edit ended.
  useEffect(() => {
    if (renaming || !returnFocusToShell.current) return;
    returnFocusToShell.current = false;
    shellRef.current?.focus({ preventScroll: true });
  }, [renaming]);

  /** Open the in-place editor. Reached from the action surface, which is
   *  already closing: nothing navigates and no selection changes. */
  function startRename() {
    setMenuOpen(false);
    setSheetOpen(false);
    setDraftTitle(row.title);
    setRenameError(false);
    setRenaming(true);
  }

  /** `restoreFocus` is false when focus is leaving on purpose (a click
   *  elsewhere): the edit still ends, but the keyboard is not pulled back. */
  function cancelRename(restoreFocus = true) {
    if (!renaming) return;
    returnFocusToShell.current = restoreFocus;
    setRenaming(false);
  }

  /** Enter and the touch Save do exactly the same thing. */
  function commitRename() {
    const title = draftTitle.trim();
    // A blank title is not a name: the field stays open and focused and says
    // so, instead of closing as if something had been saved.
    if (!title) {
      setRenameError(true);
      // The touch Save is reachable by keyboard too: if it (or Enter on it)
      // asked with a blank field, the field takes the keyboard back so the
      // person can finish typing where the message is.
      renameInputRef.current?.focus({ preventScroll: true });
      return;
    }
    returnFocusToShell.current = true;
    setRenaming(false);
    // An edit that changes nothing just closes the field.
    if (title !== row.title.trim()) onRename(title);
  }

  function onRenameKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (isImeKeyEvent(event.nativeEvent)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // The row's Escape must not also reach an ancestor's handler: cancelling
      // the edit is the whole request.
      event.stopPropagation();
      cancelRename();
    }
  }

  const shellClassName = [
    // The press animation belongs to a control. While editing, the shell is a
    // plain row: it must not look tappable and must not navigate.
    renaming ? "" : "kin-row-press",
    "flex w-full items-center gap-2.5 text-left",
    dense ? "min-h-9 py-1.5" : "min-h-11 py-2.5",
    gutter,
    selectionMode && selected ? "bg-[var(--kin-fill)]" : "",
    active ? "bg-[var(--kin-fill-strong)]" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // The row's contents are shared by both shells, so the geometry is identical
  // before, during and after an edit; only the element around them changes.
  const rowContent = (
    <>
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
      {renaming ? (
        // The title position itself becomes the field, so the edit happens
        // where the name is read. The id stays here: the trailing trigger is
        // described by this element on both surfaces.
        <div
          id={titleId}
          className="flex min-w-0 flex-1 items-center gap-1"
          // The field and the touch Save/Cancel pair are one editor: focus
          // moving between them is not leaving the edit. Only a focus that
          // lands outside the container (a click elsewhere) ends it.
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) cancelRename(false);
          }}
        >
          <div className="min-w-0 flex-1">
            <TextInput
              ref={renameInputRef}
              isLabelHidden
              label={tr("sessions.renameFieldLabel")}
              value={draftTitle}
              onChange={(event) => {
                setDraftTitle(event.target.value);
                setRenameError(false);
              }}
              onKeyDown={onRenameKeyDown}
              // One line inside the row's own height; the facade drops its 44px
              // floor when the caller sets a height (TASTE 11: the row keeps it).
              // The row's tail is hidden while editing, so the field spends the
              // width on the name instead of on its own gutter.
              className="h-7 min-h-0 px-1.5"
              status={
                renameError ? { type: "error", message: tr("sessions.renameEmpty") } : undefined
              }
              autoFocus
            />
          </div>
          {desktop ? null : (
            // A soft keyboard has no Enter or Escape, and a tap outside drops
            // the draft. The explicit pair is the touch surface's way to
            // confirm or leave. `onMouseDown` keeps the field from blurring —
            // and the blur handler from cancelling the edit — before the tap
            // lands on the control.
            <>
              <Button
                variant="default"
                aria-label={tr("common.save")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={commitRename}
                className="h-11 w-11 flex-none rounded-md bg-transparent p-0 text-kin-blue-ink hover:bg-[var(--kin-fill)] hover:brightness-100"
              >
                <IconCheck size={16} strokeWidth={2.25} />
              </Button>
              <Button
                variant="default"
                aria-label={tr("common.cancel")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => cancelRename()}
                className="h-11 w-11 flex-none rounded-md bg-transparent p-0 text-kin-muted hover:bg-[var(--kin-fill)] hover:brightness-100"
              >
                <IconX size={16} />
              </Button>
            </>
          )}
        </div>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span
            id={titleId}
            data-session-title
            className={[
              "block min-w-0 truncate leading-ui text-kin-text",
              shell === "sidebar" ? "text-body font-normal" : "text-subtitle font-medium",
            ].join(" ")}
          >
            <HighlightedText text={row.title} query={query} />
          </span>
          {/* The second line is its own element, so a long title truncates on
              the first line instead of squeezing the metadata (KIN-CONTINUE-007).
              Inside it the lead gives way first: the status is its own flex
              item with `shrink-0`, so the agent and time ellipsize before the
              one status does. Two lines at the type ladder's 1.375 leading keep
              a row above 44px even at the mouse's compact padding. */}
          <span
            data-session-meta
            className="flex min-w-0 items-center text-caption leading-ui text-kin-muted"
          >
            <span className="min-w-0 truncate">{agent}</span>
            {at ? <span className="shrink-0 whitespace-pre">{agent ? ` · ${at}` : at}</span> : null}
            {status ? (
              <span data-session-status className="shrink-0 whitespace-pre">
                {agent || at ? ` · ${status}` : status}
              </span>
            ) : null}
            {deviceLabel ? (
              <span className="shrink-0 whitespace-pre">
                {agent || at || status ? ` · ${deviceLabel}` : deviceLabel}
              </span>
            ) : null}
          </span>
        </span>
      )}
      {/* While editing, the field owns the row: the second line goes with the
          rest of the tail, because a 248px sidebar cannot hold the name and the
          metadata beside an open field. */}
    </>
  );

  const rowButton = renaming ? (
    // HTML cannot nest an input inside a button, and while editing neither
    // navigation nor selection may fire: the shell drops to a plain row.
    <div
      data-session-row={row.task?.id ?? row.session?.id}
      ref={setShell}
      className={shellClassName}
    >
      {rowContent}
    </div>
  ) : (
    // The conversation row is a full-width navigation target, not a
    // button-shaped control: it is a list row that happens to be clickable,
    // and the design system has no row primitive. Its actions are drawn with
    // the shared Button, Menu and ActionSheet.
    <button
      type="button"
      data-session-row={row.task?.id ?? row.session?.id}
      ref={setShell}
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
      // A tooltip only: the gesture has no visible affordance of its own, and
      // the accessible name stays the row's sentence (see `label` above).
      title={reorderHint ? tr("sessions.reorderHint") : undefined}
      className={shellClassName}
    >
      {rowContent}
    </button>
  );

  if (!showsActions) return rowButton;

  // The Mac sidebar is a pointer surface, so its actions open as the console's
  // shared menu (TASTE 3: a Mac row gets a menu, not a phone sheet). A touch
  // page gets the same list as the ActionSheet every other phone surface uses.
  const actionsLabel = `${tr("common.more")}: ${row.title}`;
  // One list feeds both surfaces, so the phone sheet and the Mac menu cannot
  // drift: while selecting there is exactly the exit; otherwise the way in
  // (only where the row is selectable) followed by the row's own edits.
  const rowActions: {
    id: string;
    label: string;
    icon?: ReactNode;
    destructive?: boolean;
    disabled?: boolean;
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
        // A working conversation says so before anything else on the menu. It
        // is a status line, not an action: no icon, no handler, and the
        // primitive draws it dimmed and unreachable. The word is the one the
        // row already announces for this state (TASTE 2), so the same state
        // does not get a second name.
        ...(runningNow
          ? [
              {
                id: "running",
                label: tr("sessions.statusRunning"),
                disabled: true,
                onSelect: () => {},
              },
            ]
          : []),
        // Rename leads: it is the row's own name, and the edit a person
        // reaches for when a title is just the first line of a prompt. It is
        // offered only in the active scope — the archived menu is restore +
        // delete — and only ever on a task row (`mode` is null without one).
        ...(mode === "active"
          ? [
              {
                id: "rename",
                label: tr("sessions.rename"),
                icon: <IconPencil size={12} />,
                onSelect: startRename,
              },
            ]
          : []),
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
  const menuItems: MenuItem[] = rowActions.map(({ id, label, icon, onSelect, disabled }) => ({
    id,
    label,
    icon,
    onSelect,
    disabled,
  }));
  const sheetRows: ActionSheetRow[] = rowActions.map(
    ({ id, label, destructive, onSelect, disabled }) => ({
      id,
      label,
      destructive,
      onSelect,
      disabled,
    }),
  );

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
        {/* While editing, the trigger would sit beside the field and squeeze
            the name it is meant to describe; the field is the whole row. */}
        <div className="flex flex-none items-center pr-2">{renaming ? null : trigger}</div>
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
      {/* An edit in place has no room for the actions trigger, and a stray tap
          on it would take the draft away with no way back. */}
      <div className="flex flex-none items-center">{renaming ? null : trigger}</div>
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
  // trigger is only the exit. An edit in place is the same: a swipe or a hold
  // under the field would move the row (or open the sheet) mid-typing and
  // blur the draft away.
  if (selectionMode || renaming) {
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
          // Where the list offers a reorder, the completed hold lifts the row
          // and the drag wins the gesture; elsewhere the hold keeps opening
          // this row's own action sheet, and the trailing trigger opens it in
          // both cases.
          onLongPress={() => setSheetOpen(true)}
          reorder={reorder}
          width={sessionRowActionsWidth(mode)}
          actions={
            // Deliberately no Rename chip here: the strip's width is derived
            // from exactly three chips and the swipe distance from that width.
            // The menu and the sheet are the one entrance to a rename.
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
