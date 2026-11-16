import { describe, expect, it } from "vitest";
import { formatInterval, formatWhen } from "./routineTime";

/**
 * Three places show a routine's wall time — the next-due preview, the list row
 * and a run card — and all three read it through `formatWhen`. The move out of
 * the page must not change a single character, so the contract is pinned here:
 * a missing instant is a dash, and a real one is the reader's own long date
 * and time.
 */
describe("formatWhen", () => {
  it("reads a missing instant as a dash", () => {
    expect(formatWhen()).toBe("—");
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen(0)).toBe("—");
  });

  it("renders an instant with the reader's locale and timezone", () => {
    // `toLocaleString` is the contract; a hard-coded string would pin the
    // machine that runs the test instead of the behaviour. Both an older
    // timestamp and one just now take the same path.
    const older = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(formatWhen(older)).toBe(new Date(older).toLocaleString());
    const justNow = Date.now();
    expect(formatWhen(justNow)).toBe(new Date(justNow).toLocaleString());
  });
});

describe("formatInterval", () => {
  it("keeps the short unit the routine row has always shown", () => {
    const cases: Array<[number, string]> = [
      [5, "5s"],
      [59, "59s"],
      [60, "1m"],
      [90, "2m"],
      [3600, "1h"],
      [7200, "2h"],
      [86400, "1d"],
      [172800, "2d"],
    ];
    for (const [secs, expected] of cases) {
      expect(formatInterval(secs)).toBe(expected);
    }
  });
});
