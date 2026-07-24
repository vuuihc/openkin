import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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


  type AgentSortKey =
    | "name"
    | "status"
    | "version"
    | "auth"
    | "cost"
    | "tokens"
    | "tasks"
    | "cache"
    | "costPerTask"
    | "tokensPerTask";

  const [sortKey, setSortKey] = useState<AgentSortKey>("cost");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleSort(key: AgentSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    const numeric: AgentSortKey[] = [
      "cost",
      "tokens",
      "tasks",
      "cache",
      "costPerTask",
      "tokensPerTask",
    ];
    setSortKey(key);
    setSortDir(numeric.includes(key) ? "desc" : "asc");
  }

  const sortedCatalog = useMemo(() => {
    const statusRank = (a: AgentInfo) => {
      switch (agentCatalogState(a)) {
        case "native":
          return 0;
        case "generic":
          return 1;
        case "verifying":
          return 2;
        case "unavailable":
          return 3;
        default:
          return 4;
      }
    };
    const authRank = (status: string | undefined) => {
      switch (status) {
        case "signed_in":
          return 0;
        case "not_signed_in":
          return 1;
        default:
          return 2;
      }
    };
    const list = [...catalog];
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const ua = usageByAgent.get(a.id);
      const ub = usageByAgent.get(b.id);
      const ma = mgmtById.get(a.id);
      const mb = mgmtById.get(b.id);
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "status":
          cmp = statusRank(a) - statusRank(b);
          if (cmp === 0) cmp = a.name.localeCompare(b.name);
          break;
        case "version":
          cmp = (ma?.version || "").localeCompare(mb?.version || "");
          if (cmp === 0) cmp = a.name.localeCompare(b.name);
          break;
        case "auth":
          cmp = authRank(ma?.auth_status) - authRank(mb?.auth_status);
          if (cmp === 0) cmp = a.name.localeCompare(b.name);
          break;
        case "cost":
          cmp = (ua?.cost ?? 0) - (ub?.cost ?? 0);
          break;
        case "tokens":
          cmp = (ua?.tokens ?? 0) - (ub?.tokens ?? 0);
          break;
        case "tasks":
          cmp = (ua?.tasks ?? 0) - (ub?.tasks ?? 0);
          break;
        case "cache": {
          const ca =
            ua && ua.cacheEligible > 0 ? ua.cacheRead / ua.cacheEligible : -1;
          const cb =
            ub && ub.cacheEligible > 0 ? ub.cacheRead / ub.cacheEligible : -1;
          cmp = ca - cb;
          break;
        }
        case "costPerTask": {
          const ca = ua && ua.tasks > 0 ? ua.cost / ua.tasks : -1;
          const cb = ub && ub.tasks > 0 ? ub.cost / ub.tasks : -1;
          cmp = ca - cb;
          break;
        }
        case "tokensPerTask": {
          const ca = ua && ua.tasks > 0 ? ua.tokens / ua.tasks : -1;
          const cb = ub && ub.tasks > 0 ? ub.tokens / ub.tasks : -1;
          cmp = ca - cb;
          break;
        }
      }
      if (cmp !== 0) return cmp * dir;
      const costCmp = (ub?.cost ?? 0) - (ua?.cost ?? 0);
      if (costCmp !== 0) return costCmp;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [catalog, sortKey, sortDir, usageByAgent, mgmtById]);

  function sortIndicator(key: AgentSortKey): string {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  function SortTh({
    colKey,
    children,
    className = "",
    align = "left",
  }: {
    colKey: AgentSortKey;
    children: ReactNode;
    className?: string;
    align?: "left" | "right";
  }) {
    const active = sortKey === colKey;
    return (
      <th
        className={`px-3 py-2.5 font-semibold whitespace-nowrap ${
          align === "right" ? "text-right" : "text-left"
        } ${className}`}
      >
        <button
          type="button"
          onClick={() => toggleSort(colKey)}
          className={`inline-flex items-center gap-0.5 hover:text-kin-text ${
            active ? "text-kin-text" : "text-kin-muted"
          }`}
        >
          {children}
          <span className="tabular-nums text-[10px] w-3">{sortIndicator(colKey)}</span>
        </button>
      </th>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
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
          <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated">
            <table className="w-full min-w-[980px] text-left text-[13px]">
              <thead className="bg-[var(--kin-fill)]/60 text-[11px] uppercase tracking-wide text-kin-muted">
                <tr>
                  <SortTh colKey="name">{tr("agents.colName")}</SortTh>
                  <SortTh colKey="status">{tr("agents.colStatus")}</SortTh>
                  <SortTh colKey="version">{tr("agents.version")}</SortTh>
                  <SortTh colKey="auth">{tr("agents.colAuth")}</SortTh>
                  <SortTh colKey="cost" align="right">
                    {tr("usage.spend")}
                  </SortTh>
                  <SortTh colKey="tokens" align="right">
                    {tr("usage.tokens")}
                  </SortTh>
                  <SortTh colKey="tasks" align="right">
                    {tr("usage.tasks")}
                  </SortTh>
                  <SortTh colKey="cache" align="right">
                    {tr("agents.effCache")}
                  </SortTh>
                  <SortTh colKey="costPerTask" align="right">
                    {tr("agents.effCostPerTask")}
                  </SortTh>
                  <SortTh colKey="tokensPerTask" align="right">
                    {tr("agents.effTokensPerTask")}
                  </SortTh>
                  <th className="px-3 py-2.5 font-semibold text-left whitespace-nowrap text-kin-muted">
                    {tr("usage.limitSpend")}
                  </th>
                  <th className="px-3 py-2.5 font-semibold text-left whitespace-nowrap text-kin-muted">
                    {tr("usage.windowsTitle")}
                  </th>
                  <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap text-kin-muted">
                    {tr("agents.actions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--kin-hairline)]">
                {sortedCatalog.map((a) => {
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
                const cacheHit =
                  usage && usage.cacheEligible > 0
                    ? usage.cacheRead / usage.cacheEligible
                    : null;
                return (
                  <tr key={a.id} className="align-top hover:bg-[var(--kin-fill)]/30">
                    <td className="px-3 py-3 min-w-[160px]">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-kin-text">{a.name}</span>
                        {a.default ? (
                          <span className="rounded-full bg-kin-blue/15 px-2 py-0.5 text-[10px] font-semibold text-kin-blue">
                            {tr("agents.isDefault")}
                          </span>
                        ) : null}
                        {kindBadge ? (
                          <span
                            className="rounded-full bg-[var(--kin-fill)] px-2 py-0.5 text-[10px] font-semibold text-kin-secondary"
                            title={
                              state === "generic"
                                ? tr("agentCatalog.genericHint")
                                : undefined
                            }
                          >
                            {kindBadge}
                          </span>
                        ) : null}
                      </div>
                      {a.id !== a.name ? (
                        <div className="mt-0.5 font-mono text-[11px] text-kin-muted">{a.id}</div>
                      ) : null}
                    </td>
                    <td
                      className="px-3 py-3 whitespace-nowrap text-kin-secondary"
                      title={a.reason || undefined}
                    >
                      {statusLabel(a)}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap tabular-nums text-kin-secondary">
                      {m?.version || "—"}
                    </td>
                    <td
                      className="px-3 py-3 whitespace-nowrap text-kin-secondary"
                      title={tr("agents.authHint")}
                    >
                      {authLabel(m?.auth_status)}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-right tabular-nums font-medium text-kin-text">
                      {usage ? formatCost(usage.cost) : "—"}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-right tabular-nums text-kin-secondary">
                      {usage ? formatTokenCount(usage.tokens) : "—"}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-right tabular-nums text-kin-secondary">
                      {usage ? usage.tasks : "—"}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-right tabular-nums text-kin-secondary">
                      {pct(cacheHit)}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-right tabular-nums text-kin-secondary">
                      {usage && usage.tasks > 0 ? formatCost(usage.cost / usage.tasks) : "—"}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-right tabular-nums text-kin-secondary">
                      {usage && usage.tasks > 0
                        ? formatTokenCount(usage.tokens / usage.tasks)
                        : "—"}
                    </td>
                    <td className="px-3 py-3 min-w-[140px]">
                      <div className="flex flex-col gap-1">
                        {spendProgress && limitStatus?.limit_spend_usd != null ? (
                          <span className={`flex items-center gap-1.5 text-[11px] ${limitColorClass}`}>
                            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--kin-fill)]">
                              <span
                                className={`block h-full rounded-full ${barBgClass}`}
                                style={{ width: `${spendProgress.barPct}%` }}
                              />
                            </span>
                            <span className="tabular-nums">
                              {formatLimitLabel(
                                limitStatus.used_spend_usd,
                                limitStatus.limit_spend_usd,
                                "spend",
                              )}
                            </span>
                          </span>
                        ) : null}
                        {tokensProgress && limitStatus?.limit_tokens != null ? (
                          <span className={`flex items-center gap-1.5 text-[11px] ${limitColorClass}`}>
                            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--kin-fill)]">
                              <span
                                className={`block h-full rounded-full ${barBgClass}`}
                                style={{ width: `${tokensProgress.barPct}%` }}
                              />
                            </span>
                            <span className="tabular-nums">
                              {formatLimitLabel(
                                limitStatus.used_tokens,
                                limitStatus.limit_tokens,
                                "tokens",
                              )}
                            </span>
                          </span>
                        ) : null}
                        {!spendProgress && !tokensProgress ? (
                          <span className="text-[11px] text-kin-muted">—</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-3 min-w-[160px]">
                      {agentWindow?.error ? (
                        <div className="text-[11px] text-kin-muted">{agentWindow.error}</div>
                      ) : agentWindow && agentWindow.windows.length > 0 ? (
                        <div className="flex flex-col gap-1 text-[11px] text-kin-secondary">
                          {agentWindow.plan ? (
                            <span className="text-[10px] uppercase tracking-wide text-kin-muted">
                              {agentWindow.plan}
                            </span>
                          ) : null}
                          {agentWindow.windows.map((w) => {
                            const winPct = Math.min(100, Math.max(0, w.used_percent));
                            const barClass =
                              w.status === "over"
                                ? "bg-[var(--kin-red,#ff453a)]"
                                : w.status === "warn"
                                  ? "bg-[var(--kin-yellow,#ffd60a)]"
                                  : "bg-kin-blue/70";
                            return (
                              <span key={w.kind} className="flex items-center gap-1.5">
                                <span className="w-8 shrink-0 text-kin-muted">
                                  {w.kind === "5h"
                                    ? tr("usage.window5h")
                                    : tr("usage.windowWeekly")}
                                </span>
                                <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-[var(--kin-fill)]">
                                  <span
                                    className={`block h-full rounded-full ${barClass}`}
                                    style={{ width: `${winPct}%` }}
                                  />
                                </span>
                                <span className="tabular-nums">{Math.round(w.used_percent)}%</span>
                                {w.reset_at > 0 ? (
                                  <span className="text-[10px] text-kin-muted">
                                    · {formatResetIn(w.reset_at)}
                                  </span>
                                ) : null}
                              </span>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-[11px] text-kin-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-right">
                      <div className="flex flex-wrap items-center justify-end gap-2">
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
                    </td>
                  </tr>
                );
              })}
                {sortedCatalog.length === 0 && (
                  <tr>
                    <td colSpan={13} className="px-4 py-6 text-sm text-kin-muted">
                      {tr("usage.noAgentUsage")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
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
