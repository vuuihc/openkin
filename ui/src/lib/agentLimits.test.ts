import { describe, expect, it } from "vitest";
import {
  agentLimitProgress,
  agentLimitStatus,
  formatLimitLabel,
  combinedStatus,
  type AgentLimitProgressResult,
} from "./agentLimits";
import { formatCost } from "../api/client";
import { formatTokenCount } from "./usage";

describe("agentLimits helpers", () => {
  describe("agentLimitProgress", () => {
    it("returns null progress when limit is undefined", () => {
      const result = agentLimitProgress(5, undefined);
      expect(result).toBeNull();
    });

    it("computes ratio and clamps bar width at 100%", () => {
      // 50% usage
      const result = agentLimitProgress(5, 10) as AgentLimitProgressResult;
      expect(result).not.toBeNull();
      expect(result.ratio).toBeCloseTo(0.5);
      expect(result.barPct).toBe(50);
      expect(result.status).toBe("ok");
    });

    it("clamps bar width at 100 even when over", () => {
      const result = agentLimitProgress(15, 10) as AgentLimitProgressResult;
      expect(result).not.toBeNull();
      expect(result.ratio).toBeCloseTo(1.5);
      expect(result.barPct).toBe(100);
      expect(result.status).toBe("over");
    });

    it("handles zero limit gracefully (returns null)", () => {
      const result = agentLimitProgress(5, 0);
      expect(result).toBeNull();
    });
  });

  describe("agentLimitStatus", () => {
    it("returns ok below 80%", () => {
      expect(agentLimitStatus(0.79)).toBe("ok");
      expect(agentLimitStatus(0)).toBe("ok");
    });

    it("returns warn at exactly 80%", () => {
      expect(agentLimitStatus(0.8)).toBe("warn");
    });

    it("returns warn between 80% and 100%", () => {
      expect(agentLimitStatus(0.99)).toBe("warn");
    });

    it("returns over at exactly 100%", () => {
      expect(agentLimitStatus(1.0)).toBe("over");
    });

    it("returns over above 100%", () => {
      expect(agentLimitStatus(1.5)).toBe("over");
    });
  });

  describe("formatLimitLabel", () => {
    it("formats cost values with formatCost", () => {
      const label = formatLimitLabel(3.2, 10, "spend");
      expect(label).toBe(`${formatCost(3.2)} / ${formatCost(10)}`);
    });

    it("formats token values with formatTokenCount", () => {
      const label = formatLimitLabel(120000, 500000, "tokens");
      expect(label).toBe(`${formatTokenCount(120000)} / ${formatTokenCount(500000)}`);
    });
  });

  describe("combinedStatus", () => {
    it("picks the more severe of spend vs tokens", () => {
      // spend ok, tokens warn → warn
      expect(combinedStatus("ok", "warn")).toBe("warn");
      // spend warn, tokens ok → warn
      expect(combinedStatus("warn", "ok")).toBe("warn");
      // spend ok, tokens over → over
      expect(combinedStatus("ok", "over")).toBe("over");
      // spend over, tokens warn → over
      expect(combinedStatus("over", "warn")).toBe("over");
      // both ok → ok
      expect(combinedStatus("ok", "ok")).toBe("ok");
    });
  });
});
