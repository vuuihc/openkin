import { formatCost } from "../api/client";
import { formatTokenCount } from "./usage";

export type LimitStatus = "ok" | "warn" | "over";

export type AgentLimitProgressResult = {
  ratio: number;
  /** Clamped to [0, 100] for CSS width. Status may still be "over" when ratio > 1. */
  barPct: number;
  status: LimitStatus;
};

/**
 * Compute progress ratio and bar width for one metric.
 * Returns null when limit is undefined/null or zero (unlimited — no bar should render).
 */
export function agentLimitProgress(
  used: number,
  limit: number | undefined | null,
): AgentLimitProgressResult | null {
  if (limit == null || limit <= 0) return null;
  const ratio = used / limit;
  const barPct = Math.min(100, Math.round(ratio * 100));
  return { ratio, barPct, status: agentLimitStatus(ratio) };
}

/** Map a usage ratio to its threshold status. */
export function agentLimitStatus(ratio: number): LimitStatus {
  if (ratio >= 1.0) return "over";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

/**
 * Format a used/limit label.
 * - "spend": formats values as USD cost strings.
 * - "tokens": formats values as compact token count strings.
 */
export function formatLimitLabel(
  used: number,
  limit: number,
  kind: "spend" | "tokens",
): string {
  if (kind === "spend") {
    return `${formatCost(used)} / ${formatCost(limit)}`;
  }
  return `${formatTokenCount(used)} / ${formatTokenCount(limit)}`;
}

/**
 * Returns the more severe of two statuses (severity order: ok < warn < over).
 */
export function combinedStatus(a: LimitStatus, b: LimitStatus): LimitStatus {
  const rank: Record<LimitStatus, number> = { ok: 0, warn: 1, over: 2 };
  return rank[a] >= rank[b] ? a : b;
}
