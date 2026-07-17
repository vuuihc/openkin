import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  formatCost,
  getToken,
  getUsageSummary,
  type UsageRow,
} from "../api/client";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";

/**
 * Usage / cost page (design 3b).
 */
export default function UsagePage() {
  const tr = useT();
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const slow = useSlowHint(rows === null && !error);

  const load = useCallback(async () => {
    if (!getToken()) return;
    setError(null);
    try {
      const data = await getUsageSummary(days);
      setRows(data);
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
    for (const r of rows ?? []) {
      cost += r.cost_usd ?? 0;
      tokens += r.tokens_in + r.tokens_out;
      tasks += r.tasks;
    }
    return { cost, tokens, tasks };
  }, [rows]);

  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) {
      m.set(r.date, (m.get(r.date) ?? 0) + (r.cost_usd ?? 0));
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const maxDay = Math.max(0.001, ...byDay.map(([, c]) => c));

  const agentTotals = useMemo(() => {
    const m = new Map<string, { tasks: number; cost: number; tokens: number }>();
    for (const r of rows ?? []) {
      const cur = m.get(r.agent) ?? { tasks: 0, cost: 0, tokens: 0 };
      cur.tasks += r.tasks;
      cur.cost += r.cost_usd ?? 0;
      cur.tokens += r.tokens_in + r.tokens_out;
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
            <option value={7}>This week</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
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
            <div className="mt-6 grid grid-cols-3 gap-3">
              {[
                { label: "Spend", value: formatCost(totals.cost) },
                {
                  label: "Tokens",
                  value:
                    totals.tokens >= 1_000_000
                      ? `${(totals.tokens / 1_000_000).toFixed(2)}M`
                      : totals.tokens >= 1000
                        ? `${(totals.tokens / 1000).toFixed(1)}k`
                        : String(totals.tokens),
                },
                { label: tr("nav.tasks"), value: String(totals.tasks) },
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

            <div className="mt-8">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted mb-3">
                Daily spend
              </div>
              <div className="flex items-end gap-1.5 h-28">
                {byDay.length === 0 && (
                  <p className="text-sm text-kin-muted">No data for this range.</p>
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
                By agent
              </div>
              <div className="rounded-xl border border-[var(--kin-hairline)] overflow-hidden">
                {agentTotals.map(([agent, v]) => (
                  <div
                    key={agent}
                    className="flex items-center gap-3 px-4 py-3 border-b border-[var(--kin-hairline)] last:border-0"
                  >
                    <span className="font-medium flex-1">{agent}</span>
                    <span className="text-kin-secondary text-[12.5px] tabular-nums">
                      {v.tasks} tasks
                    </span>
                    <span className="font-semibold tabular-nums w-20 text-right">
                      {formatCost(v.cost)}
                    </span>
                  </div>
                ))}
                {agentTotals.length === 0 && (
                  <p className="px-4 py-6 text-sm text-kin-muted">No agent usage yet.</p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
