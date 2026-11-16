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
  | { kind: "minutes"; every: number }
  | { kind: "hours"; every: number }
  | { kind: "once" };

/** The kinds a user can pick, in the order the form offers them. */
export const ROUTINE_RULE_KINDS = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "hours",
  "minutes",
  "once",
] as const;

/**
 * Steps for the "every few hours / minutes" rules. These are exactly the steps
 * the daemon accepts — the hour divisors up to half a day, and the five-minute
 * marks — so a value the form can draw is a value the daemon will store, and a
 * stored rule always has an option to show.
 */
export const ROUTINE_HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
export const ROUTINE_MINUTE_STEPS = [5, 10, 15, 20, 30] as const;

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

/** Whether the platform knows this zone name (the daemon rejects unknown ones). */
function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone a stored rule is expressed in.
 *
 *   null  — no readable rule (or one naming a zone this platform cannot load)
 *   ""    — a rule that names no zone, which the daemon reads as its own local
 *           zone. A save must keep it zone-less rather than stamp the browser's.
 *   name  — that zone.
 *
 * The rule's hour and minute mean "this wall clock in that zone". An editor in
 * another zone must keep the name: converting the clock would be wrong for a
 * rule that repeats, because the offset between the zones changes with the
 * other zone's daylight saving, and a weekly rule has no single instant to
 * convert.
 */
export function ruleTimeZone(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const zone = (data as Record<string, unknown>).time_zone;
  if (zone === undefined || zone === null || zone === "") return "";
  if (typeof zone !== "string") return null;
  const trimmed = zone.trim();
  if (!trimmed) return "";
  return isKnownTimeZone(trimmed) ? trimmed : null;
}

/**
 * The settings value for a rule, or "" for an interval routine.
 *
 * `onceAt` is the date-time the form holds for a one-off; it is only read when
 * the rule is a one-off, because that is the only kind that needs an instant.
 * `zone` is the zone the hour/minute are expressed in — the browser's for a new
 * rule, the stored one when an edit keeps a rule that was written elsewhere.
 */
export function serializeRoutineRule(
  rule: RoutineRule | null,
  onceAt: number | null,
  zone: string = localTimeZone(),
): string {
  if (!rule) return "";
  if (rule.kind === "once") {
    if (onceAt == null) return "";
    return JSON.stringify({ kind: "once", at: onceAt, time_zone: zone });
  }
  if (rule.kind === "minutes" || rule.kind === "hours") {
    return JSON.stringify({ kind: rule.kind, every: rule.every, time_zone: zone });
  }
  const base = {
    kind: rule.kind,
    hour: rule.hour,
    minute: rule.minute,
    time_zone: zone,
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
 * One clock field, defaulted the way the daemon defaults it: a missing value is
 * zero, but a present one must be the integer the Go struct can decode.
 */
function clockField(row: Record<string, unknown>, key: string, max: number): number | null {
  const v = row[key];
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) return null;
  return v;
}

/** A day list the daemon would accept: integers in range, no repeats, non-empty. */
function dayList(
  row: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number[] | null {
  const raw = row[key];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const days: number[] = [];
  for (const d of raw) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < min || d > max) return null;
    if (days.includes(d)) return null;
    days.push(d);
  }
  return days;
}

/**
 * The step of a minutes/hours rule: one of the values the daemon accepts, which
 * are the same values the form draws. Membership rather than a range check, so
 * the two sides cannot drift apart.
 */
function stepField(kind: "minutes" | "hours", raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  const steps: readonly number[] = kind === "minutes" ? ROUTINE_MINUTE_STEPS : ROUTINE_HOUR_STEPS;
  return steps.includes(raw) ? raw : null;
}

/**
 * Read a stored rule back. Anything the daemon would refuse to fire is null —
 * the form then shows the routine as interval-only, which is what the scheduler
 * would do with an unreadable rule anyway, and a save clears it instead of
 * holding the row in a state that never runs.
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
  const zone = row.time_zone;
  if (zone !== undefined && zone !== null && zone !== "") {
    if (typeof zone !== "string" || !isKnownTimeZone(zone.trim())) return null;
  }
  switch (kind) {
    case "daily":
    case "weekdays": {
      const hour = clockField(row, "hour", 23);
      const minute = clockField(row, "minute", 59);
      if (hour == null || minute == null) return null;
      return { kind, hour, minute };
    }
    case "weekly": {
      const hour = clockField(row, "hour", 23);
      const minute = clockField(row, "minute", 59);
      const days = dayList(row, "weekdays", 0, 6);
      if (hour == null || minute == null || !days) return null;
      return { kind, hour, minute, weekdays: days };
    }
    case "monthly": {
      const hour = clockField(row, "hour", 23);
      const minute = clockField(row, "minute", 59);
      const days = dayList(row, "days", 1, 31);
      if (hour == null || minute == null || !days) return null;
      return { kind, hour, minute, days };
    }
    case "once": {
      const at = row.at;
      if (typeof at !== "number" || !Number.isInteger(at) || at <= 0) return null;
      return { kind: "once" };
    }
    case "minutes":
    case "hours": {
      const every = stepField(kind, row.every);
      if (every == null) return null;
      return { kind, every };
    }
    default:
      return null;
  }
}

/** "09:05" for a rule's time of day. */
export function formatRuleTime(rule: RoutineRule): string {
  if (rule.kind === "once" || rule.kind === "minutes" || rule.kind === "hours") return "";
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
    case "minutes":
      return tr("routines.ruleEveryMinutes", { every: rule.every });
    case "hours":
      return tr("routines.ruleEveryHours", { every: rule.every });
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
