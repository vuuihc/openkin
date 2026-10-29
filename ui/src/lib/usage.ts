export type CacheStatus = "reported" | "unknown" | "unsupported" | "mixed";

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function cacheState(
  status: CacheStatus | string | null | undefined,
  rate: number | null,
): CacheStatus {
  if (
    status === "reported" ||
    status === "unknown" ||
    status === "unsupported" ||
    status === "mixed"
  ) {
    return status;
  }
  return rate == null ? "unknown" : "reported";
}

export function cacheRateLabel(
  status: CacheStatus | string | null | undefined,
  rate: number | null,
): string {
  const state = cacheState(status, rate);
  if (state === "unknown" || state === "unsupported" || rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** Returns a percentage label only when cache coverage is not complete. */
export function cacheCoverageLabel(coverage: number | null | undefined): string | null {
  if (coverage == null || coverage >= 1) return null;
  return `${Math.round(coverage * 100)}%`;
}

export type CostSource = "provider" | "price_table" | "unknown" | string;

/** Dominant cost source for a task (by spend, then request count). */
export function primaryCostSource(
  subtotals:
    { cost_source: string; cost_usd?: number | null; request_count?: number }[] | null | undefined,
): CostSource | null {
  if (!subtotals?.length) return null;
  let best = subtotals[0];
  for (const row of subtotals.slice(1)) {
    const bestCost = best.cost_usd ?? 0;
    const rowCost = row.cost_usd ?? 0;
    if (rowCost > bestCost) {
      best = row;
      continue;
    }
    if (rowCost === bestCost && (row.request_count ?? 0) > (best.request_count ?? 0)) {
      best = row;
    }
  }
  return best.cost_source || null;
}

/** i18n key under usage.* for a cost source badge, or null when not shown. */
export function costSourceLabelKey(source: CostSource | null | undefined): string | null {
  if (source === "price_table") return "costEstimated";
  if (source === "provider") return "costProvider";
  return null;
}

export type ContextFill = {
  /** The last request's input tokens. */
  tokens: number;
  /** The model's maximum input tokens. */
  window: number;
  /** Fraction of the window used, clamped to 1 so it can size a bar. */
  ratio: number;
  /** Unclamped percentage: a request that already overflows reads over 100. */
  percent: number;
  level: "ok" | "warn" | "full";
};

/**
 * Where the meter changes meaning: room left, nearly full, full.
 *
 * Thresholds are on the percentage, not the fraction, so the number on screen
 * and the colour beside it can never disagree — 159,999 of 200,000 draws "80%",
 * and 80% is the line.
 */
export const CONTEXT_WARN_PERCENT = 80;
export const CONTEXT_FULL_PERCENT = 95;

/**
 * How full the context window is, or null when the answer is not knowable.
 *
 * Null covers both halves of "not knowable": no request has reported an input
 * count yet (a task with no completed turn) and a model whose window the price
 * table does not carry. Drawing a denominator-free bar in either case would
 * make an unknown look like an empty window.
 */
export function contextFill(
  context: { tokens?: number | null } | null | undefined,
  window: number | null | undefined,
): ContextFill | null {
  const tokens = context?.tokens ?? 0;
  const total = window ?? 0;
  if (!(tokens > 0) || !(total > 0)) return null;
  const exact = tokens / total;
  const percent = Math.round(exact * 100);
  const level =
    percent >= CONTEXT_FULL_PERCENT ? "full" : percent >= CONTEXT_WARN_PERCENT ? "warn" : "ok";
  return {
    tokens,
    window: total,
    ratio: Math.min(1, exact),
    percent,
    level,
  };
}
