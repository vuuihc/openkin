/* eslint-disable kin/no-raw-button, kin/no-arbitrary-z-index -- The search
   field and the selection bar (including its action buttons and sticky
   stacking layer) are moved verbatim out of SessionList. They are pre-existing
   controls, not a new surface, and restyling them here would be a visual
   change this extraction must not make. */
import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { useT } from "../../i18n/react";
import type { ProjectSortMode } from "../../lib/projectSidebar";
import { IconArchive, IconPin, IconRestore, IconSearch, IconTrash } from "../icons";
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
}: SessionToolbarProps) {
  const tr = useT();
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
              className="h-8 w-full rounded-lg border border-transparent bg-[var(--kin-fill)] pl-8 pr-2 text-body text-kin-text outline-none transition-colors placeholder:text-kin-muted focus:border-kin-blue/40 focus:bg-[var(--kin-fill-strong)]"
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
    <div className="sticky top-0 z-[3] flex min-h-12 items-center gap-2 border-b border-[var(--kin-hairline)] bg-[var(--kin-page)] px-3 kin-glass">
      <label className="flex min-h-11 items-center gap-2 text-strong font-medium text-kin-text">
        <SelectAllCheckbox
          checked={selectedCount > 0 && selectedCount === selectableCount}
          partial={selectedCount > 0 && selectedCount < selectableCount}
          onChange={onSelectAll}
          label={tr("sessions.selectAll")}
        />
        {tr("sessions.selectedCount", { count: String(selectedCount) })}
      </label>
      <div className="ml-auto flex items-center gap-1.5">
        {scope !== "archived" && (
          <button
            type="button"
            onClick={onPin}
            disabled={selectedCount === 0 || selectionBusy}
            aria-label={pinLabel}
            title={pinLabel}
            className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--kin-fill)] px-2.5 text-body font-medium text-kin-text disabled:opacity-40 sm:px-3"
          >
            <IconPin size={14} />
            <span className="hidden sm:inline">{pinLabel}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onArchiveOrRestore}
          disabled={selectedCount === 0 || selectionBusy}
          aria-label={tr(scope === "archived" ? "sessions.restore" : "sessions.archive")}
          title={tr(scope === "archived" ? "sessions.restore" : "sessions.archive")}
          className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--kin-fill)] px-2.5 text-body font-medium text-kin-text disabled:opacity-40 sm:px-3"
        >
          {scope === "archived" ? <IconRestore size={14} /> : <IconArchive size={14} />}
          <span className="hidden sm:inline">
            {tr(scope === "archived" ? "sessions.restore" : "sessions.archive")}
          </span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={selectedCount === 0 || selectionBusy}
          aria-label={deletingSelection ? tr("sessions.deletingSelected") : tr("sessions.delete")}
          title={deletingSelection ? tr("sessions.deletingSelected") : tr("sessions.delete")}
          aria-busy={deletingSelection || undefined}
          className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-kin-red/15 px-2.5 text-body font-medium text-kin-red-ink disabled:opacity-40 sm:px-3"
        >
          <IconTrash size={14} />
          <span className="hidden sm:inline">
            {deletingSelection ? tr("sessions.deletingSelected") : tr("sessions.delete")}
          </span>
        </button>
        <button
          type="button"
          onClick={onExit}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2.5 text-body font-medium text-kin-muted hover:text-kin-text sm:px-3"
        >
          {tr("common.cancel")}
        </button>
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
