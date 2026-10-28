import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ApiError,
  formatCost,
  getUsageLimits,
  getUsageSummary,
  isAuthenticated,
  listAgentManagement,
  listAgents,
  smokeAgents,
  updateSettings,
  type AgentInfo,
  type AgentLimitStatus,
  type AgentManagement,
  type UsageRow,
} from "../api/client";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { MobileCard, MobileRow, MobileSection } from "../components/mobile/MobileList";
import Sheet, { SheetSecondaryButton } from "../components/mobile/Sheet";
import { useSlowHint } from "../hooks/useSlowHint";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";
import { agentCatalogState, openInstallURL, sortAgentCatalog } from "../lib/agentCatalog";
import {
  agentLimitProgress,
  combinedStatus,
  formatLimitLabel,
  type LimitStatus,
} from "../lib/agentLimits";
import { cacheRateLabel, cacheState, formatTokenCount, type CacheStatus } from "../lib/usage";

/**
 * Agents management console with folded-in usage overview.
 */

/** One thing that can be done to an agent, in either layout. */
type AgentAction = {
  key: string;
  label: string;
  /** The hover explanation the desktop table shows; the phone sheet has room for the label alone. */
  hint?: string;
  /** The one or two actions a row leads with; the rest are quiet. */
  primary?: boolean;
  run: () => void;
};

export default function AgentsPage() {
  const tr = useT();
  const navigate = useNavigate();
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [limitStatuses, setLimitStatuses] = useState<AgentLimitStatus[]>([]);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [mgmt, setMgmt] = useState<AgentManagement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [smoking, setSmoking] = useState(false);
  /** Which agent's action sheet is open on a phone; the desktop table never sets it. */
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const pushToast = useAppStore((s) => s.pushToast);
  const slow = useSlowHint((rows === null || agents === null) && !error);

  const load = useCallback(
    async (refresh = false) => {
      if (!isAuthenticated()) return;
      setError(null);
      try {
        const [data, limits, agentList, management] = await Promise.all([
          getUsageSummary(days),
          getUsageLimits().catch(() => [] as AgentLimitStatus[]),
          listAgents(),
          listAgentManagement(refresh).catch(() => [] as AgentManagement[]),
        ]);
        setRows(data);
        setLimitStatuses(limits);
        setAgents(agentList);
        setMgmt(management);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [days],
  );

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

  async function onRecheck() {
    setRechecking(true);
    try {
      await load(true);
    } finally {
      setRechecking(false);
    }
  }

  async function onSmoke() {
    setSmoking(true);
    try {
      // Only installed Tier-2 agents are probed server-side; pass empty = all installed.
      const { results } = await smokeAgents();
      const ran = results.filter((r) => !r.skipped);
      const ok = ran.filter((r) => r.ok).length;
      const fail = ran.filter((r) => !r.ok).length;
      const skipped = results.filter((r) => r.skipped).length;
      pushToast(
        tr("agents.smokeDone", { ok: String(ok), fail: String(fail), skipped: String(skipped) }),
        fail > 0 ? "error" : "info",
      );
      await load(false);
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : String(e), "error");
    } finally {
      setSmoking(false);
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

  function askDefaultAgentToInstall(agent: AgentInfo, command: string) {
    const prompt = tr("agents.installPrompt", {
      agent: agent.name || agent.id,
      command,
    });
    navigate(`/new?q=${encodeURIComponent(prompt)}`);
  }

  /**
   * What can be done to one agent, written once.
   *
   * The table's action cell and the phone's share sheet are two shapes of one
   * list, and the conditions are not obvious: "ask the default Agent" exists
   * only while the agent is *not* installed, "copy the update command" only
   * once it is, and "copy the install command" either way. Spelled twice, the
   * two surfaces disagree the first time a condition changes.
   */
  function agentActions(a: AgentInfo): AgentAction[] {
    const actions: AgentAction[] = [];
    if (a.available && !a.default) {
      actions.push({
        key: "default",
        label: tr("agents.setDefault"),
        primary: true,
        run: () => void onSetDefault(a.id),
      });
    }
    const url = a.install_url;
    if (!a.installed && url) {
      actions.push({
        key: "install",
        label: tr("agentCatalog.install"),
        hint: tr("agentCatalog.installHint"),
        primary: true,
        run: () => openInstallURL(url),
      });
    }
    const installCmd = mgmtById.get(a.id)?.install_cmd;
    if (installCmd) {
      if (!a.installed) {
        actions.push({
          key: "askInstall",
          label: tr("agents.askInstall"),
          hint: tr("agents.askInstallHint"),
          primary: true,
          run: () => askDefaultAgentToInstall(a, installCmd),
        });
      }
      actions.push({
        key: "copyInstall",
        label: tr("agents.copyInstall"),
        run: () => void copyText(installCmd),
      });
    }
    const updateCmd = mgmtById.get(a.id)?.update_cmd;
    if (updateCmd && a.installed) {
      actions.push({
        key: "copyUpdate",
        label: tr("agents.copyUpdate"),
        run: () => void copyText(updateCmd),
      });
    }
    return actions;
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
          const ca = ua && ua.cacheEligible > 0 ? ua.cacheRead / ua.cacheEligible : -1;
          const cb = ub && ub.cacheEligible > 0 ? ub.cacheRead / ub.cacheEligible : -1;
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
          <span className="tabular-nums text-micro w-3">{sortIndicator(colKey)}</span>
        </button>
      </th>
    );
  }

  // The sheet's target and its actions, read from the same sorted list the
  // phone rows render: an agent that a refresh drops takes its sheet with it.
  const actionAgent = actionsFor ? (sortedCatalog.find((a) => a.id === actionsFor) ?? null) : null;
  const actionItems = actionAgent ? agentActions(actionAgent) : [];

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="max-w-page-wide mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="hidden text-hero font-bold tracking-tight md:block">
            {tr("agents.title")}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="kin-btn-secondary min-h-10 px-3 text-strong"
              disabled={rechecking || smoking}
              onClick={() => void onRecheck()}
            >
              {rechecking ? tr("common.loading") : tr("agents.recheckAll")}
            </button>
            <button
              type="button"
              className="kin-btn-secondary min-h-10 px-3 text-strong"
              disabled={smoking || rechecking}
              title={tr("agents.smokeHint")}
              onClick={() => void onSmoke()}
            >
              {smoking ? tr("agents.smoking") : tr("agents.smokeAll")}
            </button>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="kin-input w-auto min-h-10"
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
            {/* The same shape the page arrives in — four stat tiles and the
                chart — rather than one grey block. A placeholder that is not
                the layout is a second layout: everything below it moves when
                the data lands. */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {["spend", "tokens", "cache", "tasks"].map((k) => (
                <SkeletonLine key={k} className="h-[76px] rounded-xl" />
              ))}
            </div>
            <SkeletonLine className="h-28 w-full rounded-xl" />
            <SkeletonLine className="h-24 w-full rounded-xl" />
          </div>
        )}

        {error && (
          <div
            className="mt-6 rounded-xl border border-kin-red/40 bg-kin-red/10 px-4 py-3 text-strong leading-5 text-kin-red-ink"
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
                <div key={c.label} className="rounded-xl bg-kin-elevated px-4 py-3">
                  <div className="text-caption text-kin-muted font-semibold uppercase tracking-label">
                    {c.label}
                  </div>
                  <div className="mt-1 text-hero font-semibold tabular-nums tracking-tight">
                    {c.value}
                  </div>
                </div>
              ))}
            </div>

            <div>
              <div className="text-strong font-medium text-kin-muted mb-3">
                {tr("usage.dailySpend")}
              </div>
              <div className="flex items-stretch gap-1.5 h-28">
                {byDay.length === 0 && (
                  <p className="text-strong leading-5 text-kin-muted">{tr("usage.noData")}</p>
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
                    <span className="text-micro text-kin-muted truncate w-full text-center">
                      {date.slice(5)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {agents !== null && (
          <div className="mt-6 overflow-x-auto rounded-xl bg-kin-elevated max-md:hidden">
            <table className="w-full text-left text-strong md:min-w-table">
              <thead className="bg-[var(--kin-fill)] text-caption uppercase tracking-label text-kin-muted">
                <tr>
                  <SortTh colKey="name">{tr("agents.colName")}</SortTh>
                  <SortTh colKey="status">{tr("agents.colStatus")}</SortTh>
                  <SortTh colKey="version" className="hidden md:table-cell">
                    {tr("agents.version")}
                  </SortTh>
                  <SortTh colKey="auth" className="hidden md:table-cell">
                    {tr("agents.colAuth")}
                  </SortTh>
                  <SortTh colKey="cost" align="right" className="hidden md:table-cell">
                    {tr("usage.spend")}
                  </SortTh>
                  <SortTh colKey="tokens" align="right" className="hidden md:table-cell">
                    {tr("usage.tokens")}
                  </SortTh>
                  <SortTh colKey="tasks" align="right" className="hidden md:table-cell">
                    {tr("usage.tasks")}
                  </SortTh>
                  <SortTh colKey="cache" align="right" className="hidden md:table-cell">
                    {tr("agents.effCache")}
                  </SortTh>
                  <SortTh colKey="costPerTask" align="right" className="hidden md:table-cell">
                    {tr("agents.effCostPerTask")}
                  </SortTh>
                  <SortTh colKey="tokensPerTask" align="right" className="hidden md:table-cell">
                    {tr("agents.effTokensPerTask")}
                  </SortTh>
                  <th className="hidden px-3 py-2.5 font-semibold text-left whitespace-nowrap text-kin-muted md:table-cell">
                    {tr("usage.limitSpend")}
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
                      : (spendProgress?.status ?? tokensProgress?.status ?? "ok");
                  const limitColorClass =
                    limitColor === "over"
                      ? "text-kin-red-ink"
                      : limitColor === "warn"
                        ? "text-kin-orange-ink"
                        : "text-kin-muted";
                  const barBgClass =
                    limitColor === "over"
                      ? "bg-kin-red"
                      : limitColor === "warn"
                        ? "bg-kin-orange"
                        : "bg-kin-blue/70";
                  const kindBadge =
                    state === "native"
                      ? tr("agentCatalog.native")
                      : state === "generic"
                        ? tr("agentCatalog.generic")
                        : null;
                  const cacheHit =
                    usage && usage.cacheEligible > 0 ? usage.cacheRead / usage.cacheEligible : null;
                  return (
                    <tr key={a.id} className="align-top hover:bg-[var(--kin-fill)]">
                      <td className="px-3 py-3 md:min-w-cell">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-kin-text">{a.name}</span>
                          {a.default ? (
                            <span className="rounded-full bg-kin-blue/15 px-2 py-0.5 text-micro font-semibold text-kin-blue-ink">
                              {tr("agents.isDefault")}
                            </span>
                          ) : null}
                          {kindBadge ? (
                            <span
                              className="rounded-full bg-[var(--kin-fill)] px-2 py-0.5 text-micro font-semibold text-kin-secondary"
                              title={
                                state === "generic" ? tr("agentCatalog.genericHint") : undefined
                              }
                            >
                              {kindBadge}
                            </span>
                          ) : null}
                        </div>
                        {a.id !== a.name ? (
                          <div className="mt-0.5 font-mono text-caption text-kin-muted">{a.id}</div>
                        ) : null}
                      </td>
                      <td
                        className="px-3 py-3 whitespace-nowrap text-kin-secondary"
                        title={a.reason || undefined}
                      >
                        {statusLabel(a)}
                      </td>
                      <td className="hidden px-3 py-3 whitespace-nowrap tabular-nums text-kin-secondary md:table-cell">
                        {m?.version || "—"}
                      </td>
                      <td
                        className="hidden px-3 py-3 whitespace-nowrap text-kin-secondary md:table-cell"
                        title={tr("agents.authHint")}
                      >
                        {authLabel(m?.auth_status)}
                      </td>
                      <td className="hidden px-3 py-3 whitespace-nowrap text-right tabular-nums font-medium text-kin-text md:table-cell">
                        {usage ? formatCost(usage.cost) : "—"}
                      </td>
                      <td className="hidden px-3 py-3 whitespace-nowrap text-right tabular-nums text-kin-secondary md:table-cell">
                        {usage ? formatTokenCount(usage.tokens) : "—"}
                      </td>
                      <td className="hidden px-3 py-3 whitespace-nowrap text-right tabular-nums text-kin-secondary md:table-cell">
                        {usage ? usage.tasks : "—"}
                      </td>
                      <td className="hidden px-3 py-3 whitespace-nowrap text-right tabular-nums text-kin-secondary md:table-cell">
                        {pct(cacheHit)}
                      </td>
                      <td className="hidden px-3 py-3 whitespace-nowrap text-right tabular-nums text-kin-secondary md:table-cell">
                        {usage && usage.tasks > 0 ? formatCost(usage.cost / usage.tasks) : "—"}
                      </td>
                      <td className="hidden px-3 py-3 whitespace-nowrap text-right tabular-nums text-kin-secondary md:table-cell">
                        {usage && usage.tasks > 0
                          ? formatTokenCount(usage.tokens / usage.tasks)
                          : "—"}
                      </td>
                      <td className="hidden px-3 py-3 min-w-cell md:table-cell">
                        <div className="flex flex-col gap-1">
                          {spendProgress && limitStatus?.limit_spend_usd != null ? (
                            <span
                              className={`flex items-center gap-1.5 text-caption ${limitColorClass}`}
                            >
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
                            <span
                              className={`flex items-center gap-1.5 text-caption ${limitColorClass}`}
                            >
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
                            <span className="text-caption text-kin-muted">—</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap text-right md:min-w-cell">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {agentActions(a).map((action) => (
                            <button
                              key={action.key}
                              type="button"
                              className={[
                                "text-body hover:underline",
                                action.primary ? "text-kin-blue-ink" : "text-kin-secondary",
                              ].join(" ")}
                              title={action.hint}
                              onClick={action.run}
                            >
                              {action.label}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {sortedCatalog.length === 0 && (
                  <tr>
                    <td colSpan={13} className="px-4 py-6 text-strong leading-5 text-kin-muted">
                      {tr("usage.noAgentUsage")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* The phone's copy of the same list. The table is a desktop
            instrument — twelve columns, six of them hidden below `md` and the
            rest still 379px wide at 390, so the action column scrolled off the
            screen — and its action cell stacks four links vertically in the
            width that is left. A phone gets one row per agent and one `…` that
            opens the same actions in a sheet, from `agentActions` above so the
            two layouts cannot disagree about what exists. */}
        {agents !== null && (
          <div className="-mx-4 md:hidden">
            {/* No section title: the shell bar is already an h1 reading
                "Agents" on this route, and repeating the word 8px below it is
                the same doubling the page's own h1 was hidden to avoid. */}
            <MobileSection>
              <MobileCard>
                {sortedCatalog.map((a) => {
                  const actions = agentActions(a);
                  const usage = usageByAgent.get(a.id);
                  const detail = [statusLabel(a), usage ? formatCost(usage.cost) : null]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <MobileRow
                      key={a.id}
                      title={
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{a.name}</span>
                          {a.default ? (
                            <span className="flex-none rounded-full bg-kin-blue/15 px-1.5 py-0.5 text-micro font-semibold text-kin-blue-ink">
                              {tr("agents.isDefault")}
                            </span>
                          ) : null}
                        </span>
                      }
                      detail={detail}
                      trailing={
                        actions.length > 0 ? (
                          <button
                            type="button"
                            aria-label={`${tr("agents.actions")} — ${a.name}`}
                            aria-haspopup="dialog"
                            aria-expanded={actionsFor === a.id}
                            onClick={() => setActionsFor(a.id)}
                            className="flex h-11 w-11 items-center justify-center rounded-full text-subtitle text-kin-secondary active:bg-[var(--kin-fill)]"
                          >
                            …
                          </button>
                        ) : undefined
                      }
                    />
                  );
                })}
                {sortedCatalog.length === 0 && <MobileRow title={tr("usage.noAgentUsage")} />}
              </MobileCard>
            </MobileSection>
          </div>
        )}

        <Sheet
          open={actionAgent !== null}
          onClose={() => setActionsFor(null)}
          title={actionAgent?.name}
          subtitle={actionAgent ? statusLabel(actionAgent) : undefined}
          footer={
            <SheetSecondaryButton onClick={() => setActionsFor(null)}>
              {tr("common.cancel")}
            </SheetSecondaryButton>
          }
        >
          {actionItems.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={() => {
                setActionsFor(null);
                action.run();
              }}
              className="kin-row-press flex min-h-12 w-full items-center rounded-xl px-3 text-left text-subtitle text-kin-text"
            >
              {action.label}
            </button>
          ))}
        </Sheet>
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
