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
export function formatLimitLabel(used: number, limit: number, kind: "spend" | "tokens"): string {
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

/** The parts of a limit row a waiting label needs. */
export type QuotaLimitLike = {
  status: string;
  period_start: string;
};

export type QuotaWait = {
  waiting: boolean;
  /** Watched time, or null when this console has no first sighting to count from. */
  elapsedMs: number | null;
  /** When the daily period turns over, as an epoch millisecond, if it parses. */
  recoveryAt: number | null;
};

/**
 * What "waiting on the daily limit" can honestly say.
 *
 * `status: "over"` means today's limit is spent. The API reports the start of
 * the day, not the moment the limit was crossed, so the elapsed half comes from
 * the console's first sighting (persisted by `agentPageState`), not from a
 * server timestamp it does not have. Recovery is the next turn of the daily
 * period: the limit row's own start plus one local day. A console in a
 * different timezone than the machine formats its own midnight; the machine's
 * day is the one the limit was computed against, and the row carries no zone of
 * its own beyond the offset in `period_start`.
 */
export function quotaWait(
  limit: QuotaLimitLike | null | undefined,
  firstSeenAt: number | null,
  now: number,
): QuotaWait {
  if (!limit || limit.status !== "over") {
    return { waiting: false, elapsedMs: null, recoveryAt: null };
  }
  const elapsedMs =
    firstSeenAt != null && Number.isFinite(firstSeenAt) ? Math.max(0, now - firstSeenAt) : null;
  return { waiting: true, elapsedMs, recoveryAt: nextPeriodStart(limit.period_start) };
}

function nextPeriodStart(periodStart: string): number | null {
  const start = Date.parse(periodStart);
  if (!Number.isFinite(start)) return null;
  // The period is daily and `period_start` is the instant the current day
  // began on the daemon's clock. Recovery is one day later as an instant;
  // re-midnighting in the console's zone would move the answer by the offset
  // between the two clocks.
  return start + 24 * 60 * 60 * 1000;
}

/** Whole hours and minutes in a watched duration, for the caller's own wording. */
export function waitParts(ms: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.floor(ms / 60_000));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
