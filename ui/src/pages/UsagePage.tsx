import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  formatCost,
  getToken,
  getUsageLimits,
  getUsageSummary,
  getUsageWindows,
  type AgentLimitStatus,
  type UsageRow,
  type UsageWindowProvider,
} from "../api/client";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";
import {
  agentLimitProgress,
  combinedStatus,
  formatLimitLabel,
  type LimitStatus,
} from "../lib/agentLimits";
import {
  cacheCoverageLabel,
  cacheRateLabel,
  cacheState,
  formatTokenCount,
  type CacheStatus,
} from "../lib/usage";

/**
 * Usage / cost page (design 3b).
 */
export default function UsagePage() {
  const tr = useT();
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [limitStatuses, setLimitStatuses] = useState<AgentLimitStatus[]>([]);
  const [windows, setWindows] = useState<UsageWindowProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const slow = useSlowHint(rows === null && !error);

  const load = useCallback(async () => {
    if (!getToken()) return;
    setError(null);
    try {
      const [data, limits, win] = await Promise.all([
        getUsageSummary(days),
        getUsageLimits().catch(() => [] as AgentLimitStatus[]),
        getUsageWindows().catch(() => [] as UsageWindowProvider[]),
      ]);
      setRows(data);
      setLimitStatuses(limits);
      setWindows(win);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [days]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void load();
  }, [reconnectGen, load]);

  const totals = useMemo(() => {
    let cost = 0;
    let tokens = 0;
    let tasks = 0;
    let cacheRead = 0;
    let cacheEligible = 0;
    let input = 0;
    const statuses = new Set<string>();
    for (const r of rows ?? []) {
      cost += r.cost_usd ?? 0;
      tokens += r.tokens_in + r.tokens_out;
      tasks += r.tasks;
      cacheRead += r.cache_read_tokens;
      cacheEligible += r.cache_eligible_input_tokens;
      input += r.tokens_in;
      statuses.add(r.cache_status);
    }
    const status = aggregateCacheStatus(statuses);
    return { cost, tokens, tasks, cacheRead, cacheEligible, input, status };
  }, [rows]);

  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) {
      m.set(r.date, (m.get(r.date) ?? 0) + (r.cost_usd ?? 0));
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const maxDay = Math.max(0.001, ...byDay.map(([, c]) => c));

  // Key limit statuses by agent for O(1) lookup during rendering.
  const limitsByAgent = useMemo(() => {
    const m = new Map<string, AgentLimitStatus>();
    for (const s of limitStatuses) {
      m.set(s.agent, s);
    }
    return m;
  }, [limitStatuses]);

  const agentTotals = useMemo(() => {
    const m = new Map<
      string,
      {
        tasks: number;
        cost: number;
        tokens: number;
        cacheRead: number;
        cacheEligible: number;
        input: number;
        statuses: Set<string>;
      }
    >();
    for (const r of rows ?? []) {
      const cur = m.get(r.agent) ?? {
        tasks: 0,
        cost: 0,
        tokens: 0,
        cacheRead: 0,
        cacheEligible: 0,
        input: 0,
        statuses: new Set<string>(),
      };
      cur.tasks += r.tasks;
      cur.cost += r.cost_usd ?? 0;
      cur.tokens += r.tokens_in + r.tokens_out;
      cur.cacheRead += r.cache_read_tokens;
      cur.cacheEligible += r.cache_eligible_input_tokens;
      cur.input += r.tokens_in;
      cur.statuses.add(r.cache_status);
      m.set(r.agent, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost);
  }, [rows]);

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="max-w-[720px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight">{tr("usage.title")}</h1>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="kin-input w-auto min-h-[40px]"
          >
            <option value={7}>{tr("usage.thisWeek")}</option>
            <option value={30}>{tr("usage.days30")}</option>
            <option value={90}>{tr("usage.days90")}</option>
          </select>
        </div>

        {rows === null && !error && (
          <div className="mt-6 space-y-3">
            <SlowConnectHint show={slow} />
            <SkeletonLine className="h-24 w-full rounded-xl" />
          </div>
        )}

        {error && (
          <div
            className="mt-6 rounded-xl border border-kin-red/40 bg-[rgba(255,69,58,.08)] px-4 py-3 text-sm text-[#ff8a80]"
            role="alert"
          >
            {error}
          </div>
        )}

        {rows && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: tr("usage.spend"), value: formatCost(totals.cost) },
                { label: tr("usage.tokens"), value: formatTokenCount(totals.tokens) },
                {
                  label: tr("usage.cacheHitRate"),
                  value: cacheRateLabel(
                    totals.status,
                    totals.cacheEligible > 0
                      ? totals.cacheRead / totals.cacheEligible
                      : null,
                  ),
                },
                { label: tr("usage.tasks"), value: String(totals.tasks) },
              ].map((c) => (
                <div
                  key={c.label}
                  className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated px-4 py-3"
                >
                  <div className="text-[11px] text-kin-muted font-semibold uppercase tracking-wide">
                    {c.label}
                  </div>
                  <div className="mt-1 text-[22px] font-semibold tabular-nums tracking-tight">
                    {c.value}
                  </div>
                </div>
              ))}
            </div>

            {windows.length > 0 && (
              <div className="mt-8">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted mb-3">
                  {tr("usage.windowsTitle")}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {windows.map((p) => (
                    <div
                      key={p.provider}
                      className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated px-4 py-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold capitalize">{p.provider}</span>
                        {p.plan && (
                          <span className="text-[11px] text-kin-muted uppercase tracking-wide">
                            {p.plan}
                          </span>
                        )}
                      </div>
                      {p.error ? (
                        <p className="mt-2 text-[12px] text-kin-muted">{p.error}</p>
                      ) : (
                        <div className="mt-2 space-y-2">
                          {p.windows.map((w) => {
                            const pct = Math.min(100, Math.max(0, w.used_percent));
                            const barClass =
                              w.status === "over"
                                ? "bg-[var(--kin-red,#ff453a)]"
                                : w.status === "warn"
                                  ? "bg-[var(--kin-yellow,#ffd60a)]"
                                  : "bg-kin-blue/80";
                            const textClass =
                              w.status === "over"
                                ? "text-[var(--kin-red,#ff453a)]"
                                : w.status === "warn"
                                  ? "text-[var(--kin-yellow,#ffd60a)]"
                                  : "text-kin-muted";
                            return (
                              <div key={w.kind}>
                                <div className="flex items-center justify-between text-[12px]">
                                  <span className="text-kin-secondary">
                                    {w.kind === "5h"
                                      ? tr("usage.window5h")
                                      : tr("usage.windowWeekly")}
                                  </span>
                                  <span className={`tabular-nums ${textClass}`}>
                                    {Math.round(w.used_percent)}%
                                  </span>
                                </div>
                                <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-[var(--kin-hairline)]">
                                  <span
                                    className={`block h-full rounded-full ${barClass}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </span>
                                {w.reset_at > 0 && (
                                  <span className="mt-0.5 block text-[10px] text-kin-muted">
                                    {tr("usage.windowResets", {
                                      time: formatResetIn(w.reset_at),
                                    })}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-8">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted mb-3">
                {tr("usage.dailySpend")}
              </div>
              <div className="flex items-end gap-1.5 h-28">
                {byDay.length === 0 && (
                  <p className="text-sm text-kin-muted">{tr("usage.noData")}</p>
                )}
                {byDay.map(([date, cost]) => (
                  <div key={date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                    <div
                      className="w-full max-w-[28px] rounded-t bg-kin-blue/80"
                      style={{ height: `${Math.max(4, (cost / maxDay) * 100)}%` }}
                      title={`${date}: ${formatCost(cost)}`}
                    />
                    <span className="text-[10px] text-kin-muted truncate w-full text-center">
                      {date.slice(5)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-8">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted mb-3">
                {tr("usage.byAgent")}
              </div>
              <div className="rounded-xl border border-[var(--kin-hairline)] overflow-hidden">
                {agentTotals.map(([agent, v]) => {
                  const status = aggregateCacheStatus(v.statuses);
                  const rate = v.cacheEligible > 0 ? v.cacheRead / v.cacheEligible : null;
                  const coverage = cacheCoverageLabel(v.input > 0 ? v.cacheEligible / v.input : null);
                  const cacheDescription =
                    status === "unknown"
                      ? tr("usage.cacheUnknownShort")
                      : status === "unsupported"
                        ? tr("usage.cacheUnsupportedShort")
                        : `${tr("usage.perAgentCache", {
                            rate: cacheRateLabel(status, rate),
                            tokens: formatTokenCount(v.cacheRead),
                          })}${coverage ? ` · ${tr("usage.coverage", { coverage })}` : ""}`;
                  const limitStatus = limitsByAgent.get(agent);
                  const spendProgress = limitStatus
                    ? agentLimitProgress(limitStatus.used_spend_usd, limitStatus.limit_spend_usd ?? undefined)
                    : null;
                  const tokensProgress = limitStatus
                    ? agentLimitProgress(limitStatus.used_tokens, limitStatus.limit_tokens ?? undefined)
                    : null;
                  const rowLimitStatus: LimitStatus | null =
                    spendProgress || tokensProgress
                      ? combinedStatus(
                          spendProgress?.status ?? "ok",
                          tokensProgress?.status ?? "ok",
                        )
                      : null;
                  const limitColorClass =
                    rowLimitStatus === "over"
                      ? "text-[var(--kin-red,#ff453a)]"
                      : rowLimitStatus === "warn"
                        ? "text-[var(--kin-yellow,#ffd60a)]"
                        : "text-kin-muted";
                  const barBgClass =
                    rowLimitStatus === "over"
                      ? "bg-[var(--kin-red,#ff453a)]"
                      : rowLimitStatus === "warn"
                        ? "bg-[var(--kin-yellow,#ffd60a)]"
                        : "bg-kin-blue";
                  return (
                    <div
                      key={agent}
                      className="flex items-center gap-3 border-b border-[var(--kin-hairline)] px-4 py-3 last:border-0"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{agent}</span>
                        <span className="block truncate text-[11px] text-kin-muted">
                          {cacheDescription}
                        </span>
                        {spendProgress && limitStatus?.limit_spend_usd != null && (
                          <span className={`mt-1 flex items-center gap-1.5 text-[11px] ${limitColorClass}`}>
                            <span className="w-24 h-1.5 rounded-full bg-[var(--kin-fill)] overflow-hidden shrink-0">
                              <span
                                className={`block h-full rounded-full ${barBgClass}`}
                                style={{ width: `${spendProgress.barPct}%` }}
                              />
                            </span>
                            {formatLimitLabel(limitStatus.used_spend_usd, limitStatus.limit_spend_usd, "spend")}
                          </span>
                        )}
                        {tokensProgress && limitStatus?.limit_tokens != null && (
                          <span className={`mt-0.5 flex items-center gap-1.5 text-[11px] ${limitColorClass}`}>
                            <span className="w-24 h-1.5 rounded-full bg-[var(--kin-fill)] overflow-hidden shrink-0">
                              <span
                                className={`block h-full rounded-full ${barBgClass}`}
                                style={{ width: `${tokensProgress.barPct}%` }}
                              />
                            </span>
                            {formatLimitLabel(limitStatus.used_tokens, limitStatus.limit_tokens, "tokens")}
                          </span>
                        )}
                      </span>
                      <span className="text-kin-secondary text-[12.5px] tabular-nums">
                        {tr("usage.taskCount", { count: v.tasks })}
                      </span>
                      <span className="w-20 text-right font-semibold tabular-nums">
                        {formatCost(v.cost)}
                      </span>
                    </div>
                  );
                })}
                {agentTotals.length === 0 && (
                  <p className="px-4 py-6 text-sm text-kin-muted">{tr("usage.noAgentUsage")}</p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function aggregateCacheStatus(statuses: Set<string>): CacheStatus {
  if (statuses.size === 0) return "unknown";
  if (statuses.size > 1) return "mixed";
  return cacheState(statuses.values().next().value, null);
}

/** formatResetIn renders a unix-seconds reset time as a coarse countdown. */
function formatResetIn(resetAtSeconds: number): string {
  const secs = resetAtSeconds - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "0m";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
