/**
 * The four sections a phone's session list is read in, and the rule that puts a
 * row in exactly one of them.
 *
 * The list used to be one scroll sorted by "running first, then newest", which
 * is the right order and the wrong shape: on a 390px screen that is 9 screens of
 * undifferentiated rows (measured: 7218px of content in a 747px viewport), and
 * nothing on the way down tells you where "today" ended. Sections are what makes
 * a long list scannable, and the first section answers the question someone
 * actually opens this screen with — what is running right now.
 *
 * Pure functions over `(rows, now)`: no clock, no storage, no DOM, so the
 * boundaries are testable at the minute rather than by waiting for midnight.
 */
import { startOfDay } from "./relativeTime";

/** Priority order: the section a row lands in, first match wins. */
export type SessionBucketKey = "active" | "today" | "week" | "older";

/** Rendering order, and the only place the order is written down. */
export const SESSION_BUCKET_ORDER: readonly SessionBucketKey[] = [
  "active",
  "today",
  "week",
  "older",
];

/** Rolling window for the third section, today included. */
const WEEK_DAYS = 7;

export type Bucketable = { at: number; active: boolean };

export type SessionBucket<T> = { key: SessionBucketKey; rows: T[] };

/**
 * Which section a row belongs to.
 *
 * `active` beats the clock on purpose: a session that has been running (or
 * waiting for an approval) since three days ago is not history, it is the most
 * current thing on the screen. That is also why this replaced the old global
 * "running first" sort — the same intent, now expressed as a section so the
 * remaining rows can be ordered by time without fighting it.
 *
 * A row with no usable timestamp (`at` 0, which is what a task missing every
 * one of `finished_at`/`started_at`/`created_at` has) lands in `older`: it is
 * the bottom of the list, and inventing a "today" for it would put a row with a
 * "—" timestamp above rows that have one.
 */
export function bucketOf(row: Bucketable, now: number): SessionBucketKey {
  if (row.active) return "active";
  const today = startOfDay(now);
  if (row.at >= today) return "today";
  // Calendar arithmetic rather than `today - 6 * DAY_MS`: across a DST shift
  // the fixed-length subtraction drifts an hour off the boundary.
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - (WEEK_DAYS - 1));
  return row.at >= weekStart.getTime() ? "week" : "older";
}

/**
 * The rows, split into sections, in `SESSION_BUCKET_ORDER`.
 *
 * Empty sections are dropped — a phone should not scroll past a heading with
 * nothing under it — and the order inside a section is the caller's, untouched:
 * this decides *which* section a row is in, never where it sits in it.
 */
export function groupSessions<T extends Bucketable>(
  rows: readonly T[],
  now: number,
): SessionBucket<T>[] {
  const byKey = new Map<SessionBucketKey, T[]>();
  for (const row of rows) {
    const key = bucketOf(row, now);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }
  const out: SessionBucket<T>[] = [];
  for (const key of SESSION_BUCKET_ORDER) {
    const bucket = byKey.get(key);
    if (bucket && bucket.length > 0) out.push({ key, rows: bucket });
  }
  return out;
}
