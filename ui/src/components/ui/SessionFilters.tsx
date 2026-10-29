import { useId, useRef, useState } from "react";
import { useT } from "../../i18n/react";
import { IconCheck, IconChevronDown, IconFilter } from "../icons";

/**
 * The conversation list's filter: status and project scope.
 *
 * Status travels to the daemon (`?status=`), because narrowing only the loaded
 * page would answer "no running chats" about a page that merely ended — and
 * the loaded page is 100 rows. Imported agent sessions carry no status, so the
 * page hides them while one is set.
 *
 * Scope is the other half of archiving: the list hides archived projects, and
 * this is the one place that shows them again so one can be restored without
 * opening the drawer.
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

export default function SessionFilters({
  status,
  scope,
  onChange,
}: {
  status: SessionStatusFilter;
  scope: SessionScopeFilter;
  onChange: (next: { status: SessionStatusFilter; scope: SessionScopeFilter }) => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const statusLabelId = useId();
  const scopeLabelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeCount = (status ? 1 : 0) + (scope === "archived" ? 1 : 0);
  const summary = [
    status ? tr(STATUS_LABEL_KEY[status]) : "",
    scope === "archived" ? tr("sessions.scopeArchived") : "",
  ]
    .filter(Boolean)
    .join(" · ");

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
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={[
          "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-body font-medium",
          activeCount > 0
            ? "bg-kin-blue/10 text-kin-blue-ink"
            : "text-kin-muted hover:bg-[var(--kin-fill)]",
        ].join(" ")}
      >
        <IconFilter size={15} />
        <span className="min-w-0 truncate">
          {activeCount > 0 ? summary : tr("sessions.filter")}
        </span>
        {activeCount > 0 && (
          <>
            {/* The number alone would be announced as part of the name ("Failed
                · Archived 2") with no noun; the count reads after the summary
                instead. */}
            <span
              aria-hidden
              className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-kin-blue px-1 text-micro font-bold leading-flush text-kin-on-brand tabular-nums"
            >
              {activeCount}
            </span>
            <span className="sr-only">
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
      </button>

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
              onClick={() => onChange({ status: "", scope })}
            />
            {SESSION_STATUS_FILTERS.map((value) => (
              <Option
                key={value}
                label={tr(STATUS_LABEL_KEY[value])}
                selected={status === value}
                onClick={() =>
                  onChange({ status: status === value ? "" : value, scope })
                }
              />
            ))}
          </div>

          <p id={scopeLabelId} className="mt-3 text-caption font-semibold text-kin-muted">
            {tr("sessions.filterScope")}
          </p>
          <div
            role="group"
            aria-labelledby={scopeLabelId}
            className="mt-1.5 flex flex-wrap gap-1.5"
          >
            <Option
              label={tr("sessions.scopeActive")}
              selected={scope === "active"}
              onClick={() => onChange({ status, scope: "active" })}
            />
            <Option
              label={tr("sessions.scopeArchived")}
              selected={scope === "archived"}
              onClick={() => onChange({ status, scope: "archived" })}
            />
          </div>

          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => onChange({ status: "", scope: "active" })}
              className="mt-3 min-h-9 text-body font-medium text-kin-muted underline-offset-2 hover:text-kin-text hover:underline"
            >
              {tr("sessions.filterClear")}
            </button>
          )}
        </div>
      )}
    </div>
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
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        "inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-body font-medium",
        selected
          ? "bg-kin-blue text-kin-on-brand"
          : "bg-[var(--kin-fill-strong)] text-kin-text",
      ].join(" ")}
    >
      {selected && <IconCheck size={13} strokeWidth={2.5} />}
      {label}
    </button>
  );
}
