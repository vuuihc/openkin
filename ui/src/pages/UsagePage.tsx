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

export default function UsagePage() {
  const [days, setDays] = useState(30);
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

  const agentTotals = useMemo(() => {
    const m = new Map<
      string,
      { tasks: number; tokens_in: number; tokens_out: number; cost: number }
    >();
    for (const r of rows ?? []) {
      const cur = m.get(r.agent) ?? {
        tasks: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost: 0,
      };
      cur.tasks += r.tasks;
      cur.tokens_in += r.tokens_in;
      cur.tokens_out += r.tokens_out;
      cur.cost += r.cost_usd ?? 0;
      m.set(r.agent, cur);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-50">Usage</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Per-day, per-agent tokens and cost (from task records).
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-400 min-h-[44px]">
          Days
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="min-h-[44px] rounded-lg border border-surface-border bg-surface px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value={7}>7</option>
            <option value={30}>30</option>
            <option value={90}>90</option>
          </select>
        </label>
      </div>

      {error && !rows && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}

      {rows === null && !error && (
        <div className="space-y-4">
          <SlowConnectHint show={slow} />
          <section className="rounded-xl border border-surface-border bg-surface-raised/50 p-4 space-y-3">
            <SkeletonLine className="h-4 w-32" />
            <SkeletonLine className="h-8 w-full" />
            <SkeletonLine className="h-8 w-full" />
          </section>
          <section className="rounded-xl border border-surface-border bg-surface-raised/50 p-4 space-y-3">
            <SkeletonLine className="h-4 w-24" />
            <SkeletonLine className="h-8 w-full" />
            <SkeletonLine className="h-8 w-full" />
            <SkeletonLine className="h-8 w-full" />
          </section>
        </div>
      )}

      {rows && (
        <>
          {error && <p className="text-sm text-red-400">{error}</p>}

          <section className="rounded-xl border border-surface-border bg-surface-raised/50 p-4 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
              Totals by agent
            </h2>
            {agentTotals.length === 0 ? (
              <p className="text-sm text-zinc-500">No tasks in this period.</p>
            ) : (
              <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full min-w-[20rem] text-left text-sm">
                  <thead>
                    <tr className="text-xs text-zinc-500 border-b border-surface-border">
                      <th className="py-2 pr-3 font-medium">Agent</th>
                      <th className="py-2 pr-3 font-medium">Tasks</th>
                      <th className="py-2 pr-3 font-medium">In</th>
                      <th className="py-2 pr-3 font-medium">Out</th>
                      <th className="py-2 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentTotals.map(([agent, t]) => (
                      <tr key={agent} className="border-b border-surface-border/60">
                        <td className="py-2 pr-3 font-mono text-xs text-accent">{agent}</td>
                        <td className="py-2 pr-3 text-zinc-200">{t.tasks}</td>
                        <td className="py-2 pr-3 text-zinc-300">{t.tokens_in}</td>
                        <td className="py-2 pr-3 text-zinc-300">{t.tokens_out}</td>
                        <td className="py-2 text-zinc-200">{formatCost(t.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-surface-border bg-surface-raised/50 p-4 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
              Per day
            </h2>
            {rows.length === 0 ? (
              <p className="text-sm text-zinc-500">No usage rows yet.</p>
            ) : (
              <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full min-w-[24rem] text-left text-sm">
                  <thead>
                    <tr className="text-xs text-zinc-500 border-b border-surface-border">
                      <th className="py-2 pr-3 font-medium">Date</th>
                      <th className="py-2 pr-3 font-medium">Agent</th>
                      <th className="py-2 pr-3 font-medium">Tasks</th>
                      <th className="py-2 pr-3 font-medium">In</th>
                      <th className="py-2 pr-3 font-medium">Out</th>
                      <th className="py-2 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={`${r.date}:${r.agent}`}
                        className="border-b border-surface-border/60"
                      >
                        <td className="py-2 pr-3 font-mono text-xs text-zinc-300">
                          {r.date}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs text-accent">
                          {r.agent}
                        </td>
                        <td className="py-2 pr-3 text-zinc-200">{r.tasks}</td>
                        <td className="py-2 pr-3 text-zinc-300">{r.tokens_in}</td>
                        <td className="py-2 pr-3 text-zinc-300">{r.tokens_out}</td>
                        <td className="py-2 text-zinc-200">{formatCost(r.cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
