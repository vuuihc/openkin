/**
 * The fields the fold reads — declared here, not imported from `../api/client`.
 * That module is the browser client (zustand, fetch state); ADR 0036 §2 lets the
 * RN bundle import this file in place, and the RN typecheck must not walk the web
 * client (`scripts/check.sh`'s mobile-rn job installs mobile-rn's deps only).
 * The web's `UsageRow` and the node's generated schema both satisfy this shape.
 */
export type UsageRowLike = {
  date: string;
  tasks: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd?: number | null;
  request_count: number;
  cache_read_tokens: number;
  cache_eligible_input_tokens: number;
  cache_status: string;
};

export type CacheStatus = "reported" | "unknown" | "unsupported" | "mixed";

export type UsageInterval = {
  cost: number;
  tokens: number;
  tasks: number;
  cacheRead: number;
  cacheEligible: number;
  input: number;
  requests: number;
  /** Cost per day, ascending, for the daily chart. */
  byDay: [string, number][];
  /**
   * The interval produced no rows at all. A quiet interval is not "$0.00 spent"
   * — it is a question with no activity behind it, and the console says "no
   * usage in this range" instead of drawing a zero (KIN-AGENTS-001 step 2).
   */
  empty: boolean;
  cacheStatus: CacheStatus;
};

/**
 * Fold one interval's usage rows into the four headline numbers.
 *
 * Kept beside the other usage arithmetic because the "empty" distinction is a
 * property of the rows, not of the sum: summing an empty list and summing a
 * list whose entries really cost nothing produce the same zero, and only the
 * first is allowed to read as "nothing happened".
 */
export function summarizeUsage(rows: readonly UsageRowLike[] | null | undefined): UsageInterval {
  const list = rows ?? [];
  let cost = 0;
  let tokens = 0;
  let tasks = 0;
  let cacheRead = 0;
  let cacheEligible = 0;
  let input = 0;
  let requests = 0;
  const statuses = new Set<string>();
  const days = new Map<string, number>();
  for (const r of list) {
    cost += r.cost_usd ?? 0;
    tokens += r.tokens_in + r.tokens_out;
    tasks += r.tasks;
    cacheRead += r.cache_read_tokens;
    cacheEligible += r.cache_eligible_input_tokens;
    input += r.tokens_in;
    requests += r.request_count;
    statuses.add(r.cache_status);
    days.set(r.date, (days.get(r.date) ?? 0) + (r.cost_usd ?? 0));
  }
  let cacheStatus: CacheStatus = "unknown";
  if (statuses.size === 1) {
    cacheStatus = cacheState(statuses.values().next().value, null);
  } else if (statuses.size > 1) {
    cacheStatus = "mixed";
  }
  return {
    cost,
    tokens,
    tasks,
    cacheRead,
    cacheEligible,
    input,
    requests,
    byDay: [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    empty: list.length === 0,
    cacheStatus,
  };
}

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
