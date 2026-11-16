import { useId, useRef, useState } from "react";
import { useT } from "../../i18n/react";
import type { ProjectSortMode } from "../../lib/projectSidebar";
import type { SessionAttentionFilter } from "../../lib/sessionAttention";
import { IconCheck, IconChevronDown, IconFilter } from "../icons";
import Button from "./Button";

/**
 * The conversation list's attention chips and exact-status filter.
 *
 * The chip row is the list's view: All, Needs you (live count), Running (live
 * count), Archived. `?attention=needs|running` and `?scope=archived` are one
 * view at a time; the exact statuses (`?status=`) narrow whichever view is
 * pressed, and picking a chip clears that narrowing in the same change.
 *
 * Status travels to the daemon (`?status=`), because narrowing only the loaded
 * page would answer "no running chats" about a page that merely ended — and
 * the loaded page is 100 rows. Imported agent sessions carry no status, so the
 * page hides them while one is set.
 *
 * Archived is a peer scope of the same list, not a second list: it is the one
 * place conversations put away one by one can be restored without leaving the
 * list. The panel under the trigger keeps only what the chips do not say — the
 * six exact statuses and the project sort.
 *
 * It opens in place rather than as a sheet. The sheet is `md:hidden`, so a
 * sheet here would need a second desktop-only surface and two chances to
 * disagree about what is selected; a panel under the trigger is the same
 * control at both widths.
 */

export const SESSION_STATUS_FILTERS = [
  "running",
  "waiting_approval",
  "waiting_input",
  "succeeded",
  "failed",
  "canceled",
] as const;

export type SessionStatusFilter = "" | (typeof SESSION_STATUS_FILTERS)[number];
export type SessionScopeFilter = "active" | "archived";

/** Unknown or absent `?status=` is "all", never a filter nothing can match. */
export function normalizeStatusFilter(raw: string | null): SessionStatusFilter {
  return (SESSION_STATUS_FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as SessionStatusFilter)
    : "";
}

export function normalizeScopeFilter(raw: string | null): SessionScopeFilter {
  return raw === "archived" ? "archived" : "active";
}

/**
 * The chips are the statuses a person would look for in this list.
 *
 * `queued` and `retrying` are deliberately absent: they are moments between
 * two of these, and a filter for a state that lasts a second is a control that
 * is almost always empty. `canceled` is present for the opposite reason — it
 * is durable, and it is the one status the row dot draws nothing for, so this
 * is the only way to find a canceled run in the list.
 */
const STATUS_LABEL_KEY: Record<Exclude<SessionStatusFilter, "">, string> = {
  running: "sessions.statusRunning",
  waiting_approval: "sessions.statusWaitingApproval",
  waiting_input: "sessions.statusWaitingInput",
  succeeded: "sessions.statusSucceeded",
  failed: "sessions.statusFailed",
  canceled: "sessions.statusCanceled",
};

export type SessionFilterChange = {
  status: SessionStatusFilter;
  scope: SessionScopeFilter;
  attention: SessionAttentionFilter;
};

export default function SessionFilters({
  status,
  scope,
  attention = "",
  needsYouCount = 0,
  runningCount = 0,
  onChange,
  sortMode,
  onSortChange,
}: {
  status: SessionStatusFilter;
  scope: SessionScopeFilter;
  /** Which chip is pressed; `""` (the default) is All. */
  attention?: SessionAttentionFilter;
  /** The live counts behind the Needs you and Running chips. */
  needsYouCount?: number;
  runningCount?: number;
  onChange: (next: SessionFilterChange) => void;
  /** The project order. Present in both shells, because list features do not
   *  depend on whether the container is a page or a sidebar. */
  sortMode?: ProjectSortMode;
  onSortChange?: (mode: ProjectSortMode) => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const chipsLabelId = useId();
  const needsYouDescriptionId = useId();
  const runningDescriptionId = useId();
  const summaryDescriptionId = useId();
  const statusLabelId = useId();
  const sortLabelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const archived = scope === "archived";
  const activeCount = status ? 1 : 0;
  const summary = status ? tr(STATUS_LABEL_KEY[status]) : "";

  /** Escape closes the panel and hands focus back, like every sheet here. */
  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div
      className="px-4 pb-1 pt-1"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <p id={chipsLabelId} className="sr-only">
        {tr("sessions.scopeGroup")}
      </p>
      <div role="group" aria-labelledby={chipsLabelId} className="flex flex-wrap gap-1.5">
        <ScopeChip
          label={tr("sessions.scopeAll")}
          selected={!archived && !attention}
          onClick={() => onChange({ status: "", scope: "active", attention: "" })}
        />
        <ScopeChip
          label={tr("sessions.scopeNeedsYou")}
          count={needsYouCount}
          describedBy={needsYouCount > 0 ? needsYouDescriptionId : undefined}
          selected={!archived && attention === "needs"}
          onClick={() => onChange({ status: "", scope: "active", attention: "needs" })}
        />
        <ScopeChip
          label={tr("sessions.scopeRunning")}
          count={runningCount}
          describedBy={runningCount > 0 ? runningDescriptionId : undefined}
          selected={!archived && attention === "running"}
          onClick={() => onChange({ status: "", scope: "active", attention: "running" })}
        />
        <ScopeChip
          label={tr("sessions.scopeArchived")}
          selected={archived}
          onClick={() => onChange({ status: "", scope: "archived", attention: "" })}
        />
        {needsYouCount > 0 && (
          <span id={needsYouDescriptionId} className="sr-only">
            {tr("sessions.scopeNeedsYouCount", { count: String(needsYouCount) })}
          </span>
        )}
        {runningCount > 0 && (
          <span id={runningDescriptionId} className="sr-only">
            {tr("sessions.scopeRunningCount", { count: String(runningCount) })}
          </span>
        )}
      </div>

      <Button
        ref={triggerRef}
        variant="quiet"
        // Astryx derives an accessible name from `aria-label`/string children;
        // this control's children are elements, so name it explicitly. The
        // count sentence stays a description, never part of the name.
        aria-label={activeCount > 0 ? summary : tr("sessions.filter")}
        aria-describedby={activeCount > 0 ? summaryDescriptionId : undefined}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={[
          "mt-1.5 inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-body font-medium",
          activeCount > 0
            ? "bg-kin-blue/10 text-kin-blue-ink"
            : "text-kin-muted hover:bg-[var(--kin-fill)]",
        ].join(" ")}
      >
        {/* One inline-flex row: Astryx's content slot is block-level, so bare
            SVG children (display: block) would stack the icon above the text on
            a narrow trigger. The wrapper keeps icon, summary, count and chevron
            on one line at every width. */}
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <IconFilter size={15} />
          <span className="min-w-0 truncate">
            {activeCount > 0 ? summary : tr("sessions.filter")}
          </span>
          {activeCount > 0 && (
            <>
              {/* The number alone would be announced as part of the name ("Failed
                  2") with no noun; the count reads after the summary instead. */}
              <span
                aria-hidden
                className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-kin-blue px-1 text-micro font-bold leading-flush text-kin-on-brand tabular-nums"
              >
                {activeCount}
              </span>
              <span id={summaryDescriptionId} className="sr-only">
                {tr("sessions.filterActiveCount", { count: String(activeCount) })}
              </span>
            </>
          )}
          <IconChevronDown
            size={14}
            strokeWidth={2.25}
            className={[
              "flex-none transition-transform duration-150",
              open ? "rotate-180" : "",
            ].join(" ")}
          />
        </span>
      </Button>

      {open && (
        <div
          id={panelId}
          className="mt-1.5 rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-3"
        >
          <p id={statusLabelId} className="text-caption font-semibold text-kin-muted">
            {tr("sessions.filterStatus")}
          </p>
          <div
            role="group"
            aria-labelledby={statusLabelId}
            className="mt-1.5 flex flex-wrap gap-1.5"
          >
            <Option
              label={tr("sessions.statusAll")}
              selected={!status}
              onClick={() => onChange({ status: "", scope, attention })}
            />
            {SESSION_STATUS_FILTERS.map((value) => (
              <Option
                key={value}
                label={tr(STATUS_LABEL_KEY[value])}
                selected={status === value}
                onClick={() =>
                  onChange({
                    status: status === value ? "" : value,
                    scope,
                    attention,
                  })
                }
              />
            ))}
          </div>

          {sortMode && onSortChange ? (
            <>
              <p id={sortLabelId} className="mt-3 text-caption font-semibold text-kin-muted">
                {tr("nav.sortProjects")}
              </p>
              <div
                role="group"
                aria-labelledby={sortLabelId}
                className="mt-1.5 flex flex-wrap gap-1.5"
              >
                <Option
                  label={tr("nav.sortByActive")}
                  selected={sortMode === "active"}
                  onClick={() => onSortChange("active")}
                />
                <Option
                  label={tr("nav.sortByCreated")}
                  selected={sortMode === "created"}
                  onClick={() => onSortChange("created")}
                />
              </div>
            </>
          ) : null}

          {activeCount > 0 && (
            <Button
              variant="quiet"
              onClick={() => onChange({ status: "", scope, attention })}
              className="mt-3 min-h-9 text-body font-medium text-kin-muted underline-offset-2 hover:text-kin-text hover:underline"
            >
              {tr("sessions.filterClear")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One view of the same list.
 *
 * The number is a mark, not part of the name: the visible bubble is
 * `aria-hidden`, and the chip points at a complete spoken sentence. Without
 * that split a screen reader would read "Needs you 3" and never say what the 3
 * counts.
 */
function ScopeChip({
  label,
  selected,
  count = 0,
  describedBy,
  onClick,
}: {
  label: string;
  selected: boolean;
  count?: number;
  describedBy?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="quiet"
      aria-label={label}
      aria-pressed={selected}
      aria-describedby={describedBy}
      onClick={onClick}
      className={[
        "inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-body font-medium",
        selected ? "bg-kin-blue/10 text-kin-blue-ink" : "text-kin-muted hover:text-kin-text",
      ].join(" ")}
    >
      <span>{label}</span>
      {count > 0 && (
        <span
          aria-hidden
          className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-kin-blue px-1 text-micro font-bold leading-flush text-kin-on-brand tabular-nums"
        >
          {count}
        </span>
      )}
    </Button>
  );
}

function Option({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="quiet"
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      className={[
        "inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-body font-medium",
        selected ? "bg-kin-blue text-kin-on-brand" : "bg-[var(--kin-fill-strong)] text-kin-text",
      ].join(" ")}
    >
      {/* Same inline-flex row as the trigger: a selected option's check mark is
          an SVG (block-level) and would otherwise sit above its label. */}
      <span className="inline-flex items-center gap-1.5">
        {selected && <IconCheck size={13} strokeWidth={2.5} />}
        <span>{label}</span>
      </span>
    </Button>
  );
}
