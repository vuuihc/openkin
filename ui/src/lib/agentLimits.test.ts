import { describe, expect, it } from "vitest";
import {
  agentLimitProgress,
  agentLimitStatus,
  formatLimitLabel,
  combinedStatus,
  quotaWait,
  waitParts,
  type AgentLimitProgressResult,
} from "./agentLimits";
import { formatCost } from "../api/client";
import { formatTokenCount } from "./usage";

describe("agentLimits helpers (KIN-AGENTS-001)", () => {
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

  describe("quotaWait", () => {
    const dayStart = new Date(2026, 10, 11, 0, 0, 0);
    const periodStart = dayStart.toISOString();
    const now = new Date(2026, 10, 11, 10, 12, 0).getTime();

    it("counts how long this console has watched an over-limit agent wait", () => {
      const wait = quotaWait({ status: "over", period_start: periodStart }, now - 12 * 60_000, now);
      expect(wait.waiting).toBe(true);
      expect(wait.elapsedMs).toBe(12 * 60_000);
      // Recovery is the next turn of the daily period.
      expect(wait.recoveryAt).toBe(new Date(2026, 10, 12, 0, 0, 0).getTime());
    });

    it("has no duration before the console has ever seen it waiting", () => {
      const wait = quotaWait({ status: "over", period_start: periodStart }, null, now);
      expect(wait.waiting).toBe(true);
      expect(wait.elapsedMs).toBeNull();
      expect(wait.recoveryAt).not.toBeNull();
    });

    it("is not waiting below the limit", () => {
      expect(quotaWait({ status: "warn", period_start: periodStart }, now, now)).toEqual({
        waiting: false,
        elapsedMs: null,
        recoveryAt: null,
      });
      expect(quotaWait(null, now, now).waiting).toBe(false);
    });

    it("splits a duration into the two units the label needs", () => {
      expect(waitParts(0)).toEqual({ hours: 0, minutes: 0 });
      expect(waitParts(12 * 60_000 + 59_000)).toEqual({ hours: 0, minutes: 12 });
      expect(waitParts((65 * 60 + 5) * 1000)).toEqual({ hours: 1, minutes: 5 });
    });
  });
});
