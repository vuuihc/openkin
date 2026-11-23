/* eslint-disable kin/no-arbitrary-z-index -- The selection bar pins itself to
   the top of the list's scroll body, which is a stacking layer rather than a
   control. Every button in this file is the shared `Button`. */
import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useT } from "../../i18n/react";
import type { ProjectSortMode } from "../../lib/projectSidebar";
import { IconArchive, IconPin, IconRestore, IconSearch, IconTrash, IconX } from "../icons";
import Button from "../ui/Button";
import SessionFilters, {
  type SessionScopeFilter,
  type SessionStatusFilter,
} from "../ui/SessionFilters";

/**
 * The conversation list's toolbar: search, filters and the selection bar.
 *
 * The list owns the query, the URL parameters, the selection and every handler;
 * this file owns only how they are drawn. The search field belongs to the
 * sidebar shell alone, which is why it is a prop rather than a second
 * component, and the selection bar stays a separate export because it lives
 * inside the scrolling body while search and filters sit above it.
 */
export type SessionToolbarProps = {
  /** The sidebar has a search field; the phone page starts at the filters. */
  search?: boolean;
  query: string;
  pendingQuery: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (query: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  status: SessionStatusFilter;
  scope: SessionScopeFilter;
  sortMode: ProjectSortMode;
  onFilterChange: (next: { status: SessionStatusFilter; scope: SessionScopeFilter }) => void;
  onSortChange: (mode: ProjectSortMode) => void;
  /** The list is narrowed to one routine's runs (`?routine=`). */
  routineFilter?: boolean;
  /** Drop `?routine=` and return to the full list. */
  onClearRoutine?: () => void;
  /** The project the list is narrowed to (`?project=`), by display name. */
  projectFilter?: string;
  /** Drop `?project=` and return to the full list. */
  onClearProject?: () => void;
};

export default function SessionToolbar({
  search = true,
  query,
  pendingQuery,
  searchRef,
  onQueryChange,
  onSearchKeyDown,
  status,
  scope,
  sortMode,
  onFilterChange,
  onSortChange,
  routineFilter = false,
  onClearRoutine,
  projectFilter = "",
  onClearProject,
}: SessionToolbarProps) {
  const tr = useT();
  // The 820px iPad draws this desktop toolbar with a thumb. The search field
  // and the routine chip's clear control take the finger floor from the
  // pointer, the same rule the list's rows already follow.
  const coarse = useCoarsePointer();
  return (
    <>
      {search ? (
        <div className="px-3 pb-2">
          <label className="relative flex items-center">
            <IconSearch
              size={13}
              className="pointer-events-none absolute left-2.5 text-kin-muted"
            />
            <input
              ref={searchRef}
              data-session-search
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={tr("nav.searchSessions")}
              aria-label={tr("nav.searchSessions")}
              className={[
                "w-full rounded-lg border border-transparent bg-[var(--kin-fill)] pl-8 pr-2 text-body text-kin-text outline-none transition-colors placeholder:text-kin-muted focus:border-kin-blue/40 focus:bg-[var(--kin-fill-strong)]",
                coarse ? "h-11" : "h-8",
              ].join(" ")}
            />
          </label>
          {query.trim() ? (
            <div className="mt-1 px-0.5 text-caption text-kin-muted">
              {pendingQuery ? tr("common.loading") : tr("nav.searchHint")}
            </div>
          ) : null}
        </div>
      ) : null}
      <SessionFilters
        status={status}
        scope={scope}
        onChange={onFilterChange}
        sortMode={sortMode}
        onSortChange={onSortChange}
      />
      {/* A project is not a status and not a scope: it comes from a link
          (`?project=`), names one project, and narrows the loaded rows in the
          browser. The chip is the one visible reminder, and its clear control
          is the way back. An id with no loaded record is still a real
          narrowing, so the chip names the raw id rather than vanishing. */}
      {projectFilter ? (
        <div className="px-4 pb-1 pt-0.5">
          <span className="inline-flex min-h-9 items-center gap-0.5 rounded-full bg-kin-blue/10 pl-2.5 pr-1 text-caption font-medium text-kin-blue-ink">
            {tr("sessions.projectFiltered", { name: projectFilter })}
            <Button
              variant="quiet"
              onClick={onClearProject}
              aria-label={tr("sessions.clearProjectFilter")}
              title={tr("sessions.clearProjectFilter")}
              className={[
                "flex-none items-center justify-center rounded-full p-0",
                coarse ? "h-11 w-11" : "h-9 w-9",
              ].join(" ")}
            >
              <IconX size={13} />
            </Button>
          </span>
        </div>
      ) : null}
      {/* A routine is not a status and not a scope: it comes from a link
          (`?routine=`), names one routine, and has no panel to live in — the
          list deliberately never fetches routine names. The chip is the one
          visible reminder, and its clear control is the way back. */}
      {routineFilter ? (
        <div className="px-4 pb-1 pt-0.5">
          <span className="inline-flex min-h-9 items-center gap-0.5 rounded-full bg-kin-blue/10 pl-2.5 pr-1 text-caption font-medium text-kin-blue-ink">
            {tr("sessions.routineFiltered")}
            <Button
              variant="quiet"
              onClick={onClearRoutine}
              aria-label={tr("sessions.clearRoutineFilter")}
              title={tr("sessions.clearRoutineFilter")}
              className={[
                "flex-none items-center justify-center rounded-full p-0",
                coarse ? "h-11 w-11" : "h-9 w-9",
              ].join(" ")}
            >
              <IconX size={13} />
            </Button>
          </span>
        </div>
      ) : null}
    </>
  );
}

/**
 * The bar that replaces the list header while rows are being selected.
 *
 * It stays inside the scrolling body in `SessionList`, as it was before the
 * extraction, so a batch action is reachable without leaving the rows and the
 * bar pins itself to the top of that scroll area.
 */
export type SessionSelectionBarProps = {
  selectedCount: number;
  selectableCount: number;
  selectionBusy: boolean;
  deletingSelection: boolean;
  scope: SessionScopeFilter;
  /** Every selected row is pinned already, so the action says Unpin. */
  allPinned: boolean;
  onSelectAll: () => void;
  onPin: () => void;
  onArchiveOrRestore: () => void;
  onDelete: () => void;
  onExit: () => void;
};

export function SessionSelectionBar({
  selectedCount,
  selectableCount,
  selectionBusy,
  deletingSelection,
  scope,
  allPinned,
  onSelectAll,
  onPin,
  onArchiveOrRestore,
  onDelete,
  onExit,
}: SessionSelectionBarProps) {
  const tr = useT();
  const pinLabel = allPinned ? tr("sessions.unpin") : tr("sessions.pin");
  return (
    <div
      data-selection-toolbar
      className="sticky top-0 z-[3] flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--kin-hairline)] bg-[var(--kin-page)] px-2.5 py-1.5 kin-glass"
    >
      <label className="flex min-h-11 items-center gap-2 text-strong font-medium text-kin-text">
        <SelectAllCheckbox
          checked={selectedCount > 0 && selectedCount === selectableCount}
          partial={selectedCount > 0 && selectedCount < selectableCount}
          onChange={onSelectAll}
          label={tr("sessions.selectAll")}
        />
        {tr("sessions.selectedCount", { count: String(selectedCount) })}
      </label>
      {/* Icon-only batch actions keep three 44px targets and Cancel on one
          line of a 248px sidebar. The viewport `sm:` labels this replaces
          answered the window's width, not the sidebar's. */}
      <div className="ml-auto flex items-center gap-1.5">
        {scope !== "archived" && (
          <Button
            variant="secondary"
            onClick={onPin}
            disabled={selectedCount === 0 || selectionBusy}
            aria-label={pinLabel}
            title={pinLabel}
            className="h-11 w-11 flex-none items-center justify-center rounded-lg p-0 text-body font-medium"
          >
            <IconPin size={14} />
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={onArchiveOrRestore}
          disabled={selectedCount === 0 || selectionBusy}
          aria-label={tr(scope === "archived" ? "sessions.restore" : "sessions.archive")}
          title={tr(scope === "archived" ? "sessions.restore" : "sessions.archive")}
          className="h-11 w-11 flex-none items-center justify-center rounded-lg p-0 text-body font-medium"
        >
          {scope === "archived" ? <IconRestore size={14} /> : <IconArchive size={14} />}
        </Button>
        <Button
          variant="quiet-danger"
          onClick={onDelete}
          disabled={selectedCount === 0 || selectionBusy}
          aria-label={deletingSelection ? tr("sessions.deletingSelected") : tr("sessions.delete")}
          title={deletingSelection ? tr("sessions.deletingSelected") : tr("sessions.delete")}
          aria-busy={deletingSelection || undefined}
          className="h-11 w-11 flex-none items-center justify-center rounded-lg p-0 text-body font-medium"
        >
          <IconTrash size={14} />
        </Button>
        <Button
          variant="quiet"
          onClick={onExit}
          aria-label={tr("common.cancel")}
          title={tr("common.cancel")}
          className="h-11 flex-none items-center justify-center rounded-lg px-2.5 text-body font-medium"
        >
          {tr("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

export function SelectAllCheckbox({
  checked,
  partial,
  onChange,
  label,
}: {
  checked: boolean;
  partial: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="h-5 w-5 accent-kin-blue"
      aria-label={label}
    />
  );
}
