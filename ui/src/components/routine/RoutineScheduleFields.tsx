import { useMemo } from "react";
import { useT } from "../../i18n/react";
import {
  localTimeZone,
  ROUTINE_HOUR_STEPS,
  ROUTINE_MINUTE_STEPS,
  type RoutineRule,
} from "../../lib/routineRecurrence";

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

/** Default datetime-local value: next top of the hour (or +1h if already past). */
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

const pad = (n: number) => String(n).padStart(2, "0");

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

type Props = {
  intervalSecs: number;
  onIntervalChange: (secs: number) => void;
  /** datetime-local string; empty = run ASAP (next tick). */
  nextRunLocal: string;
  onNextRunLocalChange: (v: string) => void;
  /**
   * A wall-clock rule, or null for an interval routine. The two controls are
   * exclusive: one select decides which, and only the fields that kind needs
   * are drawn.
   */
  rule: RoutineRule | null;
  onRuleChange: (rule: RoutineRule | null) => void;
  /**
   * The zone the rule's time is expressed in. Null/undefined means the
   * browser's — the case for every new routine. A name is a rule written in
   * that zone; "" is a rule stored with no zone, which the daemon fires on its
   * own local clock. The hint names whichever it is, because the time input
   * shows that zone's wall clock rather than the reader's.
   */
  ruleZone?: string | null;
  disabled?: boolean;
  /** Compact single-row layout for composer footer. */
  compact?: boolean;
};

/** The option value for the current schedule. */
function selectValue(rule: RoutineRule | null, intervalSecs: number): string {
  if (rule) return rule.kind;
  return `interval:${intervalSecs}`;
}

/**
 * Repeat + timing, shared by New Chat (routine mode) and Routines create.
 *
 * One select answers "how often", and the row below it asks only for what that
 * answer needs: an interval routine needs a first run, a clock rule needs a
 * time of day (plus days, when the rule names them), and a one-off needs an
 * instant. Keeping them in one control is what stops "every day" from meaning
 * both "24 hours from the last run" and "at 09:00" in the same form.
 */
export default function RoutineScheduleFields({
  intervalSecs,
  onIntervalChange,
  nextRunLocal,
  onNextRunLocalChange,
  rule,
  onRuleChange,
  ruleZone,
  disabled,
  compact,
}: Props) {
  const tr = useT();
  const value = selectValue(rule, intervalSecs);
  const known = useMemo(
    () => rule !== null || ROUTINE_INTERVAL_PRESETS.some((p) => p.secs === intervalSecs),
    [rule, intervalSecs],
  );

  const hint = useMemo(() => {
    if (rule && rule.kind !== "once") {
      if (ruleZone === "") return tr("routines.ruleTimezoneDaemon");
      return tr("routines.ruleTimezone", { zone: ruleZone || localTimeZone() });
    }
    const ms = parseLocalDateTime(nextRunLocal);
    if (ms == null) return tr("routines.nextRunAsap");
    try {
      return tr("routines.nextRunAt", { when: new Date(ms).toLocaleString() });
    } catch {
      return tr("routines.nextRunAsap");
    }
  }, [rule, ruleZone, nextRunLocal, tr]);

  function choose(next: string) {
    if (next.startsWith("interval:")) {
      onRuleChange(null);
      onIntervalChange(Number(next.slice("interval:".length)));
      return;
    }
    const kind = next as RoutineRule["kind"];
    if (rule && rule.kind === kind) return;
    switch (kind) {
      case "daily":
      case "weekdays":
        onRuleChange({ kind, hour: 9, minute: 0 });
        return;
      case "weekly":
        onRuleChange({ kind, hour: 9, minute: 0, weekdays: [1] });
        return;
      case "monthly":
        onRuleChange({ kind, hour: 9, minute: 0, days: [1] });
        return;
      case "hours":
        onRuleChange({ kind: "hours", every: 6 });
        return;
      case "minutes":
        onRuleChange({ kind: "minutes", every: 15 });
        return;
      case "once":
        onRuleChange({ kind: "once" });
        return;
    }
  }

  // The four kinds that name a time of day. A step rule has no clock to edit
  // and a one-off owns an instant instead.
  const clockRule =
    rule &&
    (rule.kind === "daily" ||
      rule.kind === "weekdays" ||
      rule.kind === "weekly" ||
      rule.kind === "monthly")
      ? rule
      : null;
  const stepRule = rule && (rule.kind === "minutes" || rule.kind === "hours") ? rule : null;

  return (
    <div
      className={compact ? "flex flex-wrap items-end gap-x-3 gap-y-2" : "grid gap-3 sm:grid-cols-2"}
    >
      <label className="block min-w-[8rem]">
        <span className="text-caption font-medium uppercase tracking-label text-kin-muted">
          {tr("routines.repeatLabel")}
        </span>
        <select
          value={known ? value : `interval:${intervalSecs}`}
          disabled={disabled}
          onChange={(e) => choose(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2.5 py-1.5 text-body text-kin-text outline-none focus:border-kin-blue/40 disabled:opacity-50"
        >
          <optgroup label={tr("routines.repeatIntervalGroup")}>
            {ROUTINE_INTERVAL_PRESETS.map((p) => (
              <option key={p.secs} value={`interval:${p.secs}`}>
                {tr(`routines.${p.key}`)}
              </option>
            ))}
          </optgroup>
          <optgroup label={tr("routines.repeatRuleGroup")}>
            <option value="daily">{tr("routines.repeatDaily")}</option>
            <option value="weekdays">{tr("routines.repeatWeekdays")}</option>
            <option value="weekly">{tr("routines.repeatWeekly")}</option>
            <option value="monthly">{tr("routines.repeatMonthly")}</option>
            <option value="hours">{tr("routines.repeatEveryHours")}</option>
            <option value="minutes">{tr("routines.repeatEveryMinutes")}</option>
            <option value="once">{tr("routines.repeatOnce")}</option>
          </optgroup>
        </select>
      </label>

      {stepRule ? (
        <label className="block min-w-[8rem]">
          <span className="text-caption font-medium uppercase tracking-label text-kin-muted">
            {tr("routines.everyLabel")}
          </span>
          <select
            value={String(stepRule.every)}
            disabled={disabled}
            onChange={(e) => onRuleChange({ ...stepRule, every: Number(e.target.value) })}
            className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2.5 py-1.5 text-body text-kin-text outline-none focus:border-kin-blue/40 disabled:opacity-50"
          >
            {(stepRule.kind === "minutes" ? ROUTINE_MINUTE_STEPS : ROUTINE_HOUR_STEPS).map(
              (step) => (
                <option key={step} value={String(step)}>
                  {tr(
                    stepRule.kind === "minutes" ? "routines.everyNMinutes" : "routines.everyNHours",
                    { n: step },
                  )}
                </option>
              ),
            )}
          </select>
        </label>
      ) : clockRule ? (
        <>
          <label className="block min-w-[8rem]">
            <span className="text-caption font-medium uppercase tracking-label text-kin-muted">
              {tr("routines.timeLabel")}
            </span>
            <input
              type="time"
              value={`${pad(clockRule.hour)}:${pad(clockRule.minute)}`}
              disabled={disabled}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":");
                const hour = Number(h);
                const minute = Number(m);
                if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
                onRuleChange({ ...clockRule, hour, minute });
              }}
              className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2.5 py-1.5 text-body text-kin-text outline-none focus:border-kin-blue/40 disabled:opacity-50"
            />
          </label>

          {clockRule.kind === "weekly" && (
            <fieldset className="block min-w-[12rem] flex-1">
              <legend className="text-caption font-medium uppercase tracking-label text-kin-muted">
                {tr("routines.weekdayLabel")}
              </legend>
              <div className="mt-1 flex gap-1">
                {WEEKDAYS.map((d) => {
                  const on = clockRule.weekdays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      disabled={disabled}
                      aria-pressed={on}
                      aria-label={tr(`routines.weekday${d}`)}
                      onClick={() => {
                        // At least one day has to stay chosen: an empty weekly
                        // rule is one the daemon would refuse to store.
                        const next = on
                          ? clockRule.weekdays.filter((x) => x !== d)
                          : [...clockRule.weekdays, d];
                        if (next.length === 0) return;
                        onRuleChange({ ...clockRule, weekdays: next });
                      }}
                      className={[
                        "h-9 w-9 rounded-lg text-caption font-medium transition-colors disabled:opacity-50",
                        on
                          ? "bg-kin-blue/15 text-kin-blue-ink"
                          : "bg-[var(--kin-fill)] text-kin-secondary hover:text-kin-text",
                      ].join(" ")}
                    >
                      {tr(`routines.weekday${d}`)}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          {clockRule.kind === "monthly" && (
            <label className="block min-w-[6rem]">
              <span className="text-caption font-medium uppercase tracking-label text-kin-muted">
                {tr("routines.dayOfMonthLabel")}
              </span>
              <input
                type="number"
                min={1}
                max={31}
                value={clockRule.days[0] ?? 1}
                disabled={disabled}
                onChange={(e) => {
                  const day = Math.min(31, Math.max(1, Number(e.target.value) || 1));
                  onRuleChange({ ...clockRule, days: [day] });
                }}
                className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2.5 py-1.5 text-body text-kin-text outline-none focus:border-kin-blue/40 disabled:opacity-50"
              />
            </label>
          )}
        </>
      ) : (
        <label className="block min-w-[12rem] flex-1">
          <span className="text-caption font-medium uppercase tracking-label text-kin-muted">
            {rule && rule.kind === "once" ? tr("routines.onceLabel") : tr("routines.firstRunLabel")}
          </span>
          <input
            type="datetime-local"
            value={nextRunLocal}
            disabled={disabled}
            onChange={(e) => onNextRunLocalChange(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2.5 py-1.5 text-body text-kin-text outline-none focus:border-kin-blue/40 disabled:opacity-50"
          />
        </label>
      )}

      {/* Its own line: in the compact strip the hint shares the row with the
          fields, and a wrapping sentence there squeezes the input it explains. */}
      <span className="block basis-full text-caption text-kin-muted">{hint}</span>

      {!rule && nextRunLocal && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onNextRunLocalChange("")}
          className="self-end text-body text-kin-secondary hover:text-kin-text disabled:opacity-50"
        >
          {tr("routines.clearFirstRun")}
        </button>
      )}
    </div>
  );
}
