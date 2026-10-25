import { describe, expect, it } from "vitest";
import { bucketOf, groupSessions, SESSION_BUCKET_ORDER } from "./sessionBuckets";
import { startOfDay } from "./relativeTime";

/**
 * Fixtures are built in *local* time on purpose: the boundaries under test are
 * local-calendar boundaries, so a `Date.UTC` fixture would pass in London and
 * fail in Shanghai — the same class of bug the buckets exist to avoid.
 */
const NOON = new Date(2026, 9, 23, 12, 0, 0).getTime();
const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;

const TODAY_START = startOfDay(NOON);
const WEEK_START = (() => {
  const d = new Date(TODAY_START);
  d.setDate(d.getDate() - 6);
  return d.getTime();
})();

const row = (at: number, active = false) => ({ at, active, id: `row-${at}-${active}` });

describe("bucketOf", () => {
  it("splits today from the week at local midnight, not at a day length", () => {
    expect(bucketOf(row(TODAY_START), NOON)).toBe("today");
    expect(bucketOf(row(TODAY_START - 1), NOON)).toBe("week");
    expect(bucketOf(row(NOON), NOON)).toBe("today");
  });

  it("holds exactly seven local days, today included", () => {
    expect(bucketOf(row(WEEK_START), NOON)).toBe("week");
    expect(bucketOf(row(WEEK_START - 1), NOON)).toBe("older");
  });

  it("puts an active session in the first section whatever the clock says", () => {
    // The row this rule exists for: still running, started three days ago.
    expect(bucketOf(row(NOON - 3 * day, true), NOON)).toBe("active");
    expect(bucketOf(row(WEEK_START - 40 * day, true), NOON)).toBe("active");
  });

  it("sends a row with no usable timestamp to the bottom", () => {
    // `at: 0` is what a task missing finished_at/started_at/created_at has.
    expect(bucketOf(row(0), NOON)).toBe("older");
  });

  it("treats a future timestamp as today rather than dropping it", () => {
    // Clock skew between the daemon and the phone is real, and a session that
    // lands in no section at all is a session that disappears from the list.
    expect(bucketOf(row(NOON + hour), NOON)).toBe("today");
    expect(bucketOf(row(NOON + 40 * day), NOON)).toBe("today");
  });
});

describe("groupSessions", () => {
  const active = row(NOON - 40 * day, true);
  const today = row(NOON - hour);
  const week = row(NOON - 3 * day);
  const older = row(NOON - 40 * day);

  it("orders sections by what the list is scanned for, not by input order", () => {
    const grouped = groupSessions([older, week, today, active], NOON);
    expect(grouped.map((b) => b.key)).toEqual([...SESSION_BUCKET_ORDER]);
    expect(grouped.flatMap((b) => b.rows)).toHaveLength(4);
  });

  it("places each row in exactly one section", () => {
    // An active row from today must not appear twice: once under 进行中 and
    // again under 今天.
    const running = row(NOON, true);
    const grouped = groupSessions([running, today], NOON);
    expect(grouped.map((b) => b.key)).toEqual(["active", "today"]);
    expect(grouped[0]!.rows).toEqual([running]);
    expect(grouped[1]!.rows).toEqual([today]);
  });

  it("drops empty sections instead of drawing a heading with nothing under it", () => {
    expect(groupSessions([today], NOON).map((b) => b.key)).toEqual(["today"]);
    expect(groupSessions([], NOON)).toEqual([]);
  });

  it("leaves the order inside a section to the caller", () => {
    const newest = row(NOON - min);
    const olderToday = row(NOON - 6 * hour);
    const grouped = groupSessions([olderToday, newest], NOON);
    expect(grouped[0]!.rows).toEqual([olderToday, newest]);
  });

  it("keeps the row objects themselves, so a caller can still key on them", () => {
    const grouped = groupSessions([today], NOON);
    expect(grouped[0]!.rows[0]).toBe(today);
  });
});
