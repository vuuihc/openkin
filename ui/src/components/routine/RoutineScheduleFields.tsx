import { useMemo } from "react";
import { useT } from "../../i18n/react";

export const ROUTINE_INTERVAL_PRESETS = [
  { secs: 3600, key: "interval1h" as const },
  { secs: 21600, key: "interval6h" as const },
  { secs: 86400, key: "interval1d" as const },
  { secs: 604800, key: "interval1w" as const },
];

/** Local datetime-local string → unix ms, or null if empty/invalid. */
export function parseLocalDateTime(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  const ms = new Date(v).getTime();
  if (Number.isNaN(ms)) return null;
  return ms;
}

/** Default datetime-local value: next top of hour (or +1h if already past). */
export function defaultNextRunLocal(from = new Date()): string {
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toLocalInputValue(d);
}

export function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Props = {
  intervalSecs: number;
  onIntervalChange: (secs: number) => void;
  /** datetime-local string; empty = run ASAP (next tick). */
  nextRunLocal: string;
  onNextRunLocalChange: (v: string) => void;
  disabled?: boolean;
  /** Compact single-row layout for composer footer. */
  compact?: boolean;
};

/**
 * Interval + first-run clock shared by New Chat (routine mode) and Routines create.
 */
export default function RoutineScheduleFields({
  intervalSecs,
  onIntervalChange,
  nextRunLocal,
  onNextRunLocalChange,
  disabled,
  compact,
}: Props) {
  const tr = useT();
  const known = useMemo(
    () => ROUTINE_INTERVAL_PRESETS.some((p) => p.secs === intervalSecs),
    [intervalSecs],
  );

  const hint = useMemo(() => {
    const ms = parseLocalDateTime(nextRunLocal);
    if (ms == null) return tr("routines.nextRunAsap");
    try {
      return tr("routines.nextRunAt", {
        when: new Date(ms).toLocaleString(),
      });
    } catch {
      return tr("routines.nextRunAsap");
    }
  }, [nextRunLocal, tr]);

  return (
    <div
      className={
        compact
          ? "flex flex-wrap items-end gap-x-3 gap-y-2"
          : "grid gap-3 sm:grid-cols-2"
      }
    >
      <label className="block min-w-[8rem]">
        <span className="text-[11px] font-medium uppercase tracking-wide text-kin-muted">
          {tr("routines.intervalLabel")}
        </span>
        <select
          value={known ? intervalSecs : "custom"}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "custom") return;
            onIntervalChange(Number(v));
          }}
          className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2.5 py-1.5 text-[12.5px] text-kin-text outline-none focus:border-kin-blue/40 disabled:opacity-50"
        >
          {ROUTINE_INTERVAL_PRESETS.map((p) => (
            <option key={p.secs} value={p.secs}>
              {tr(`routines.${p.key}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="block min-w-[12rem] flex-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-kin-muted">
          {tr("routines.firstRunLabel")}
        </span>
        <input
          type="datetime-local"
          value={nextRunLocal}
          disabled={disabled}
          onChange={(e) => onNextRunLocalChange(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2.5 py-1.5 text-[12.5px] text-kin-text outline-none focus:border-kin-blue/40 disabled:opacity-50"
        />
        <span className="mt-1 block text-[11px] text-kin-muted">{hint}</span>
      </label>

      {nextRunLocal && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onNextRunLocalChange("")}
          className="self-end text-[12px] text-kin-secondary hover:text-kin-text disabled:opacity-50"
        >
          {tr("routines.clearFirstRun")}
        </button>
      )}
    </div>
  );
}
