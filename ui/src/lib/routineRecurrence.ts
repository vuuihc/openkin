/**
 * A routine's wall-clock rule, as the console lets a user pick it.
 *
 * The daemon stores the rule as JSON and the scheduler fires on it; this module
 * is the one place that writes and reads that shape on the client, so the form,
 * the create call and the list chip cannot disagree about it.
 *
 * `once` carries no instant here: the form already has one date-time control,
 * and which field it feeds depends on the chosen kind. `serializeRoutineRule`
 * is where that choice becomes the JSON the daemon sees.
 */
export type RoutineRule =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; hour: number; minute: number; weekdays: number[] }
  | { kind: "monthly"; hour: number; minute: number; days: number[] }
  | { kind: "once" };

/** The kinds a user can pick, in the order the form offers them. */
export const ROUTINE_RULE_KINDS = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "once",
] as const;

export type RoutineRuleKind = RoutineRule["kind"];

/** The browser's zone, which is the one the picker is expressed in. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The settings value for a rule, or "" for an interval routine.
 *
 * `onceAt` is the date-time the form holds for a one-off; it is only read when
 * the rule is a one-off, because that is the only kind that needs an instant.
 */
export function serializeRoutineRule(
  rule: RoutineRule | null,
  onceAt: number | null,
): string {
  if (!rule) return "";
  if (rule.kind === "once") {
    if (onceAt == null) return "";
    return JSON.stringify({ kind: "once", at: onceAt, time_zone: localTimeZone() });
  }
  const base = {
    kind: rule.kind,
    hour: rule.hour,
    minute: rule.minute,
    time_zone: localTimeZone(),
  };
  if (rule.kind === "weekly") {
    return JSON.stringify({ ...base, weekdays: [...rule.weekdays].sort((a, b) => a - b) });
  }
  if (rule.kind === "monthly") {
    return JSON.stringify({ ...base, days: [...rule.days].sort((a, b) => a - b) });
  }
  return JSON.stringify(base);
}

/**
 * Read a stored rule back. Unknown or malformed JSON is null — the form then
 * shows the routine as interval-only, which is what the scheduler would do with
 * an unreadable rule anyway (it refuses to fire it).
 */
export function parseRoutineRule(raw: string | null | undefined): RoutineRule | null {
  if (!raw || !raw.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const kind = row.kind;
  const hour = typeof row.hour === "number" ? row.hour : 0;
  const minute = typeof row.minute === "number" ? row.minute : 0;
  switch (kind) {
    case "daily":
    case "weekdays":
      return { kind, hour, minute };
    case "weekly": {
      const days = Array.isArray(row.weekdays)
        ? row.weekdays.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6)
        : [];
      return days.length ? { kind, hour, minute, weekdays: days } : null;
    }
    case "monthly": {
      const days = Array.isArray(row.days)
        ? row.days.filter((d): d is number => typeof d === "number" && d >= 1 && d <= 31)
        : [];
      return days.length ? { kind, hour, minute, days } : null;
    }
    case "once":
      return { kind: "once" };
    default:
      return null;
  }
}

/** "09:05" for a rule's time of day. */
export function formatRuleTime(rule: RoutineRule): string {
  if (rule.kind === "once") return "";
  return `${pad(rule.hour)}:${pad(rule.minute)}`;
}

/**
 * The rule in one line, for the list.
 *
 * The wording lives in the locale files; this only decides which key and which
 * parameters. A rule with no text (a one-off) returns null, because the list
 * already shows its next run and repeating it would say nothing new.
 */
export function describeRoutineRule(
  rule: RoutineRule | null,
  tr: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (!rule) return null;
  const time = formatRuleTime(rule);
  switch (rule.kind) {
    case "daily":
      return tr("routines.ruleDaily", { time });
    case "weekdays":
      return tr("routines.ruleWeekdays", { time });
    case "weekly":
      return tr("routines.ruleWeekly", {
        time,
        days: rule.weekdays.map((d) => tr(`routines.weekday${d}`)).join(", "),
      });
    case "monthly":
      return tr("routines.ruleMonthly", { time, days: rule.days.join(", ") });
    case "once":
      return null;
  }
}

/**
 * The date-time a one-off should default to: the next top of the hour, in the
 * shape a `datetime-local` input wants.
 */
export function defaultOnceLocalValue(from = new Date()): string {
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
