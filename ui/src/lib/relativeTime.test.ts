import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relativeTime";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const min = 60_000;
const hour = 60 * min;

describe("formatRelativeTime", () => {
  // Locale is explicit here: the console's locale, not the test machine's, is
  // what the UI uses, so the tests pin it too.
  it("returns a dash for a missing timestamp", () => {
    expect(formatRelativeTime(0, NOW, "zh")).toBe("—");
  });

  it("stays relative inside a week", () => {
    const two = formatRelativeTime(NOW - 2 * min, NOW, "zh");
    expect(two).toContain("2");
    expect(two).toContain("分");
    expect(two.length).toBeLessThan(20);
    expect(two).not.toContain("2026");
    expect(formatRelativeTime(NOW - 3 * hour, NOW, "zh")).not.toContain("2026");
  });

  it("speaks the console's locale, not the device's", () => {
    // The bug this guards: an English-region phone running the Chinese console
    // printed "2 minutes ago" in the middle of a Chinese list.
    expect(formatRelativeTime(NOW - 2 * min, NOW, "en")).toContain("minute");
    expect(formatRelativeTime(NOW - 2 * min, NOW, "zh")).not.toMatch(/minute|ago/);
  });

  it("switches to a date past a week", () => {
    const old = formatRelativeTime(NOW - 9 * 24 * hour, NOW, "zh");
    expect(old).not.toMatch(/前|ago/);
    // A date, not a duration: it names the month it happened in.
    expect(old.length).toBeGreaterThan(2);
  });

  it("does not divide by zero on a clock that runs backwards", () => {
    // A daemon and a browser can disagree by a second; a future stamp must not
    // crash the list or print garbage.
    expect(formatRelativeTime(NOW + 5_000, NOW, "zh")).not.toBe("—");
  });
});
