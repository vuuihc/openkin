import { describe, expect, it } from "vitest";
import {
  cacheCoverageLabel,
  cacheRateLabel,
  cacheState,
  formatTokenCount,
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
});
