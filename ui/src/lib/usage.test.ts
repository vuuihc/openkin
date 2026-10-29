import { describe, expect, it } from "vitest";
import {
  cacheCoverageLabel,
  cacheRateLabel,
  cacheState,
  contextFill,
  costSourceLabelKey,
  formatTokenCount,
  primaryCostSource,
} from "./usage";

describe("usage helpers", () => {
  it("formats token counts compactly", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_250)).toBe("1.3k");
    expect(formatTokenCount(1_250_000)).toBe("1.25M");
  });

  it("keeps a provider-reported zero distinct from unavailable cache data", () => {
    expect(cacheState("reported", 0)).toBe("reported");
    expect(cacheRateLabel("reported", 0)).toBe("0%");
    expect(cacheState("unknown", null)).toBe("unknown");
    expect(cacheRateLabel("unknown", null)).toBe("—");
  });

  it("preserves unsupported and mixed cache states", () => {
    expect(cacheState("unsupported", null)).toBe("unsupported");
    expect(cacheState("mixed", 0.42)).toBe("mixed");
    expect(cacheRateLabel("mixed", 0.42)).toBe("42%");
  });

  it("formats cache coverage only when partial", () => {
    expect(cacheCoverageLabel(null)).toBeNull();
    expect(cacheCoverageLabel(1)).toBeNull();
    expect(cacheCoverageLabel(0)).toBe("0%");
    expect(cacheCoverageLabel(0.625)).toBe("63%");
  });

  it("picks the dominant cost source by spend", () => {
    expect(
      primaryCostSource([
        { cost_source: "provider", cost_usd: 0.01, request_count: 1 },
        { cost_source: "price_table", cost_usd: 0.05, request_count: 2 },
      ]),
    ).toBe("price_table");
    expect(costSourceLabelKey("price_table")).toBe("costEstimated");
    expect(costSourceLabelKey("provider")).toBe("costProvider");
    expect(costSourceLabelKey("unknown")).toBeNull();
  });
});

describe("contextFill", () => {
  it("reports the fraction and the level", () => {
    const fill = contextFill({ tokens: 50_000 }, 200_000);
    expect(fill).toEqual({
      tokens: 50_000,
      window: 200_000,
      ratio: 0.25,
      percent: 25,
      level: "ok",
    });
  });

  it("changes level at the percentage the reader sees, not the exact fraction", () => {
    // The colour and the number cannot disagree: 159,999 of 200,000 rounds to
    // "80%", so it is already the warning line.
    const justUnder = contextFill({ tokens: 159_999 }, 200_000);
    expect(justUnder?.percent).toBe(80);
    expect(justUnder?.level).toBe("warn");
    // 79% stays calm; 80% and 94% warn; 95% is full.
    for (const [percent, level] of [
      [79, "ok"],
      [80, "warn"],
      [94, "warn"],
      [95, "full"],
      [100, "full"],
    ] as const) {
      const fill = contextFill({ tokens: (200_000 * percent) / 100 }, 200_000);
      expect([percent, fill?.level]).toEqual([percent, level]);
    }
  });

  it("clamps the ratio but not the percentage", () => {
    const fill = contextFill({ tokens: 260_000 }, 200_000);
    expect(fill?.ratio).toBe(1);
    expect(fill?.percent).toBe(130);
    expect(fill?.level).toBe("full");
  });

  it("answers null when either half is unknown", () => {
    // No window: a model the price table does not carry.
    expect(contextFill({ tokens: 1000 }, 0)).toBeNull();
    expect(contextFill({ tokens: 1000 }, null)).toBeNull();
    expect(contextFill({ tokens: 1000 }, undefined)).toBeNull();
    // No request has reported input yet.
    expect(contextFill({ tokens: 0 }, 200_000)).toBeNull();
    expect(contextFill({}, 200_000)).toBeNull();
    expect(contextFill(null, 200_000)).toBeNull();
    expect(contextFill(undefined, 200_000)).toBeNull();
    // Negative and NaN counts are not measurements.
    expect(contextFill({ tokens: -5 }, 200_000)).toBeNull();
    expect(contextFill({ tokens: Number.NaN }, 200_000)).toBeNull();
  });
});
