import { describe, expect, it } from "vitest";
import type { OnePagerSummary } from "../api/client";

/** Mirrors empty detection used by ProjectSummaryCard. */
function isSummaryEmpty(summary?: OnePagerSummary | null): boolean {
  if (!summary) return true;
  if (summary.empty) return true;
  return !summary.north_star && !summary.focus && !(summary.next?.length);
}

describe("project summary empty states", () => {
  it("treats missing summary as empty", () => {
    expect(isSummaryEmpty(null)).toBe(true);
    expect(isSummaryEmpty(undefined)).toBe(true);
  });

  it("respects empty flag and fields", () => {
    expect(isSummaryEmpty({ empty: true })).toBe(true);
    expect(isSummaryEmpty({ empty: false, focus: "Ship wrap-up" })).toBe(false);
    expect(
      isSummaryEmpty({ empty: false, next: ["Wire recycle UI"] }),
    ).toBe(false);
  });
});
