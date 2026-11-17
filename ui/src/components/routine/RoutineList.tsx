import type { ReactNode } from "react";
import type { Routine } from "../../api/client";
import Button from "../ui/Button";
import SheetSelect, { type SheetOption } from "../ui/SheetSelect";
import { describeRoutineRule, parseRoutineRule } from "../../lib/routineRecurrence";
import { directoryLabel } from "../../lib/routineDirectories";
import { formatInterval, formatWhen } from "../../lib/routineTime";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The three states the list can be narrowed to; absent means every routine. */
export const ROUTINE_STATUS_FILTERS = ["enabled", "paused", "failed"] as const;
export type RoutineStatusFilter = "" | (typeof ROUTINE_STATUS_FILTERS)[number];

export type RoutineListProps = {
  routines: Routine[];
  query: string;
  onQueryChange: (query: string) => void;
  /** Active status filter; "" is every routine. */
  status: RoutineStatusFilter;
  onStatusChange: (status: RoutineStatusFilter) => void;
  /** Active directory filter; "" is every directory. */
  cwd: string;
  /** Every directory on the selected machine, already labelled. */
  directories: SheetOption[];
  onCwdChange: (cwd: string) => void;
  /** Drop both filters, keeping the search text untouched. */
  onClearFilters: () => void;
  selectedId: string | null;
  /** The routine this visit just created, marked on arrival; not selection. */
  justCreatedId?: string | null;
  unreadByRoutine: Record<string, number>;
  busy: Record<string, boolean>;
  creating: boolean;
  machineOffline: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onSelect: (routine: Routine) => void;
  onCreate: () => void;
  onRunNow: (routine: Routine) => void;
  onEdit: (routine: Routine) => void;
  onToggle: (routine: Routine) => void;
  onDelete: (routine: Routine) => void;
  onLoadMore: () => void;
  /**
   * Extra content under the selected row — the phone layout's run-history
   * panel. The page owns that history; the list only leaves room for it.
   */
  renderRowExtra?: (routine: Routine) => ReactNode;
  tr: Translate;
};

/**
 * The routines list: search, one row per routine with its badges and next-due
 * line, and the way to create when the machine has none. Controlled in both
 * directions — the page owns the query, the selection and every request.
 */
export default function RoutineList({
  routines,
  query,
  onQueryChange,
  status,
  onStatusChange,
  cwd,
  directories,
  onCwdChange,
  onClearFilters,
  selectedId,
  justCreatedId,
  unreadByRoutine,
  busy,
  creating,
  machineOffline,
  hasMore,
  loadingMore,
  onSelect,
  onCreate,
  onRunNow,
  onEdit,
  onToggle,
  onDelete,
  onLoadMore,
  renderRowExtra,
  tr,
}: RoutineListProps) {
  const filterActive = status !== "" || cwd !== "";
  const statusOptions: SheetOption[] = [
    { id: "", label: tr("routines.filterAll") },
    { id: "enabled", label: tr("routines.enabled") },
    { id: "paused", label: tr("routines.paused") },
    { id: "failed", label: tr("routines.filterFailed") },
  ];
  const directoryOptions: SheetOption[] = [
    { id: "", label: tr("routines.filterAllDirs") },
    ...directories,
  ];
  // A `?cwd=` that is no longer among this machine's routines still filters.
  // Naming it beats showing the raw path as a "value" with no option behind
  // it, and the empty result it produces is the honest answer.
  const cwdInOptions = directories.some((option) => option.id === cwd);
  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="mr-auto text-caption font-semibold uppercase tracking-label text-kin-muted">
          {tr("routines.listSection")}
        </div>
        <SheetSelect
          label={tr("routines.filterStatus")}
          value={status}
          options={statusOptions}
          onChange={(id) => onStatusChange(id as RoutineStatusFilter)}
          className="text-kin-text"
        />
        <SheetSelect
          label={tr("routines.filterDirectory")}
          value={cwd}
          display={cwd && !cwdInOptions ? directoryLabel(cwd) : undefined}
          options={directoryOptions}
          onChange={onCwdChange}
          className="text-kin-text"
        />
        {filterActive && (
          <Button variant="quiet" onClick={() => onClearFilters()}>
            {tr("routines.filterClear")}
          </Button>
        )}
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={tr("routines.searchPlaceholder")}
          aria-label={tr("routines.searchPlaceholder")}
          className="min-h-11 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2.5 text-body text-kin-text outline-none focus:border-kin-blue/40 sm:max-w-[260px]"
        />
      </div>
      {routines.length === 0 ? (
        // One surface, two answers: a machine with no routines at all invites
        // creating one; a filtered list that matched nothing invites clearing
        // the filter. An empty list no longer means there are no routines.
        <div className="rounded-2xl border border-dashed border-[var(--kin-hairline-strong)] px-6 py-10 text-center">
          {filterActive ? (
            <>
              <p className="text-strong font-medium text-kin-text">{tr("routines.filterEmpty")}</p>
              <p className="mt-1 text-strong text-kin-secondary">
                {tr("routines.filterEmptyHint")}
              </p>
              <Button variant="secondary" onClick={() => onClearFilters()} className="mt-4">
                {tr("routines.filterClear")}
              </Button>
            </>
          ) : (
            <>
              <p className="text-strong text-kin-secondary">{tr("routines.emptyList")}</p>
              {/* The one filled action on the page: a machine with no routines. */}
              <Button
                variant="default"
                disabled={machineOffline}
                onClick={() => onCreate()}
                className="mt-4"
              >
                {tr("routines.createEntry")}
              </Button>
            </>
          )}
        </div>
      ) : (
        <ul className="space-y-2.5">
          {routines.map((r) => {
            const unread = unreadByRoutine[r.id] ?? 0;
            const selectedHere = selectedId === r.id;
            // The arrival cue is a separate affordance from selection: green
            // (made) rather than blue (open), and never `aria-pressed`. It
            // outranks the selected tone only because a row cannot be both the
            // one just made and the one opened before it existed.
            const justCreated = !!justCreatedId && justCreatedId === r.id;
            return (
              <li
                key={r.id}
                data-just-created={justCreated ? "true" : undefined}
                className={[
                  "rounded-2xl px-4 py-3",
                  justCreated
                    ? "bg-kin-green/5 ring-2 ring-kin-green/50"
                    : selectedHere
                      ? "bg-kin-blue/5 ring-1 ring-kin-blue/30"
                      : "bg-kin-panel/80",
                ].join(" ")}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  {/* A bare full-row hit area with aria-pressed, not a facade
                      control: no Button variant is a text hit area. It is
                      deliberately never disabled by busy/creating/offline. */}
                  {/* eslint-disable-next-line kin/no-raw-button -- the row select is a bare text hit area with aria-pressed. */}
                  <button
                    type="button"
                    onClick={() => onSelect(r)}
                    aria-pressed={selectedHere}
                    aria-label={tr("routines.showRuns", {
                      title: r.title || r.prompt.slice(0, 48),
                    })}
                    className="min-w-0 flex-1 rounded-lg text-left"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-strong font-medium text-kin-text">
                        {r.title || r.prompt.slice(0, 48)}
                      </span>
                      <span
                        className={
                          r.enabled
                            ? "shrink-0 whitespace-nowrap rounded-full bg-kin-green/15 px-2 py-0.5 text-caption font-medium text-kin-green-ink"
                            : "shrink-0 whitespace-nowrap rounded-full bg-[var(--kin-fill)] px-2 py-0.5 text-caption text-kin-muted"
                        }
                      >
                        {r.enabled ? tr("routines.enabled") : tr("routines.paused")}
                      </span>
                      {unread > 0 && (
                        <span className="shrink-0 whitespace-nowrap rounded-full bg-kin-blue/15 px-2 py-0.5 text-caption font-medium text-kin-blue-ink">
                          {tr("routines.unreadCount", { count: unread })}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block truncate text-body text-kin-secondary">
                      {r.agent} ·{" "}
                      {describeRoutineRule(parseRoutineRule(r.recurrence), tr) ??
                        formatInterval(r.interval_secs)}{" "}
                      · {r.cwd}
                    </span>
                    <span className="mt-0.5 block text-caption text-kin-muted">
                      {tr("routines.nextDue")}
                      {tr("common.labelSeparator")}
                      {formatWhen(r.next_due_at)}
                      {r.last_outcome === "succeeded"
                        ? ` · ${tr("routines.lastSucceeded")}`
                        : r.last_outcome === "failed"
                          ? ` · ${tr("routines.lastFailed")}`
                          : ""}
                      {r.consec_failures > 0
                        ? ` · ${tr("routines.failures", { n: r.consec_failures })}`
                        : ""}
                    </span>
                  </button>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <Button
                      variant="secondary"
                      disabled={!!busy[r.id] || creating || machineOffline}
                      onClick={() => onRunNow(r)}
                    >
                      {tr("routines.runNow")}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!!busy[r.id] || creating || machineOffline}
                      onClick={() => onEdit(r)}
                      aria-label={tr("routines.editRoutine", {
                        title: r.title || r.prompt.slice(0, 48),
                      })}
                    >
                      {tr("routines.edit")}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!!busy[r.id] || creating || machineOffline}
                      onClick={() => onToggle(r)}
                    >
                      {r.enabled ? tr("routines.pause") : tr("routines.resume")}
                    </Button>
                    {/* Quiet with red ink: destructive, not a peer of Run now. */}
                    <Button
                      variant="quiet-danger"
                      disabled={!!busy[r.id] || creating || machineOffline}
                      onClick={() => onDelete(r)}
                    >
                      {tr("routines.delete")}
                    </Button>
                  </div>
                </div>
                {renderRowExtra?.(r)}
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <Button
          variant="secondary"
          onClick={() => onLoadMore()}
          disabled={loadingMore}
          className="mt-3 w-full"
        >
          {loadingMore ? tr("tree.loadingMore") : tr("routines.loadMore")}
        </Button>
      )}
    </section>
  );
}
