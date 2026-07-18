export type CacheStatus = "reported" | "unknown" | "unsupported" | "mixed";

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function cacheState(status: CacheStatus | string | null | undefined, rate: number | null): CacheStatus {
  if (status === "reported" || status === "unknown" || status === "unsupported" || status === "mixed") {
    return status;
  }
  return rate == null ? "unknown" : "reported";
}

export function cacheRateLabel(status: CacheStatus | string | null | undefined, rate: number | null): string {
  const state = cacheState(status, rate);
  if (state === "unknown" || state === "unsupported" || rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** Returns a percentage label only when cache coverage is not complete. */
export function cacheCoverageLabel(coverage: number | null | undefined): string | null {
  if (coverage == null || coverage >= 1) return null;
  return `${Math.round(coverage * 100)}%`;
}
