/**
 * "2 分钟前" / "yesterday" — a session list needs a *when*, not a timestamp.
 *
 * Intl.RelativeTimeFormat rather than locale strings: the runtime already knows
 * how to say "昨天" / "yesterday", so there is no key to keep in step. The
 * locale is the console's own (`getLocale`), not the device's — an
 * English-region iPhone running the Chinese console would otherwise print
 * "2 minutes ago" in the middle of an otherwise Chinese list.
 */
import { getLocale, type Locale } from "../i18n";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const DIVISIONS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
];

const formatters = new Map<string, Intl.RelativeTimeFormat>();

function relative(locale: Locale): Intl.RelativeTimeFormat | null {
  const cached = formatters.get(locale);
  if (cached) return cached;
  try {
    const made = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    formatters.set(locale, made);
    return made;
  } catch {
    return null;
  }
}

/**
 * The local start of the day `ms` falls in.
 *
 * Local rather than UTC because "today" on the tray, on the tasks page and in
 * the session list means *the user's* day — a UTC boundary would move the line
 * under a session at 8am in Shanghai. `setHours` rather than subtracting a day
 * length, so the boundary follows the clock through a DST shift instead of
 * landing an hour off it.
 *
 * Shared rather than re-derived: three surfaces filter by "since midnight", and
 * three copies of the same two lines is how they drift apart.
 */
export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** A short "when" for a list row: relative inside a week, a date beyond it. */
export function formatRelativeTime(
  ms: number,
  now = Date.now(),
  locale: Locale = getLocale(),
): string {
  if (!ms) return "—";
  const diff = now - ms;
  if (diff >= WEEK_MS) {
    // Past a week "3 weeks ago" stops being what anyone is scanning for; the
    // date is the more useful answer.
    try {
      return new Date(ms).toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
      });
    } catch {
      return "—";
    }
  }
  const rtf = relative(locale);
  if (!rtf) return "—";
  let delta = diff / 1000;
  for (const [unit, span] of DIVISIONS) {
    if (Math.abs(delta) < span) return rtf.format(-Math.round(delta), unit);
    delta /= span;
  }
  return rtf.format(-Math.round(delta), "day");
}
