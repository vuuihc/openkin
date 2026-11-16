import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
  type AgentSmokeResult,
  type UsageRow,
} from "../api/client";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { MobileCard, MobileRow, MobileSection } from "../components/mobile/MobileList";
import Sheet, { SheetPrimaryButton, SheetSecondaryButton } from "../components/mobile/Sheet";
import { useAgentSessionImport } from "../hooks/useAgentSessionImport";
import { useSlowHint } from "../hooks/useSlowHint";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";
import {
  agentCatalogState,
  CATALOG_LIMIT,
  openInstallURL,
  planAgentCatalog,
  seedCatalogFamilies,
} from "../lib/agentCatalog";
import { agentFamily } from "../lib/agentFamilies";
import {
  agentLimitProgress,
  combinedStatus,
  formatLimitLabel,
  quotaWait,
  waitParts,
  type LimitStatus,
} from "../lib/agentLimits";
import {
  readAgentPagePrefs,
  readConnectedFamilies,
  readQuotaWaitSince,
  writeAgentPagePrefs,
  writeConnectedFamilies,
  writeQuotaWaitSince,
  type AgentSortDir,
  type AgentSortKey,
  type UsageDays,
} from "../lib/agentPageState";
import { importToast } from "../lib/agentSessionImport";
import { draftEntryState, phonePush, returnListUrl } from "../lib/phoneNavigation";
import { cacheRateLabel, formatTokenCount, summarizeUsage } from "../lib/usage";

/**
 * The agents console: what this machine has, whether it works, what it cost.
 *
 * Two rules from KIN-AGENTS-001 shape this page more than any layout choice.
 * The catalog is curated — at most ten products, and a discovered agent enters
 * only after a person confirms it. And connecting is not importing: the
 * sessions of an agent arrive only when someone presses Import, never because
 * the page was opened.
 */

/** One thing that can be done to an agent, in either layout. */
type AgentAction = {
  key: string;
  label: string;
  /** The hover explanation the desktop menu shows; the phone sheet has room for the label alone. */
  hint?: string;
  /** The one or two actions a row leads with; the rest are quiet. */
  primary?: boolean;
  disabled?: boolean;
  run: () => void;
};

type SmokeReport = { at: number; results: AgentSmokeResult[] } | { at: number; error: string };

type StatusTone = "ok" | "warn" | "bad" | "muted";

type RowStatus = { label: string; tone: StatusTone; title?: string };

const EMPTY_FAMILIES: string[] = [];

/**
 * `embedded` omits the page's own `h1` when Settings hosts this console in a
 * tab: the settings screen already draws the one heading for that page.
 * Temporary for N4 — E4a finishes the move and removes it.
 */
export default function AgentsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const tr = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const prefs = useMemo(() => readAgentPagePrefs(), []);
  const [days, setDays] = useState<UsageDays>(prefs.days ?? 7);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  /** null = the limits read failed; [] = read fine, nothing configured. */
  const [limitStatuses, setLimitStatuses] = useState<AgentLimitStatus[] | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  /** null = the management probe failed, so auth is unknown rather than signed out. */
  const [mgmt, setMgmt] = useState<AgentManagement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [smokingAll, setSmokingAll] = useState(false);
  const [smokingId, setSmokingId] = useState<string | null>(null);
  const [smokeReport, setSmokeReport] = useState<SmokeReport | null>(null);
  const { importing, importEveryMachine } = useAgentSessionImport();
  /** null = this console has never stored a catalog; [] = everything was removed. */
  const [connectedFamilies, setConnectedFamilies] = useState<string[] | null>(() =>
    readConnectedFamilies(),
  );
  const [showDiscovered, setShowDiscovered] = useState(false);
  const [connectFor, setConnectFor] = useState<AgentInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  /**
   * A sheet row that navigates runs after the sheet's own history entry is
   * gone. Running it in the click handler would leave Agent Ops beneath the
   * destination instead of the list (KIN-CONTINUE-002).
   */
  const sheetAction = useRef<(() => void) | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<AgentSortKey>(prefs.sortKey ?? "cost");
  const [sortDir, setSortDir] = useState<AgentSortDir>(prefs.sortDir ?? "desc");
  const [now, setNow] = useState(() => Date.now());
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const pushToast = useAppStore((s) => s.pushToast);
  const offline = wsStatus === "disconnected";
  const slow = useSlowHint((rows === null || agents === null) && !error && !usageError);

  const rangeRef = useRef<UsageDays>(days);
  /** The range the control shows; a reconnect must reload this one. */
  const daysRef = useRef<UsageDays>(days);
  const usageRequest = useRef(0);
  /** The newest agents read; a slower older answer must not win. */
  const agentsRequest = useRef(0);
  /**
   * Set when a failed range switch puts the selector back. The revert changes
   * `days`, which would otherwise start a second read of the range already on
   * screen — and its success would erase the failure note the person still
   * needs to read.
   */
  const skipNextRangeLoad = useRef(false);
  /**
   * The connect request in flight. Cancel is a decision, not only a dismissal:
   * when the person closes the sheet, the answer that arrives later must not
   * add the product (KIN-AGENTS-001 step 4, "cancel leaves it unconnected").
   */
  const connectAttempt = useRef(0);
  /** The catalog before the optimistic add, so Cancel can restore it. */
  const connectBefore = useRef<string[]>([]);

  const noteQuotaWaits = useCallback((limits: AgentLimitStatus[]) => {
    const at = Date.now();
    for (const status of limits) {
      if (status.status !== "over") continue;
      if (readQuotaWaitSince(status.agent, status.period_start) === null) {
        writeQuotaWaitSince(status.agent, status.period_start, at);
      }
    }
  }, []);

  /**
   * Apply one agents answer.
   *
   * Every caller goes through here so the newest answer wins: the generation
   * is bumped on commit, and `loadAgents` checks its own generation first, so a
   * slow recheck cannot land after a newer read and restore a row the person
   * just changed.
   */
  const commitAgents = useCallback(
    (
      list: AgentInfo[],
      management: AgentManagement[] | null,
      limits?: AgentLimitStatus[] | null,
    ) => {
      agentsRequest.current += 1;
      setAgents(list);
      // A failed probe is `null`, and that is an answer too: keeping the last
      // known auth state after a failed read would present it as current
      // (KIN-AGENTS-001 step 3, "unreadable status says so").
      setMgmt(management);
      if (limits !== undefined) {
        // A failed limits read hides the column (KIN-AGENTS-001 step 6) rather
        // than keeping numbers nobody can vouch for.
        setLimitStatuses(limits);
        if (limits) noteQuotaWaits(limits);
      }
      setLastLoadedAt(Date.now());
      setError(null);
    },
    [noteQuotaWaits],
  );

  const loadAgents = useCallback(async () => {
    if (!isAuthenticated()) return;
    const gen = ++agentsRequest.current;
    try {
      const [list, management, limits] = await Promise.all([
        listAgents(),
        listAgentManagement().catch(() => null),
        getUsageLimits().catch(() => null),
      ]);
      if (gen !== agentsRequest.current) return;
      commitAgents(list, management, limits);
    } catch (e) {
      if (gen !== agentsRequest.current) return;
      if (e instanceof ApiError && e.status === 401) return;
      setError(messageOf(e));
    }
  }, [commitAgents]);

  const loadUsage = useCallback(
    async (range: UsageDays) => {
      if (!isAuthenticated()) return;
      const gen = ++usageRequest.current;
      setUsageLoading(true);
      try {
        const data = await getUsageSummary(range);
        if (gen !== usageRequest.current) return;
        setRows(data);
        rangeRef.current = range;
        skipNextRangeLoad.current = false;
        setUsageError(null);
      } catch (e) {
        if (gen !== usageRequest.current) return;
        // The old numbers stay, and the selector goes back to the range they
        // belong to: a control that says 90 while the cards are 7 is a lie the
        // next reader will believe.
        setUsageError(tr("agents.intervalFailed"));
        // Only a *switch* has something to revert. The first load already asks
        // for the range the control shows; arming the skip there would swallow
        // the next switch instead of preventing a duplicate read.
        if (range !== rangeRef.current) {
          skipNextRangeLoad.current = true;
          setDays(rangeRef.current);
        }
      } finally {
        if (gen === usageRequest.current) setUsageLoading(false);
      }
    },
    [tr],
  );

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    daysRef.current = days;
    if (skipNextRangeLoad.current) {
      skipNextRangeLoad.current = false;
      return;
    }
    void loadUsage(days);
  }, [days, loadUsage]);

  /**
   * The generation this page has already reacted to. The reconnect counter is
   * kept in the store, so returning to `/agents` after a reconnect would
   * otherwise read everything twice: the mount effects and this one.
   */
  const seenReconnect = useRef(reconnectGen);
  useEffect(() => {
    if (reconnectGen === seenReconnect.current) return;
    seenReconnect.current = reconnectGen;
    void loadAgents();
    void loadUsage(daysRef.current);
  }, [reconnectGen, loadAgents, loadUsage]);

  useEffect(() => {
    writeAgentPagePrefs({ days, sortKey, sortDir });
  }, [days, sortKey, sortDir]);

  // A waiting agent's elapsed time is worth a tick; nothing else on the page
  // changes on a clock.
  const anyWaiting = Boolean(limitStatuses?.some((status) => status.status === "over"));
  useEffect(() => {
    if (!anyWaiting) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [anyWaiting]);

  // The first visit seeds the catalog from what Kin can host (KIN-AGENTS-001
  // step 1): those agents were already in the new-chat picker, and asking about
  // each of them would be a migration prompt nobody asked for. A stored list —
  // including an empty one — is never reseeded.
  const seed = useMemo(
    () => (agents !== null && connectedFamilies === null ? seedCatalogFamilies(agents) : null),
    [agents, connectedFamilies],
  );
  useEffect(() => {
    // A machine with no hostable products is not a decision to store: writing
    // `[]` would freeze that read as "the person removed everything" and a
    // later install would never be seeded.
    if (seed === null || seed.length === 0) return;
    setConnectedFamilies(seed);
    writeConnectedFamilies(seed);
  }, [seed]);
  const families = connectedFamilies ?? seed ?? EMPTY_FAMILIES;

  const plan = useMemo(() => planAgentCatalog(agents ?? [], families), [agents, families]);
  // The cap counts what the catalog holds, including a family this machine has
  // stopped reporting: that slot is still spent until it is removed.
  const full = plan.full;
  const storedFamilies = families.length;

  const familyById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents ?? []) m.set(a.id, agentFamily(a.id, a.family));
    return m;
  }, [agents]);
  const familyOf = useCallback((id: string) => familyById.get(id) ?? agentFamily(id), [familyById]);

  /**
   * The product that holds the configured default, whichever variant carries
   * the flag. Collapsing a family can display the native variant while the
   * setting points at its ACP sibling; asking the row's own `default` would
   * then hide the badge and let the default product be removed.
   */
  const defaultFamilies = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents ?? []) {
      if (a.default) set.add(agentFamily(a.id, a.family));
    }
    return set;
  }, [agents]);
  const isDefaultFamily = useCallback(
    (a: AgentInfo) => defaultFamilies.has(familyOf(a.id)),
    [defaultFamilies, familyOf],
  );

  /**
   * Products worth offering when the catalog is empty but nothing is
   * discovered: a stored-empty catalog can leave no connectable row, and an
   * empty page with no next action is a dead end.
   */
  const installSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: AgentInfo[] = [];
    for (const a of [...(agents ?? [])].sort((x, y) => x.name.localeCompare(y.name))) {
      if (a.installed || !a.install_url) continue;
      const family = familyOf(a.id);
      if (seen.has(family)) continue;
      seen.add(family);
      out.push(a);
      if (out.length === 3) break;
    }
    return out;
  }, [agents, familyOf]);

  const mgmtById = useMemo(() => {
    const m = new Map<string, AgentManagement>();
    for (const row of mgmt ?? []) m.set(row.id, row);
    return m;
  }, [mgmt]);

  /**
   * One auth answer per family, for the variants the probe did not cover.
   *
   * The row shows one variant of a product, but `/api/agents` and usage report
   * every transport: a turn may have run through `claude-acp` while the table
   * displays `claude-code`. Keying the cells by the displayed id loses that
   * money and that login; keying them by family keeps one product's numbers in
   * one row.
   */
  const mgmtByFamily = useMemo(() => {
    const rank = (row: AgentManagement) =>
      row.auth_status === "signed_in" ? 2 : row.auth_status === "not_signed_in" ? 0 : 1;
    const m = new Map<string, AgentManagement>();
    for (const row of mgmt ?? []) {
      const family = familyOf(row.id);
      const cur = m.get(family);
      if (!cur || rank(row) > rank(cur)) m.set(family, row);
    }
    return m;
  }, [mgmt, familyOf]);

  const limitsByFamily = useMemo(() => {
    const rank = (status: string) => (status === "over" ? 2 : status === "warn" ? 1 : 0);
    const m = new Map<string, AgentLimitStatus>();
    for (const status of limitStatuses ?? []) {
      const family = familyOf(status.agent);
      const cur = m.get(family);
      if (!cur || rank(status.status) >= rank(cur.status)) m.set(family, status);
    }
    return m;
  }, [limitStatuses, familyOf]);

  const usageByFamily = useMemo(() => {
    const m = new Map<
      string,
      {
        tasks: number;
        cost: number;
        tokens: number;
        cacheRead: number;
        cacheEligible: number;
      }
    >();
    for (const r of rows ?? []) {
      const family = familyOf(r.agent);
      const cur = m.get(family) ?? {
        tasks: 0,
        cost: 0,
        tokens: 0,
        cacheRead: 0,
        cacheEligible: 0,
      };
      cur.tasks += r.tasks;
      cur.cost += r.cost_usd ?? 0;
      cur.tokens += r.tokens_in + r.tokens_out;
      cur.cacheRead += r.cache_read_tokens;
      cur.cacheEligible += r.cache_eligible_input_tokens;
      m.set(family, cur);
    }
    return m;
  }, [rows, familyOf]);

  /** The management answer for a catalog row: its own variant first, then the family. */
  const mgmtFor = useCallback(
    (a: AgentInfo) => mgmtById.get(a.id) ?? mgmtByFamily.get(familyOf(a.id)),
    [mgmtById, mgmtByFamily, familyOf],
  );

  const totals = useMemo(() => summarizeUsage(rows), [rows]);
  const maxDay = Math.max(0.001, ...totals.byDay.map(([, cost]) => cost));
  const updating = usageLoading && rows !== null;

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
    const list = [...plan.connected];
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const ua = usageByFamily.get(familyOf(a.id));
      const ub = usageByFamily.get(familyOf(b.id));
      const ma = mgmtFor(a);
      const mb = mgmtFor(b);
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
      }
      if (cmp !== 0) return cmp * dir;
      const costCmp = (ub?.cost ?? 0) - (ua?.cost ?? 0);
      if (costCmp !== 0) return costCmp;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [plan.connected, sortKey, sortDir, usageByFamily, familyOf, mgmtFor]);

  function toggleSort(key: AgentSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    const numeric: AgentSortKey[] = ["cost", "tokens", "tasks"];
    setSortKey(key);
    setSortDir(numeric.includes(key) ? "desc" : "asc");
  }

  function checkingFor(a: AgentInfo): boolean {
    return (
      checkingAll ||
      smokingAll ||
      checkingId === a.id ||
      smokingId === a.id ||
      (connecting && connectFor?.id === a.id)
    );
  }

  function rowStatus(a: AgentInfo, checking: boolean): RowStatus {
    if (checking) return { label: tr("agents.checking"), tone: "muted" };
    if (!a.installed) return { label: tr("agentCatalog.notInstalled"), tone: "muted" };
    const m = mgmtFor(a);
    // A stale credential is the one state a person can fix, and the daemon's
    // "available" flag does not know about it: the agent launches, then the
    // first turn fails. Say so before the new chat does.
    if (m?.auth_status === "not_signed_in") {
      return { label: tr("agents.needSignIn"), tone: "warn", title: m.auth_detail };
    }
    switch (agentCatalogState(a)) {
      case "native":
      case "generic":
        return { label: tr("agents.available"), tone: "ok" };
      case "verifying":
        return {
          label: tr("agentCatalog.verifying"),
          tone: "muted",
          title: tr("agentCatalog.verifyingHint"),
        };
      case "unavailable":
        return {
          label: tr("agentCatalog.unavailable"),
          tone: "bad",
          title: a.reason,
        };
      case "not_installed":
        // Unreachable for any row the catalog holds (it returned above), but
        // the state is part of the classifier's answer and a future caller
        // should get a label rather than `undefined`.
        return { label: tr("agentCatalog.notInstalled"), tone: "muted" };
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

  function durationLabel(ms: number): string {
    if (ms < 60_000) return tr("agents.waitJustNow");
    const { hours, minutes } = waitParts(ms);
    if (hours === 0) return tr("agents.waitMinutes", { count: minutes });
    return tr("agents.waitHours", { hours, minutes });
  }

  type QuotaInfo = { line: string; detail: string; label: string };

  /**
   * The waiting facts once, so the table, the phone card and the accessible
   * name cannot disagree. `label` carries the reason and the recovery instant
   * as text: a `title` alone is unreachable on a phone and by keyboard.
   */
  function quotaInfo(status: AgentLimitStatus | undefined): QuotaInfo | null {
    if (!status) return null;
    const wait = quotaWait(status, readQuotaWaitSince(status.agent, status.period_start), now);
    if (!wait.waiting) return null;
    const waited =
      wait.elapsedMs === null
        ? tr("agents.quotaWaiting")
        : tr("agents.quotaWaited", { duration: durationLabel(wait.elapsedMs) });
    const line =
      wait.elapsedMs === null
        ? tr("agents.quotaWaiting")
        : tr("agents.quotaWaitLabel", { duration: durationLabel(wait.elapsedMs) });
    const recovery =
      wait.recoveryAt === null
        ? tr("agents.quotaResumes")
        : tr("agents.quotaRecovers", { time: clock(wait.recoveryAt) });
    return {
      line,
      detail: `${waited} · ${recovery}`,
      label: `${tr("agents.quotaReason")} · ${recovery}`,
    };
  }

  async function onRecheck() {
    if (offline || checkingAll) return;
    setCheckingAll(true);
    setActionError(null);
    // Same rule as the background reads: the newest answer wins. A recheck
    // that lands after a newer load would otherwise restore the default or
    // auth state the person just changed.
    const gen = ++agentsRequest.current;
    try {
      const [list, management, limits] = await Promise.all([
        listAgents(),
        listAgentManagement(true),
        getUsageLimits().catch(() => null),
      ]);
      if (gen !== agentsRequest.current) return;
      // Recheck is also how a person watches a quota recover (step 6), so the
      // limits are re-read with the agents, not only on mount.
      commitAgents(list, management, limits);
    } catch (e) {
      if (gen !== agentsRequest.current) return;
      setActionError(tr("agents.recheckFailed", { reason: messageOf(e) }));
    } finally {
      setCheckingAll(false);
    }
  }

  async function recheckOne(a: AgentInfo) {
    if (offline || checkingFor(a)) return;
    setCheckingId(a.id);
    setActionError(null);
    const gen = ++agentsRequest.current;
    try {
      const [list, management, limits] = await Promise.all([
        listAgents(),
        listAgentManagement(true),
        getUsageLimits().catch(() => null),
      ]);
      if (gen !== agentsRequest.current) return;
      commitAgents(list, management, limits);
    } catch (e) {
      if (gen !== agentsRequest.current) return;
      setActionError(tr("agents.checkFailed", { name: a.name || a.id, reason: messageOf(e) }));
    } finally {
      // A newer per-row check on another agent may have started while this one
      // was in flight; clearing unconditionally would hide its "checking".
      setCheckingId((cur) => (cur === a.id ? null : cur));
    }
  }

  async function runSmoke(ids?: string[]) {
    if (offline) return;
    if (ids) setSmokingId(ids[0]);
    else setSmokingAll(true);
    setActionError(null);
    try {
      let results: AgentSmokeResult[];
      try {
        ({ results } = await smokeAgents(ids));
      } catch (e) {
        setSmokeReport({ at: Date.now(), error: messageOf(e) });
        return;
      }
      // The per-agent outcome is the answer the person asked for; keep it even
      // if the row refresh below fails (KIN-AGENTS-001 step 5).
      setSmokeReport({ at: Date.now(), results });
      const gen = ++agentsRequest.current;
      try {
        const [list, management] = await Promise.all([listAgents(), listAgentManagement(true)]);
        if (gen !== agentsRequest.current) return;
        commitAgents(list, management);
      } catch (e) {
        // A failed refresh is only worth reporting while it is still the
        // newest read; a stale failure would land after a newer success.
        if (gen === agentsRequest.current) pushToast(messageOf(e), "error");
      }
    } finally {
      if (ids) setSmokingId((cur) => (cur === ids[0] ? null : cur));
      else setSmokingAll(false);
    }
  }

  async function onSetDefault(id: string) {
    try {
      await updateSettings({ "agent.default": id });
      pushToast(tr("agents.defaultUpdated"), "info");
      await loadAgents();
    } catch (e) {
      pushToast(messageOf(e), "error");
    }
  }

  async function onImport() {
    if (offline || importing) return;
    setActionError(null);
    try {
      const result = await importEveryMachine();
      window.dispatchEvent(new CustomEvent("kin:agent-sessions-changed"));
      const { message, kind } = importToast(result, tr);
      pushToast(message, kind);
      await loadAgents();
    } catch (e) {
      const message = `${tr("settings.localAgents.importFailed")}: ${messageOf(e)}`;
      setActionError(message);
      pushToast(message, "error");
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
    openPrefilledDraft(prompt);
  }

  function askDefaultAgentToSignIn(agent: AgentInfo, management: AgentManagement) {
    const prompt = tr("agents.signInPrompt", {
      agent: agent.name || agent.id,
      detail: management.auth_detail || "—",
    });
    openPrefilledDraft(prompt);
  }

  function openPrefilledDraft(prompt: string) {
    phonePush(navigate, location, `/new?q=${encodeURIComponent(prompt)}`, {
      state: draftEntryState(returnListUrl(location)),
    });
  }

  function beginConnect(a: AgentInfo) {
    setConnectError(null);
    setConnectFor(a);
  }

  async function confirmConnect() {
    const a = connectFor;
    if (!a || connecting || full) return;
    const family = agentFamily(a.id, a.family);
    const before = families;
    const next = before.includes(family) ? before : [...before, family];
    const attempt = ++connectAttempt.current;
    connectBefore.current = before;
    setConnecting(true);
    setConnectError(null);
    // The row appears immediately and wears "checking" while the machine is
    // asked about it. If that read fails, the family is put back and the
    // discovery stays "not connected" (KIN-AGENTS-001 step 4) — a catalog entry
    // that only exists because a request failed is worse than a retry.
    setConnectedFamilies(next);
    writeConnectedFamilies(next);
    // This read is one of the page's reads, so it takes a generation too: an
    // answer that a newer read has already replaced must not be committed.
    const gen = ++agentsRequest.current;
    try {
      const [list, management] = await Promise.all([listAgents(), listAgentManagement(true)]);
      if (attempt !== connectAttempt.current) return;
      const fresh = gen === agentsRequest.current;
      // A newer read already committed the truth; this older answer must not
      // decide that the product is gone (it can predate its registration).
      if (fresh) commitAgents(list, management);
      // The machine may have stopped reporting the product between discovery
      // and confirmation; a stored family that no longer exists is not a
      // connection, so say so instead of toasting success. Committing the
      // fresh list above also drops the dead discovery row from the page.
      if (fresh && !list.some((row) => agentFamily(row.id, row.family) === family)) {
        setConnectedFamilies(before);
        writeConnectedFamilies(before);
        setConnectError(
          tr("agents.connectFailed", {
            name: a.name || a.id,
            reason: tr("agents.connectMissing"),
          }),
        );
        return;
      }
      setConnectFor(null);
      pushToast(tr("agents.connectedToast", { name: a.name || a.id }), "info");
    } catch (e) {
      // A canceled attempt already restored the catalog; its failure has no
      // dialog left to explain it.
      if (attempt !== connectAttempt.current) return;
      setConnectedFamilies(before);
      writeConnectedFamilies(before);
      setConnectError(tr("agents.connectFailed", { name: a.name || a.id, reason: messageOf(e) }));
    } finally {
      if (attempt === connectAttempt.current) setConnecting(false);
    }
  }

  /** Close the connect sheet, undoing an optimistic add still in flight. */
  function closeConnect() {
    if (connecting) {
      connectAttempt.current += 1;
      setConnectedFamilies(connectBefore.current);
      writeConnectedFamilies(connectBefore.current);
      setConnecting(false);
    }
    setConnectError(null);
    setConnectFor(null);
  }

  /** Free a slot held by a family this machine no longer reports. */
  function removeFamily(family: string) {
    const next = families.filter((f) => f !== family);
    setConnectedFamilies(next);
    writeConnectedFamilies(next);
  }

  function removeFromCatalog(a: AgentInfo) {
    const family = agentFamily(a.id, a.family);
    const next = families.filter((f) => f !== family);
    setConnectedFamilies(next);
    writeConnectedFamilies(next);
    pushToast(tr("agents.removedToast", { name: a.name || a.id }), "info");
  }

  /**
   * What can be done to one agent, written once.
   *
   * The table's row menu and the phone's action sheet are two shapes of one
   * list, and the conditions are not obvious: "ask the default Agent" exists
   * only while the product is *not* installed, "copy the update command" only
   * once it is, and sign-in only when the probe says the credential is stale.
   * Spelled twice, the two surfaces disagree the first time a condition changes.
   */
  function agentActions(a: AgentInfo): AgentAction[] {
    const m = mgmtById.get(a.id);
    const busy = checkingFor(a);
    const actions: AgentAction[] = [];

    actions.push({
      key: "recheck",
      label: tr("agents.recheck"),
      disabled: busy || offline,
      hint: offline ? tr("agents.offlineAction") : undefined,
      run: () => void recheckOne(a),
    });
    if (a.installed) {
      actions.push({
        key: "smoke",
        label: tr("agents.smokeOne"),
        disabled: busy || offline,
        hint: offline ? tr("agents.offlineAction") : undefined,
        run: () => void runSmoke([a.id]),
      });
    }
    if (m?.auth_status === "not_signed_in") {
      actions.push({
        key: "signIn",
        label: tr("agents.askSignIn"),
        hint: tr("agents.askSignInHint"),
        primary: true,
        disabled: offline,
        run: () => askDefaultAgentToSignIn(a, m),
      });
    }
    if (a.available && !isDefaultFamily(a)) {
      actions.push({
        key: "default",
        label: tr("agents.setDefault"),
        primary: true,
        disabled: offline || busy,
        run: () => void onSetDefault(a.id),
      });
    }
    if (!a.installed && a.install_url) {
      actions.push({
        key: "install",
        label: tr("agentCatalog.install"),
        hint: tr("agentCatalog.installHint"),
        primary: true,
        run: () => openInstallURL(a.install_url),
      });
    }
    const installCmd = m?.install_cmd;
    if (installCmd) {
      if (!a.installed) {
        actions.push({
          key: "askInstall",
          label: tr("agents.askInstall"),
          hint: tr("agents.askInstallHint"),
          disabled: offline,
          run: () => askDefaultAgentToInstall(a, installCmd),
        });
      }
      actions.push({
        key: "copyInstall",
        label: tr("agents.copyInstall"),
        run: () => void copyText(installCmd),
      });
    }
    const updateCmd = m?.update_cmd;
    if (updateCmd && a.installed) {
      actions.push({
        key: "copyUpdate",
        label: tr("agents.copyUpdate"),
        run: () => void copyText(updateCmd),
      });
    }
    actions.push({
      key: "remove",
      label: tr("agents.remove"),
      hint: isDefaultFamily(a) ? tr("agents.removeDefaultHint") : tr("agents.removeHint"),
      disabled: isDefaultFamily(a),
      run: () => removeFromCatalog(a),
    });
    return actions;
  }

  // The sheet's target and its actions, read from the same list the phone rows
  // render: an agent that a refresh drops takes its sheet with it.
  const actionAgent = actionsFor ? (sortedCatalog.find((a) => a.id === actionsFor) ?? null) : null;
  const actionItems = actionAgent ? agentActions(actionAgent) : [];

  const smokeFailures =
    smokeReport && "results" in smokeReport
      ? smokeReport.results.filter((r) => !r.skipped && !r.ok)
      : [];
  const smokeTone = smokeReport
    ? "error" in smokeReport
      ? "bad"
      : smokeFailures.length > 0
        ? "bad"
        : "ok"
    : null;

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden kin-scroll">
      <div className="max-w-page-wide mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {embedded ? null : (
              <h1 className="hidden text-hero font-bold tracking-tight md:block">
                {tr("agents.title")}
              </h1>
            )}
            <p className="text-body text-kin-muted">{tr("agents.subtitle")}</p>
            {agents !== null && (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-kin-muted">
                <span>
                  {tr("agents.connectedCount", {
                    // Occupied slots, including a product this machine stopped
                    // reporting: the header and the cap must count the same
                    // thing, or it offers two free slots that connect refuses.
                    count: storedFamilies,
                    limit: CATALOG_LIMIT,
                  })}
                </span>
                {plan.discovered.length > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{tr("agents.discoveredCount", { count: plan.discovered.length })}</span>
                    <button
                      type="button"
                      className="inline-flex items-center text-kin-blue-ink hover:underline max-md:min-h-11 md:min-h-6"
                      aria-expanded={showDiscovered}
                      onClick={() => setShowDiscovered((open) => !open)}
                    >
                      {showDiscovered ? tr("agents.hideDiscovered") : tr("agents.viewDiscovered")}
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="kin-btn-secondary min-h-11 px-3 text-strong"
              disabled={checkingAll || smokingAll || offline}
              title={offline ? tr("agents.offlineAction") : undefined}
              onClick={() => void onRecheck()}
            >
              {checkingAll ? tr("common.loading") : tr("agents.recheckAll")}
            </button>
            <button
              type="button"
              className="kin-btn-secondary min-h-11 px-3 text-strong"
              disabled={smokingAll || checkingAll || offline}
              title={offline ? tr("agents.offlineAction") : tr("agents.smokeHint")}
              onClick={() => void runSmoke()}
            >
              {smokingAll ? tr("agents.smoking") : tr("agents.smokeAll")}
            </button>
            <button
              type="button"
              className="kin-btn-secondary min-h-11 px-3 text-strong"
              disabled={importing || offline || agents === null}
              title={tr("agents.importHint")}
              onClick={() => void onImport()}
            >
              {importing ? tr("common.loading") : tr("agents.importSessions")}
            </button>
            <RangePicker value={days} onChange={setDays} />
          </div>
        </div>

        {offline && (
          <div
            className="mt-4 rounded-xl bg-kin-elevated px-4 py-2.5 text-body text-kin-secondary"
            role="status"
          >
            {tr("agents.offline", {
              time: lastLoadedAt ? clock(lastLoadedAt) : "—",
            })}
          </div>
        )}

        {actionError && (
          <div
            className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-kin-red/40 bg-kin-red/10 px-4 py-2.5 text-body text-kin-red-ink"
            role="alert"
          >
            <span>{actionError}</span>
            <button
              type="button"
              className="shrink-0 hover:underline"
              onClick={() => setActionError(null)}
            >
              {tr("agents.dismiss")}
            </button>
          </div>
        )}

        {(rows === null || agents === null) && !error && !usageError && (
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

        {rows === null && usageError && !error && (
          <div
            className="mt-6 flex items-start justify-between gap-3 rounded-xl border border-kin-orange/40 bg-kin-orange/10 px-4 py-2.5 text-body text-kin-orange-ink"
            role="alert"
          >
            <span>{usageError}</span>
            <button
              type="button"
              className="shrink-0 hover:underline"
              onClick={() => void loadUsage(daysRef.current)}
            >
              {tr("common.retry")}
            </button>
          </div>
        )}

        {error && (
          <div
            className="mt-6 flex items-start justify-between gap-3 rounded-xl border border-kin-red/40 bg-kin-red/10 px-4 py-3 text-strong leading-5 text-kin-red-ink"
            role="alert"
          >
            <span>{error}</span>
            <button
              type="button"
              className="shrink-0 hover:underline"
              onClick={() => {
                setError(null);
                void loadAgents();
                void loadUsage(rangeRef.current);
              }}
            >
              {tr("common.retry")}
            </button>
          </div>
        )}

        {rows !== null && (
          <div className="mt-6 space-y-6" aria-busy={updating}>
            {usageError && (
              <div
                className="rounded-xl border border-kin-orange/40 bg-kin-orange/10 px-4 py-2.5 text-body text-kin-orange-ink"
                role="alert"
              >
                {usageError}
              </div>
            )}
            <div
              className={`grid grid-cols-2 gap-3 sm:grid-cols-4 ${updating ? "opacity-60" : ""}`}
            >
              {[
                { label: tr("usage.spend"), value: totals.empty ? "—" : formatCost(totals.cost) },
                {
                  label: tr("usage.tokens"),
                  value: totals.empty ? "—" : formatTokenCount(totals.tokens),
                },
                {
                  label: tr("usage.cacheHitRate"),
                  value: totals.empty
                    ? "—"
                    : cacheRateLabel(
                        totals.cacheStatus,
                        totals.cacheEligible > 0 ? totals.cacheRead / totals.cacheEligible : null,
                      ),
                },
                {
                  label: tr("usage.tasks"),
                  value: totals.empty ? "—" : String(totals.tasks),
                },
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
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-strong font-medium text-kin-muted">
                  {tr("usage.dailySpend")}
                </span>
                {updating && (
                  <span className="text-caption text-kin-muted" role="status">
                    {tr("agents.intervalUpdating")}
                  </span>
                )}
              </div>
              <div className={`flex items-stretch gap-1.5 h-28 ${updating ? "opacity-60" : ""}`}>
                {totals.byDay.length === 0 && (
                  <p className="text-strong leading-5 text-kin-muted">{tr("agents.emptyUsage")}</p>
                )}
                {totals.byDay.map(([date, cost]) => (
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

        {agents !== null && plan.connected.length === 0 && (
          <div className="mt-6 rounded-xl bg-kin-elevated px-4 py-5">
            <p className="text-strong font-medium text-kin-text">{tr("agents.emptyAgents")}</p>
            <p className="mt-1 text-body text-kin-muted">{tr("agents.emptyAgentsHint")}</p>
            {plan.discovered.length > 0 && (
              <button
                type="button"
                className="kin-btn-secondary mt-3 min-h-11 px-3 text-strong"
                onClick={() => setShowDiscovered(true)}
              >
                {tr("agents.installEntry")}
              </button>
            )}
            {plan.discovered.length === 0 && installSuggestions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {installSuggestions.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="kin-btn-secondary min-h-11 px-3 text-strong"
                    onClick={() => openInstallURL(a.install_url)}
                  >
                    {tr("agents.installNamed", { name: a.name })}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {smokeReport && (
          <div
            className={[
              "mt-6 rounded-xl border px-4 py-3 text-strong",
              smokeTone === "bad"
                ? "border-kin-red/40 bg-kin-red/10 text-kin-red-ink"
                : "border-kin-green/40 bg-kin-green/10 text-kin-green-ink",
            ].join(" ")}
            role={smokeTone === "bad" ? "alert" : "status"}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                {smokeReport && "error" in smokeReport ? (
                  <p>{tr("agents.smokeError", { reason: smokeReport.error })}</p>
                ) : smokeReport && "results" in smokeReport ? (
                  <SmokeLines report={smokeReport.results} />
                ) : null}
              </div>
              <button
                type="button"
                className="shrink-0 hover:underline"
                onClick={() => setSmokeReport(null)}
              >
                {tr("agents.dismiss")}
              </button>
            </div>
          </div>
        )}

        {agents !== null && plan.connected.length > 0 && (
          <div className="mt-6">
            {/* The phone gets the same title from `MobileSection`; two
                headings over one list is a duplicate a reader has to skip. */}
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 max-md:hidden">
              <h2 className="text-strong font-medium text-kin-text">{tr("agents.catalog")}</h2>
              <p className="text-caption text-kin-muted">{tr("agents.catalogHint")}</p>
            </div>
            <div className="overflow-x-auto rounded-xl bg-kin-elevated max-md:hidden">
              <table className="w-full text-left text-strong md:min-w-table">
                <thead className="bg-[var(--kin-fill)] text-caption uppercase tracking-label text-kin-muted">
                  <tr>
                    <SortTh
                      colKey="name"
                      active={sortKey === "name"}
                      dir={sortDir}
                      onSort={toggleSort}
                    >
                      {tr("agents.colName")}
                    </SortTh>
                    <SortTh
                      colKey="status"
                      active={sortKey === "status"}
                      dir={sortDir}
                      onSort={toggleSort}
                    >
                      {tr("agents.colStatus")}
                    </SortTh>
                    <SortTh
                      colKey="version"
                      active={sortKey === "version"}
                      dir={sortDir}
                      onSort={toggleSort}
                      className="hidden md:table-cell"
                    >
                      {tr("agents.version")}
                    </SortTh>
                    <SortTh
                      colKey="auth"
                      active={sortKey === "auth"}
                      dir={sortDir}
                      onSort={toggleSort}
                      className="hidden md:table-cell"
                    >
                      {tr("agents.colAuth")}
                    </SortTh>
                    <SortTh
                      colKey="cost"
                      active={sortKey === "cost"}
                      dir={sortDir}
                      onSort={toggleSort}
                      align="right"
                      className="hidden md:table-cell"
                    >
                      {tr("usage.spend")}
                    </SortTh>
                    <SortTh
                      colKey="tokens"
                      active={sortKey === "tokens"}
                      dir={sortDir}
                      onSort={toggleSort}
                      align="right"
                      className="hidden md:table-cell"
                    >
                      {tr("usage.tokens")}
                    </SortTh>
                    <SortTh
                      colKey="tasks"
                      active={sortKey === "tasks"}
                      dir={sortDir}
                      onSort={toggleSort}
                      align="right"
                      className="hidden md:table-cell"
                    >
                      {tr("usage.tasks")}
                    </SortTh>
                    {limitStatuses !== null && (
                      <th className="hidden px-3 py-2.5 font-semibold text-left whitespace-nowrap text-kin-muted md:table-cell">
                        {tr("agents.colLimits")}
                      </th>
                    )}
                    <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap text-kin-muted">
                      {tr("agents.actions")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--kin-hairline)]">
                  {sortedCatalog.map((a) => {
                    const state = agentCatalogState(a);
                    const m = mgmtFor(a);
                    const usage = usageByFamily.get(familyOf(a.id));
                    const limitStatus = limitsByFamily.get(familyOf(a.id));
                    const checking = checkingFor(a);
                    const status = rowStatus(a, checking);
                    const spendProgress =
                      limitStatus?.limit_spend_usd != null
                        ? agentLimitProgress(
                            limitStatus.used_spend_usd,
                            limitStatus.limit_spend_usd,
                          )
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
                    const quota = quotaInfo(limitStatus);
                    const kindBadge =
                      state === "native"
                        ? tr("agentCatalog.native")
                        : state === "generic"
                          ? tr("agentCatalog.generic")
                          : null;
                    const toneClass =
                      status.tone === "ok"
                        ? "text-kin-green-ink"
                        : status.tone === "warn"
                          ? "text-kin-orange-ink"
                          : status.tone === "bad"
                            ? "text-kin-red-ink"
                            : "text-kin-muted";
                    return (
                      <tr key={a.id} className="align-top hover:bg-[var(--kin-fill)]">
                        <td className="px-3 py-3 md:min-w-cell">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-kin-text">{a.name}</span>
                            {isDefaultFamily(a) ? (
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
                            <div className="mt-0.5 font-mono text-caption text-kin-muted">
                              {a.id}
                            </div>
                          ) : null}
                        </td>
                        <td
                          className={`px-3 py-3 whitespace-nowrap ${toneClass}`}
                          title={status.title || undefined}
                        >
                          {status.label}
                        </td>
                        <td className="hidden px-3 py-3 whitespace-nowrap tabular-nums text-kin-secondary md:table-cell">
                          {m?.version || "—"}
                        </td>
                        <td
                          className="hidden px-3 py-3 whitespace-nowrap text-kin-secondary md:table-cell"
                          title={m?.auth_detail || tr("agents.authHint")}
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
                        {limitStatuses !== null && (
                          <td className="hidden px-3 py-3 md:table-cell">
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
                              {quota ? (
                                <span
                                  className="text-caption text-kin-orange-ink"
                                  title={quota.label}
                                  aria-label={quota.label}
                                >
                                  {quota.line}
                                </span>
                              ) : null}
                              {!spendProgress && !tokensProgress && !quota ? (
                                <span className="text-caption text-kin-muted">—</span>
                              ) : null}
                            </div>
                          </td>
                        )}
                        <td className="px-3 py-3 whitespace-nowrap text-right">
                          <RowMenu
                            name={a.name}
                            actions={agentActions(a)}
                            open={menuFor === a.id}
                            onOpenChange={(open) => setMenuFor(open ? a.id : null)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* The phone's copy of the same list. One row per agent and one `…`
                that opens the same actions in a sheet, from `agentActions`
                above so the two layouts cannot disagree about what exists. */}
            <div className="-mx-4 md:hidden">
              <MobileSection title={tr("agents.catalog")}>
                <MobileCard>
                  {sortedCatalog.map((a) => {
                    const actions = agentActions(a);
                    const usage = usageByFamily.get(familyOf(a.id));
                    const status = rowStatus(a, checkingFor(a));
                    const limitStatus = limitsByFamily.get(familyOf(a.id));
                    const m = mgmtFor(a);
                    const quota = quotaInfo(limitStatus)?.detail ?? null;
                    const detail = [
                      m?.version,
                      status.label,
                      authLabel(m?.auth_status),
                      !a.installed ? tr("agents.installToUse") : null,
                      usage ? formatCost(usage.cost) : null,
                      usage ? tr("agents.tasksCount", { count: usage.tasks }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <MobileRow
                        key={a.id}
                        title={
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{a.name}</span>
                            {isDefaultFamily(a) ? (
                              <span className="flex-none rounded-full bg-kin-blue/15 px-1.5 py-0.5 text-micro font-semibold text-kin-blue-ink">
                                {tr("agents.isDefault")}
                              </span>
                            ) : null}
                          </span>
                        }
                        detail={
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{detail}</span>
                            {quota ? (
                              <span className="truncate text-kin-orange-ink">{quota}</span>
                            ) : null}
                          </span>
                        }
                        trailing={
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
                        }
                        className={actions.length === 0 ? "opacity-50" : undefined}
                      />
                    );
                  })}
                </MobileCard>
              </MobileSection>
            </div>
          </div>
        )}

        {/* A stored family this machine has stopped reporting still holds one
            of the ten slots; without a way to remove it the catalog would sit
            full forever. */}
        {/* While the first read is in flight, the empty agent list makes every
            stored family look missing; the section is only true once the
            machine has answered. */}
        {agents !== null && plan.missing.length > 0 && (
          <section className="mt-4 rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated px-4 py-3">
            <p className="text-body font-medium text-kin-text">
              {tr("agents.missingTitle", { count: plan.missing.length })}
            </p>
            <p className="mt-1 text-caption text-kin-muted">{tr("agents.missingHint")}</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {plan.missing.map((family) => (
                <li
                  key={family}
                  className="flex items-center gap-2 rounded-full bg-[var(--kin-fill)] px-3 py-1 text-caption text-kin-secondary"
                >
                  <span className="font-mono">{family}</span>
                  <button
                    type="button"
                    className="inline-flex items-center text-kin-blue-ink hover:underline max-md:min-h-11 md:min-h-6"
                    aria-label={tr("agents.removeNamed", { name: family })}
                    onClick={() => removeFamily(family)}
                  >
                    {tr("agents.remove")}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Discovery lives below the catalog on both surfaces. It is a prompt,
            not a second list: nothing here is part of the catalog until the
            confirmation below returns. */}
        {showDiscovered && plan.discovered.length > 0 && (
          <section className="mt-6 rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated px-4 py-3 max-md:-mx-2 max-md:rounded-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-strong font-medium text-kin-text">
                  {tr("agents.discoveredTitle")}
                </h2>
                <p className="mt-1 text-body text-kin-muted">{tr("agents.discoveredHint")}</p>
              </div>
              <button
                type="button"
                className="inline-flex min-h-11 shrink-0 items-center px-1 text-body text-kin-blue-ink hover:underline"
                onClick={() => setShowDiscovered(false)}
              >
                {tr("agents.hideDiscovered")}
              </button>
            </div>
            <ul className="mt-2 divide-y divide-[var(--kin-hairline)]">
              {plan.discovered.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-strong text-kin-text">{a.name}</div>
                    <div className="truncate text-caption text-kin-muted" title={a.reason}>
                      {a.reason || tr("agents.notConnected")}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="kin-btn-secondary min-h-11 shrink-0 px-3 text-strong"
                    disabled={offline || full}
                    title={full ? tr("agents.connectFull") : undefined}
                    onClick={() => beginConnect(a)}
                  >
                    {tr("agents.connect")}
                  </button>
                </li>
              ))}
            </ul>
            {full && (
              <p className="mt-2 text-caption text-kin-orange-ink">{tr("agents.connectFull")}</p>
            )}
          </section>
        )}

        <Sheet
          open={connectFor !== null}
          // Cancel stays available while the machine is being asked: a hung
          // read must not lock the page in a modal it will not dismiss. The
          // request finishes on its own and still rolls back on failure.
          onClose={closeConnect}
          dialog
          title={connectFor ? tr("agents.connectTitle", { name: connectFor.name }) : undefined}
          footer={
            <>
              <SheetPrimaryButton
                onClick={() => void confirmConnect()}
                disabled={connecting || full || offline || !connectFor}
              >
                {connecting
                  ? tr("agents.connecting")
                  : connectFor
                    ? tr("agents.connectAction", { name: connectFor.name })
                    : tr("agents.connect")}
              </SheetPrimaryButton>
              <SheetSecondaryButton onClick={closeConnect}>
                {tr("common.cancel")}
              </SheetSecondaryButton>
            </>
          }
        >
          {connectFor && (
            <div className="space-y-3">
              <p className="text-body leading-5 text-kin-secondary">
                {tr("agents.connectIntro", { name: connectFor.name })}
              </p>
              <div className="rounded-xl border border-kin-blue/30 bg-kin-blue/5 px-3 py-2.5">
                <p className="text-strong font-medium text-kin-text">
                  {tr("agents.connectWillTitle")}
                </p>
                <p className="mt-1 text-body leading-5 text-kin-secondary">
                  {tr("agents.connectWillBody")}
                </p>
              </div>
              <div className="rounded-xl border border-kin-orange/30 bg-kin-orange/5 px-3 py-2.5">
                <p className="text-strong font-medium text-kin-text">
                  {tr("agents.connectWontTitle")}
                </p>
                <p className="mt-1 text-body leading-5 text-kin-secondary">
                  {tr("agents.connectWontBody", { name: connectFor.name })}
                </p>
              </div>
              <p className="text-caption text-kin-muted">
                {tr("agents.connectCapNote", {
                  count: storedFamilies,
                  limit: CATALOG_LIMIT,
                  next: Math.min(storedFamilies + 1, CATALOG_LIMIT),
                })}
              </p>
              {full && (
                <p className="text-body text-kin-orange-ink" role="alert">
                  {tr("agents.connectFull")}
                </p>
              )}
              {offline && (
                <p className="text-body text-kin-orange-ink" role="status">
                  {tr("agents.offlineAction")}
                </p>
              )}
              {connectError && (
                <p className="text-body text-kin-red-ink" role="alert">
                  {connectError}
                </p>
              )}
            </div>
          )}
        </Sheet>

        <Sheet
          open={actionAgent !== null}
          onClose={() => setActionsFor(null)}
          onCloseComplete={() => {
            const action = sheetAction.current;
            sheetAction.current = null;
            action?.();
          }}
          title={actionAgent?.name}
          subtitle={
            actionAgent ? rowStatus(actionAgent, checkingFor(actionAgent)).label : undefined
          }
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
              disabled={action.disabled}
              title={action.hint}
              onClick={() => {
                sheetAction.current = action.run;
                setActionsFor(null);
              }}
              className="kin-row-press flex min-h-12 w-full items-center rounded-xl px-3 text-left text-subtitle text-kin-text disabled:text-kin-muted disabled:opacity-60"
            >
              <span className="flex min-w-0 flex-col items-start">
                <span>{action.label}</span>
                {/* A disabled action's `title` is unreachable on a phone; the
                    reason has to be on the surface the person is touching. */}
                {action.disabled && action.hint ? (
                  <span className="text-caption text-kin-muted">{action.hint}</span>
                ) : null}
              </span>
            </button>
          ))}
        </Sheet>
      </div>
    </div>
  );
}

/**
 * One sortable header.
 *
 * It lives at module scope on purpose: a component declared inside the page is
 * a new component type on every render, so React remounts the header subtree
 * and the button a keyboard user just activated loses focus. The visible cost
 * is small and the focus loss is not.
 */
function SortTh({
  colKey,
  active,
  dir,
  onSort,
  children,
  className = "",
  align = "left",
}: {
  colKey: AgentSortKey;
  active: boolean;
  dir: AgentSortDir;
  onSort: (key: AgentSortKey) => void;
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <th
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`px-3 py-2.5 font-semibold whitespace-nowrap ${
        align === "right" ? "text-right" : "text-left"
      } ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(colKey)}
        className={`inline-flex items-center gap-0.5 hover:text-kin-text ${
          active ? "text-kin-text" : "text-kin-muted"
        }`}
      >
        {children}
        <span className="tabular-nums text-micro w-3">
          {active ? (dir === "asc" ? " ↑" : " ↓") : ""}
        </span>
      </button>
    </th>
  );
}

/** A usage interval with three stops, reachable with ←/→. */
function RangePicker({
  value,
  onChange,
}: {
  value: UsageDays;
  onChange: (next: UsageDays) => void;
}) {
  const tr = useT();
  const refs = useRef(new Map<UsageDays, HTMLButtonElement | null>());
  const RANGES: UsageDays[] = [7, 30, 90];
  const label = (d: UsageDays) =>
    d === 7 ? tr("usage.thisWeek") : d === 30 ? tr("usage.days30") : tr("usage.days90");

  function move(delta: number) {
    const at = RANGES.indexOf(value);
    const next = RANGES[(at + delta + RANGES.length) % RANGES.length];
    onChange(next);
    requestAnimationFrame(() => refs.current.get(next)?.focus());
  }

  return (
    <div
      role="radiogroup"
      aria-label={tr("agents.rangeLabel")}
      className="flex min-h-11 items-stretch rounded-xl bg-kin-elevated p-1"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {RANGES.map((d) => (
        <button
          key={d}
          ref={(el) => {
            refs.current.set(d, el);
          }}
          type="button"
          role="radio"
          aria-checked={value === d}
          tabIndex={value === d ? 0 : -1}
          onClick={() => onChange(d)}
          className={[
            "min-h-11 rounded-lg px-3 text-body",
            value === d
              ? "bg-kin-elevated font-semibold text-kin-text shadow-e1"
              : "text-kin-muted hover:text-kin-text",
          ].join(" ")}
        >
          {label(d)}
        </button>
      ))}
    </div>
  );
}

/**
 * The desktop row's one control.
 *
 * The table is thirteen columns wide and the action cell is the last one; four
 * inline links there were the thing that made the phone layout legible only by
 * scrolling. A menu keeps the row one line, and its keyboard contract is the
 * frame's: focus enters the menu, Esc closes it and puts focus back on the
 * button that opened it.
 */
function RowMenu({
  name,
  actions,
  open,
  onOpenChange,
}: {
  name: string;
  actions: AgentAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tr = useT();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const changeRef = useRef(onOpenChange);
  changeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const items = () => [
      ...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
    ];

    items()[0]?.focus();

    function close() {
      changeRef.current(false);
      buttonRef.current?.focus();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      const list = items();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        list[(index + 1 + list.length) % list.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        list[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        list[list.length - 1]?.focus();
      }
    }
    function onPointer(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      changeRef.current(false);
    }

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className="relative inline-block text-left">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${tr("agents.actions")} — ${name}`}
        onClick={() => onOpenChange(!open)}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--kin-hairline-strong)] bg-kin-elevated text-strong text-kin-secondary hover:text-kin-text"
      >
        ⋯
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${tr("agents.actions")} — ${name}`}
          className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-[var(--kin-hairline-strong)] bg-kin-elevated py-1 text-left shadow-e3"
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              title={action.hint}
              onClick={() => {
                onOpenChange(false);
                action.run();
                buttonRef.current?.focus();
              }}
              className={[
                "flex min-h-9 w-full items-center px-3 text-left text-body hover:bg-[var(--kin-fill)] disabled:text-kin-muted disabled:opacity-60",
                action.primary ? "text-kin-blue-ink" : "text-kin-text",
              ].join(" ")}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SmokeLines({ report }: { report: AgentSmokeResult[] }) {
  const tr = useT();
  const ran = report.filter((r) => !r.skipped);
  const failed = ran.filter((r) => !r.ok);
  const skipped = report.length - ran.length;
  const ok = ran.length - failed.length;
  return (
    <>
      <p className="font-medium">
        {failed.length > 0
          ? tr("agents.smokeSummary", {
              ok,
              fail: failed.length,
              skipped,
            })
          : tr("agents.smokeAllPassed", { ok, skipped })}
      </p>
      {failed.length > 0 && (
        <p className="text-body leading-5">
          {tr("agents.smokeFailures", {
            items: failed
              .map((r) => `${r.name || r.id}${r.detail ? ` — ${brief(r.detail)}` : ""}`)
              .join("; "),
          })}
        </p>
      )}
    </>
  );
}

function brief(detail: string): string {
  const oneLine = detail.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine;
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : String(error);
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
