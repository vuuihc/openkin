import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  formatCost,
  getToken,
  getUsageLimits,
  getUsageSummary,
  getUsageWindows,
  listAgentManagement,
  listAgents,
  updateSettings,
  type AgentInfo,
  type AgentLimitStatus,
  type AgentManagement,
  type UsageRow,
  type UsageWindowProvider,
} from "../api/client";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";
import {
  agentCatalogState,
  openInstallURL,
  sortAgentCatalog,
} from "../lib/agentCatalog";
import {
  agentLimitProgress,
  combinedStatus,
  formatLimitLabel,
  type LimitStatus,
} from "../lib/agentLimits";
import {
  cacheRateLabel,
  cacheState,
  formatTokenCount,
  type CacheStatus,
} from "../lib/usage";

/** Maps an agent id to the subscription-window provider that bills it. */
const PROVIDER_BY_AGENT: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  grok: "grok",
};

/**
 * Agents management console with folded-in usage overview.
 */
export default function AgentsPage() {
  const tr = useT();
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [limitStatuses, setLimitStatuses] = useState<AgentLimitStatus[]>([]);
  const [windows, setWindows] = useState<UsageWindowProvider[]>([]);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [mgmt, setMgmt] = useState<AgentManagement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const pushToast = useAppStore((s) => s.pushToast);
  const slow = useSlowHint((rows === null || agents === null) && !error);

  const load = useCallback(async (refresh = false) => {
    if (!getToken()) return;
    setError(null);
    try {
      const [data, limits, win, agentList, management] = await Promise.all([
        getUsageSummary(days),
        getUsageLimits().catch(() => [] as AgentLimitStatus[]),
        getUsageWindows().catch(() => [] as UsageWindowProvider[]),
        listAgents(),
        listAgentManagement(refresh).catch(() => [] as AgentManagement[]),
      ]);
      setRows(data);
      setLimitStatuses(limits);
      setWindows(win);
      setAgents(agentList);
      setMgmt(management);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [days]);

  useEffect(() => {
    setRows(null);
    setAgents(null);
    void load(false);
  }, [load]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void load(false);
  }, [reconnectGen, load]);

  const mgmtById = useMemo(() => {
    const m = new Map<string, AgentManagement>();
    for (const row of mgmt) m.set(row.id, row);
    return m;
  }, [mgmt]);

  const catalog = useMemo(() => sortAgentCatalog(agents ?? []), [agents]);

  const usageByAgent = useMemo(() => {
    const m = new Map<
      string,
      {
        tasks: number;
        cost: number;
        tokens: number;
        cacheRead: number;
        cacheEligible: number;
        input: number;
        output: number;
        requests: number;
        reasoning: number;
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
        output: 0,
        requests: 0,
        reasoning: 0,
        statuses: new Set<string>(),
      };
      cur.tasks += r.tasks;
      cur.cost += r.cost_usd ?? 0;
      cur.tokens += r.tokens_in + r.tokens_out;
      cur.cacheRead += r.cache_read_tokens;
      cur.cacheEligible += r.cache_eligible_input_tokens;
      cur.input += r.tokens_in;
      cur.output += r.tokens_out;
      cur.requests += r.request_count;
      cur.reasoning += r.reasoning_output_tokens;
      cur.statuses.add(r.cache_status);
      m.set(r.agent, cur);
    }
    return m;
  }, [rows]);

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

  // Subscription windows are keyed by provider; map them onto their agent id
  // so each agent row can show its own 5h/weekly quota inline.
  const windowsByAgent = useMemo(() => {
    const byProvider = new Map<string, UsageWindowProvider>();
    for (const p of windows) byProvider.set(p.provider, p);
    const m = new Map<string, UsageWindowProvider>();
    for (const [agentId, provider] of Object.entries(PROVIDER_BY_AGENT)) {
      const p = byProvider.get(provider);
      if (p) m.set(agentId, p);
    }
    return m;
  }, [windows]);


  async function onRecheck() {
    setRechecking(true);
    try {
      await load(true);
    } finally {
      setRechecking(false);
    }
  }

  async function onSetDefault(id: string) {
    try {
      await updateSettings({ "agent.default": id });
      pushToast(tr("agents.defaultUpdated"), "info");
      await load(false);
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : String(e), "error");
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      pushToast(tr("agents.copied"), "info");
    } catch {
      pushToast(tr("agents.copyFailed"), "error");
    }
  }

  function statusLabel(a: AgentInfo): string {
    switch (agentCatalogState(a)) {
      case "native":
      case "generic":
        return tr("agents.installedVerified");
      case "verifying":
        return tr("agentCatalog.verifying");
      case "not_installed":
        return tr("agentCatalog.notInstalled");
      default:
        return tr("agentCatalog.unavailable");
    }
  }

  function authLabel(status: string | undefined): string {
    switch (status) {
      case "signed_in":
        return tr("agents.authSignedIn");
      case "not_signed_in":
        return tr("agents.authNotSignedIn");
      default:
        return tr("agents.authUnknown");
    }
  }

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="max-w-[720px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight">{tr("agents.title")}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="kin-btn-secondary min-h-[40px] px-3 text-[13px]"
              disabled={rechecking}
              onClick={() => void onRecheck()}
            >
              {rechecking ? tr("common.loading") : tr("agents.recheckAll")}
            </button>
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
        </div>

        {(rows === null || agents === null) && !error && (
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
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: tr("usage.spend"), value: formatCost(totals.cost) },
                { label: tr("usage.tokens"), value: formatTokenCount(totals.tokens) },
                {
                  label: tr("usage.cacheHitRate"),
                  value: cacheRateLabel(
                    totals.status,
                    totals.cacheEligible > 0 ? totals.cacheRead / totals.cacheEligible : null,
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

            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted mb-3">
                {tr("usage.dailySpend")}
              </div>
              <div className="flex items-stretch gap-1.5 h-28">
                {byDay.length === 0 && (
                  <p className="text-sm text-kin-muted">{tr("usage.noData")}</p>
                )}
                {byDay.map(([date, cost]) => (
                  <div key={date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                    {/* Bar track: definite height so the bar's % resolves against it. */}
                    <div className="flex-1 w-full flex items-end justify-center min-h-0">
                      <div
                        className="w-full max-w-[28px] rounded-t bg-kin-blue/80"
                        style={{ height: `${Math.max(2, (cost / maxDay) * 100)}%` }}
                        title={`${date}: ${formatCost(cost)}`}
                      />
                    </div>
                    <span className="text-[10px] text-kin-muted truncate w-full text-center">
                      {date.slice(5)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {agents !== null && (
          <div className="mt-6 rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated overflow-hidden">
            <div className="divide-y divide-[var(--kin-hairline)]">
              {catalog.map((a) => {
                const state = agentCatalogState(a);
                const m = mgmtById.get(a.id);
                const usage = usageByAgent.get(a.id);
                const agentWindow = windowsByAgent.get(a.id);
                const limitStatus = limitsByAgent.get(a.id);
                const spendProgress =
                  limitStatus?.limit_spend_usd != null
                    ? agentLimitProgress(limitStatus.used_spend_usd, limitStatus.limit_spend_usd)
                    : null;
                const tokensProgress =
                  limitStatus?.limit_tokens != null
                    ? agentLimitProgress(limitStatus.used_tokens, limitStatus.limit_tokens)
                    : null;
                const limitColor: LimitStatus =
                  spendProgress && tokensProgress
                    ? combinedStatus(spendProgress.status, tokensProgress.status)
                    : spendProgress?.status ?? tokensProgress?.status ?? "ok";
                const limitColorClass =
                  limitColor === "over"
                    ? "text-[var(--kin-red,#ff453a)]"
                    : limitColor === "warn"
                      ? "text-[var(--kin-yellow,#ffd60a)]"
                      : "text-kin-muted";
                const barBgClass =
                  limitColor === "over"
                    ? "bg-[var(--kin-red,#ff453a)]"
                    : limitColor === "warn"
                      ? "bg-[var(--kin-yellow,#ffd60a)]"
                      : "bg-kin-blue/70";
                const kindBadge =
                  state === "native"
                    ? tr("agentCatalog.native")
                    : state === "generic"
                      ? tr("agentCatalog.generic")
                      : null;
                return (
                  <div
                    key={a.id}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-[14px]">{a.name}</span>
                        {kindBadge ? (
                          <span className="rounded-full border border-[var(--kin-hairline)] px-1.5 py-0.5 text-[10px] text-kin-muted">
                            {kindBadge}
                          </span>
                        ) : null}
                        {a.default ? (
                          <span className="rounded-full bg-kin-blue-soft px-1.5 py-0.5 text-[10px] font-medium text-kin-blue">
                            {tr("agents.isDefault")}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-kin-secondary">
                        <span title={a.reason || undefined}>{statusLabel(a)}</span>
                        <span>
                          {tr("agents.version")}: {m?.version || "—"}
                        </span>
                        <span title={tr("agents.authHint")}>{authLabel(m?.auth_status)}</span>
                      </div>
                      {usage ? (
                        <div className="flex flex-col gap-0.5 text-[12px] text-kin-secondary">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="tabular-nums font-medium text-kin-text">
                              {formatCost(usage.cost)}
                            </span>
                            <span className="tabular-nums">
                              {tr("usage.taskCount", { count: usage.tasks })}
                            </span>
                            <span className="tabular-nums">{formatTokenCount(usage.tokens)}</span>
                          </div>
                          {usage.tasks > 0 ? (
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-kin-muted">
                              <EffStat
                                value={formatCost(usage.cost / usage.tasks)}
                                label={tr("agents.effCostPerTask")}
                              />
                              <EffStat
                                value={formatTokenCount(usage.tokens / usage.tasks)}
                                label={tr("agents.effTokensPerTask")}
                              />
                              <EffStat
                                value={pct(
                                  usage.cacheEligible > 0
                                    ? usage.cacheRead / usage.cacheEligible
                                    : null,
                                )}
                                label={tr("agents.effCache")}
                              />
                              <EffStat
                                value={(usage.requests / usage.tasks).toFixed(1)}
                                label={tr("agents.effReqPerTask")}
                              />
                              <EffStat
                                value={pct(usage.tokens > 0 ? usage.output / usage.tokens : null)}
                                label={tr("agents.effOutputShare")}
                              />
                              <EffStat
                                value={pct(usage.output > 0 ? usage.reasoning / usage.output : null)}
                                label={tr("agents.effReasoning")}
                              />
                            </div>
                          ) : null}
                          {spendProgress && limitStatus?.limit_spend_usd != null && (
                            <span className={`flex items-center gap-1.5 text-[11px] ${limitColorClass}`}>
                              <span className="w-24 h-1.5 rounded-full bg-[var(--kin-fill)] overflow-hidden shrink-0">
                                <span
                                  className={`block h-full rounded-full ${barBgClass}`}
                                  style={{ width: `${spendProgress.barPct}%` }}
                                />
                              </span>
                              {formatLimitLabel(
                                limitStatus.used_spend_usd,
                                limitStatus.limit_spend_usd,
                                "spend",
                              )}
                            </span>
                          )}
                          {tokensProgress && limitStatus?.limit_tokens != null && (
                            <span className={`flex items-center gap-1.5 text-[11px] ${limitColorClass}`}>
                              <span className="w-24 h-1.5 rounded-full bg-[var(--kin-fill)] overflow-hidden shrink-0">
                                <span
                                  className={`block h-full rounded-full ${barBgClass}`}
                                  style={{ width: `${tokensProgress.barPct}%` }}
                                />
                              </span>
                              {formatLimitLabel(
                                limitStatus.used_tokens,
                                limitStatus.limit_tokens,
                                "tokens",
                              )}
                            </span>
                          )}
                        </div>
                      ) : null}
                      {agentWindow?.error ? (
                        <div className="text-[11px] text-kin-muted">{agentWindow.error}</div>
                      ) : agentWindow && agentWindow.windows.length > 0 ? (
                        <div className="flex flex-col gap-1 text-[11px] text-kin-secondary">
                          {agentWindow.plan ? (
                            <span className="text-[10px] uppercase tracking-wide text-kin-muted">
                              {tr("usage.windowsTitle")} · {agentWindow.plan}
                            </span>
                          ) : null}
                          {agentWindow.windows.map((w) => {
                            const pct = Math.min(100, Math.max(0, w.used_percent));
                            const barClass =
                              w.status === "over"
                                ? "bg-[var(--kin-red,#ff453a)]"
                                : w.status === "warn"
                                  ? "bg-[var(--kin-yellow,#ffd60a)]"
                                  : "bg-kin-blue/70";
                            return (
                              <span key={w.kind} className="flex items-center gap-1.5">
                                <span className="w-10 shrink-0 text-kin-muted">
                                  {w.kind === "5h"
                                    ? tr("usage.window5h")
                                    : tr("usage.windowWeekly")}
                                </span>
                                <span className="w-24 h-1.5 rounded-full bg-[var(--kin-fill)] overflow-hidden shrink-0">
                                  <span
                                    className={`block h-full rounded-full ${barClass}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </span>
                                <span className="tabular-nums">{Math.round(w.used_percent)}%</span>
                                {w.reset_at > 0 ? (
                                  <span className="text-[10px] text-kin-muted">
                                    · {tr("usage.windowResets", { time: formatResetIn(w.reset_at) })}
                                  </span>
                                ) : null}
                              </span>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {a.available && !a.default ? (
                        <button
                          type="button"
                          className="text-[12px] text-kin-blue hover:underline"
                          onClick={() => void onSetDefault(a.id)}
                        >
                          {tr("agents.setDefault")}
                        </button>
                      ) : null}
                      {!a.installed && a.install_url ? (
                        <button
                          type="button"
                          className="text-[12px] text-kin-blue hover:underline"
                          title={tr("agentCatalog.installHint")}
                          onClick={() => openInstallURL(a.install_url)}
                        >
                          {tr("agentCatalog.install")}
                        </button>
                      ) : null}
                      {m?.install_cmd ? (
                        <button
                          type="button"
                          className="text-[12px] text-kin-secondary hover:underline"
                          onClick={() => void copyText(m.install_cmd!)}
                        >
                          {tr("agents.copyInstall")}
                        </button>
                      ) : null}
                      {m?.update_cmd && a.installed ? (
                        <button
                          type="button"
                          className="text-[12px] text-kin-secondary hover:underline"
                          onClick={() => void copyText(m.update_cmd!)}
                        >
                          {tr("agents.copyUpdate")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {catalog.length === 0 && (
                <p className="px-4 py-6 text-sm text-kin-muted">{tr("usage.noAgentUsage")}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One compact "value label" efficiency stat in an agent row. */
function EffStat({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="tabular-nums font-medium text-kin-secondary">{value}</span>
      {label}
    </span>
  );
}

/** Format a 0..1 ratio as a rounded percent, or "—" when not available. */
function pct(x: number | null): string {
  if (x == null || Number.isNaN(x)) return "—";
  return `${Math.round(x * 100)}%`;
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
