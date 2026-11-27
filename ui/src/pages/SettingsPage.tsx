import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ApiError,
  activateProvider,
  createProvider,
  deleteProvider,
  getSettings,
  listAgentProviders,
  listAgents,
  listProviderModels,
  listProviders,
  updateProvider,
  updateSettings,
  type AgentInfo,
  type AgentProvider,
  type ModelSpec,
  type ProviderEntry,
  type Settings,
} from "../api/client";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { MobileEmpty } from "../components/mobile/MobileList";
import { IconAlert } from "../components/icons";
import {
  AGENT_ROLES_CHANGED_EVENT,
  parseAgentRoles,
  serializeAgentRoles,
  type AgentRole,
} from "../lib/agentRoles";
import { importToast } from "../lib/agentSessionImport";
import { useAgentSessionImport } from "../hooks/useAgentSessionImport";
import { refreshMachines } from "../hooks/useMachines";
import {
  LocalAgentSettingsSection,
  type AgentProvidersStatus,
} from "../components/settings/LocalAgentSettingsSection";
import {
  ProviderSettingsSection,
  type AgentCatalogStatus,
} from "../components/settings/ProviderSettingsSection";
import { AccountSection } from "../components/settings/AccountSection";
import { PushPermissionRow } from "../components/settings/PushPermissionRow";
import {
  RoutingDefaultsSection,
  RoutingProfilesSection,
} from "../components/settings/RoutingSettings";
import {
  SettingsLayout,
  SettingsRow,
  SettingsSection,
  SettingsTabPanel,
  type SettingsTabItem,
} from "../components/settings/SettingsPrimitives";
import Button from "../components/ui/Button";
import TextArea from "../components/ui/TextArea";
import { normalizeSettingsTab, type SettingsTabId } from "../lib/areaNavigation";
import { useSlowHint } from "../hooks/useSlowHint";
import { useLeaveGuard } from "../hooks/useLeaveGuard";
import { runGuardedNavigation } from "../lib/leaveGuard";
import { applyTheme, getThemeMode, setThemeMode, type ThemeMode } from "../lib/theme";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";
import AgentsPage from "./AgentsPage";

type SettingsDraft = {
  priceTable: string;
  agentLimits: string;
  roles: AgentRole[];
  agentDefault: string;
  limitPolicy: string;
  limitFallback: string;
};

function prettyJSON(raw: string | undefined, fallback: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || fallback), null, 2);
  } catch {
    return raw ?? fallback;
  }
}

/**
 * The URL that names a panel.
 *
 * Selecting a tab is a same-screen state change, so it rewrites the current
 * entry instead of stacking one per tab. Unrelated parameters are preserved:
 * only the one this page owns is written.
 */
function settingsTabPath(tab: SettingsTabId, pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  if (tab === "general") params.delete("tab");
  else params.set("tab", tab);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

// Compare the role rows that are visible, not the serializer's output. A
// half-written name or prompt is still unsaved work even though Save drops it.
function agentRolesDraftKey(roles: readonly AgentRole[]): string {
  return JSON.stringify(roles.map((role) => [role.id, role.name, role.prompt]));
}

function settingsDraftKey(value: SettingsDraft): string {
  return JSON.stringify([
    value.priceTable,
    value.agentLimits,
    agentRolesDraftKey(value.roles),
    value.agentDefault,
    value.limitPolicy,
    value.limitFallback,
  ]);
}

function settingsDraftFromServer(settings: Settings): SettingsDraft {
  return {
    priceTable: prettyJSON(settings.price_table, "{}"),
    agentLimits: prettyJSON(settings.agent_limits, "{}"),
    roles: parseAgentRoles(settings.agent_roles),
    agentDefault: settings["agent.default"] ?? "",
    limitPolicy: (settings.limit_policy as string) || "wait",
    limitFallback: settings["limit_policy.fallback_agents"] || "[]",
  };
}

type ProviderDraft = {
  name: string;
  base: string;
  key: string;
  model: string;
  stream: boolean;
  keyDirty: boolean;
  supportsAgents: string;
  models: ModelSpec[];
};

function providerDraftKey(value: ProviderDraft): string {
  return JSON.stringify([
    value.name,
    value.base,
    value.key,
    value.model.trim(),
    value.stream,
    value.keyDirty,
    value.supportsAgents
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    value.models,
  ]);
}

export default function SettingsPage() {
  const tr = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [priceTable, setPriceTable] = useState("");
  const [agentLimitsText, setAgentLimitsText] = useState("");
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [limitPolicy, setLimitPolicy] = useState("wait");
  const [limitFallbackText, setLimitFallbackText] = useState("[]");
  // One flag for every control that starts an import, from the hook rather than
  // from this page: the sidebar offers the same errand, and a page-local flag
  // left that button live while this one was already importing.
  const { importing: importingEveryMachine, importEveryMachine } = useAgentSessionImport();
  const [refreshingAgentCatalog, setRefreshingAgentCatalog] = useState(false);
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [activeProviderId, setActiveProviderId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null); // null = closed, "" = new
  const [provName, setProvName] = useState("");
  const [provBase, setProvBase] = useState("");
  const [provKey, setProvKey] = useState("");
  const [provModel, setProvModel] = useState("");
  const [provStream, setProvStream] = useState(false);
  const [provKeyDirty, setProvKeyDirty] = useState(false);
  const [provBusy, setProvBusy] = useState(false);
  const [provModelOptions, setProvModelOptions] = useState<string[]>([]);
  const [provModelLoading, setProvModelLoading] = useState(false);
  const [provModelError, setProvModelError] = useState<string | null>(null);
  const [provSupportsAgents, setProvSupportsAgents] = useState("");
  const [provModels, setProvModels] = useState<ModelSpec[]>([]);
  const [showRouting, setShowRouting] = useState(false);
  const [agentDefault, setAgentDefault] = useState("");
  // One state machine for the agent catalog. Six call sites used to repeat
  // `listAgents().then(setAgentList).catch(() => undefined)`, which had no
  // loading and no failure state: the default-agent row offered a one-option
  // list until the read landed, and stayed that way forever when it failed.
  const [agentCatalog, setAgentCatalog] = useState<{
    status: AgentCatalogStatus;
    agents: AgentInfo[];
  }>({ status: "loading", agents: [] });
  const [agentProviders, setAgentProviders] = useState<AgentProvider[]>([]);
  // The provider read is the agents tab's own. It has a status and a reason so
  // a first read that fails says so and offers a retry, and a re-probe that
  // fails keeps the rows already on screen (KIN-AGENTS-002 D1).
  const [agentProvidersStatus, setAgentProvidersStatus] = useState<AgentProvidersStatus>("loading");
  const [agentProvidersError, setAgentProvidersError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The read's own failure. `error` keeps its meaning (a page-level action
  // failed), but a failed read is a state of the page, not an action result: a
  // first read has to name itself and offer a retry, and a reconnect reload
  // that fails has to keep the loaded form on screen and say the link dropped.
  // Pasting the daemon's raw text into the page banner did neither.
  const [loadError, setLoadError] = useState<string | null>(null);
  // One error line per general-tab group. A failure belongs under the Save
  // button whose group caused it, not on every group and the page banner at
  // once; the shared `error` above stays for the page-level failures (load,
  // import, provider) that are not tied to one group.
  const [priceError, setPriceError] = useState<string | null>(null);
  const [agentLimitsError, setAgentLimitsError] = useState<string | null>(null);
  const [limitPolicyError, setLimitPolicyError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => getThemeMode());
  // The panel follows the router, not a one-time read of `window.location`: a
  // notification tap can name `?tab=` while this page is already mounted, and
  // React Router keeps the component rather than remounting it. Choosing a tab
  // writes the URL too, so the page and `NotificationTaps` agree on what is on
  // screen (it compares a tap with the current URL).
  //
  // A tab switch does not discard drafts, so it does not ask the leave guard:
  // every panel stays mounted (`hidden` in `SettingsTabPanel`) and its local
  // state survives. Leaving Settings still asks through `useLeaveGuard`.
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() =>
    normalizeSettingsTab(new URLSearchParams(location.search).get("tab")),
  );
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    // Absent `tab` is General (the settings root). A General notification is
    // canonicalized to `/settings`, and a sidebar or palette trip to the
    // root must show that panel. Drafts survive because every panel stays
    // mounted (`hidden` in `SettingsTabPanel`).
    setActiveTab(normalizeSettingsTab(params.get("tab")));
  }, [location.search]);
  const selectTab = useCallback(
    (tab: SettingsTabId) => {
      const path = settingsTabPath(tab, location.pathname, location.search);
      // Pop an armed leave-guard sentinel before the same-pathname replace so
      // a dirty tab switch does not bury a Settings entry under a new sentinel.
      if (!runGuardedNavigation(() => navigate(path, { replace: true }), true)) return;
      setActiveTab(tab);
    },
    [navigate, location.pathname, location.search],
  );
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const online = wsStatus !== "disconnected";
  const pushToast = useAppStore((s) => s.pushToast);
  // The slow hint belongs under the skeleton only; over a named failure it
  // would sit under the retry and read as a second answer to the same wait.
  const slow = useSlowHint(!settings && !loadError);
  const [settingsBaseline, setSettingsBaseline] = useState<string | null>(null);
  const [providerBaseline, setProviderBaseline] = useState<string | null>(null);
  const [routingDirty, setRoutingDirty] = useState({ defaults: false, profiles: false });

  const settingsDraftValues: SettingsDraft = {
    priceTable,
    agentLimits: agentLimitsText,
    roles,
    agentDefault,
    limitPolicy,
    limitFallback: limitFallbackText,
  };
  const draftKey = settingsDraftKey(settingsDraftValues);
  const draftValuesRef = useRef(settingsDraftValues);
  useEffect(() => {
    draftValuesRef.current = settingsDraftValues;
  });
  const serverDraftRef = useRef<SettingsDraft | null>(null);
  const settingsDirty =
    settings !== null && settingsBaseline !== null && draftKey !== settingsBaseline;

  const providerValues: ProviderDraft = {
    name: provName,
    base: provBase,
    key: provKey,
    model: provModel,
    stream: provStream,
    keyDirty: provKeyDirty,
    supportsAgents: provSupportsAgents,
    models: provModels,
  };
  const providerDraft = editingId === null ? null : providerDraftKey(providerValues);
  const providerValuesRef = useRef(providerValues);
  useEffect(() => {
    providerValuesRef.current = providerValues;
  });
  const providerDirty =
    providerDraft !== null && providerBaseline !== null && providerDraft !== providerBaseline;
  const formDirty =
    settingsDirty || providerDirty || routingDirty.defaults || routingDirty.profiles;

  const canLeaveSettings = useCallback(
    () => !formDirty || window.confirm(tr("settings.discardConfirm")),
    [formDirty, tr],
  );
  useLeaveGuard(canLeaveSettings, formDirty);

  useEffect(() => {
    if (!formDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [formDirty]);

  const onRoutingDefaultsDirty = useCallback((dirty: boolean) => {
    setRoutingDirty((previous) =>
      previous.defaults === dirty ? previous : { ...previous, defaults: dirty },
    );
  }, []);
  const onRoutingProfilesDirty = useCallback((dirty: boolean) => {
    setRoutingDirty((previous) =>
      previous.profiles === dirty ? previous : { ...previous, profiles: dirty },
    );
  }, []);

  const applyServerSettings = useCallback((nextSettings: Settings, preserveDirty: boolean) => {
    const next = settingsDraftFromServer(nextSettings);
    const previous = serverDraftRef.current;
    const current = draftValuesRef.current;
    const keep = <K extends keyof SettingsDraft>(key: K): SettingsDraft[K] =>
      preserveDirty &&
      previous !== null &&
      JSON.stringify(current[key]) !== JSON.stringify(previous[key])
        ? current[key]
        : next[key];
    setPriceTable(keep("priceTable"));
    setAgentLimitsText(keep("agentLimits"));
    setRoles(keep("roles"));
    setAgentDefault(keep("agentDefault"));
    setLimitPolicy(keep("limitPolicy"));
    setLimitFallbackText(keep("limitFallback"));
    serverDraftRef.current = next;
    setSettingsBaseline(settingsDraftKey(next));
  }, []);

  const applySavedSettings = useCallback((nextSettings: Settings, submitted: SettingsDraft) => {
    const next = settingsDraftFromServer(nextSettings);
    const current = draftValuesRef.current;
    const take = (key: keyof SettingsDraft) =>
      JSON.stringify(current[key]) === JSON.stringify(submitted[key]);
    if (take("priceTable")) setPriceTable(next.priceTable);
    if (take("agentLimits")) setAgentLimitsText(next.agentLimits);
    if (take("roles")) setRoles(next.roles);
    if (take("agentDefault")) setAgentDefault(next.agentDefault);
    if (take("limitPolicy")) setLimitPolicy(next.limitPolicy);
    if (take("limitFallback")) setLimitFallbackText(next.limitFallback);
    serverDraftRef.current = next;
    setSettingsBaseline(settingsDraftKey(next));
  }, []);

  /**
   * Read the agent catalog, once, for every path that can change it.
   *
   * The default-agent row renders from this state, so a slow read must be
   * visibly loading and a failed one must say so and offer a retry — an
   * enabled picker holding only Auto was indistinguishable from "this machine
   * has no agents". Only the newest read may write, and a failure keeps the
   * list already on screen instead of blanking it.
   */
  const agentCatalogSeq = useRef(0);
  const loadAgentCatalog = useCallback(async () => {
    const seq = ++agentCatalogSeq.current;
    setAgentCatalog((previous) =>
      previous.status === "loading" ? previous : { ...previous, status: "loading" },
    );
    try {
      const agents = await listAgents();
      if (seq !== agentCatalogSeq.current) return;
      setAgentCatalog({ status: "ready", agents });
    } catch {
      if (seq !== agentCatalogSeq.current) return;
      setAgentCatalog((previous) => ({ status: "failed", agents: previous.agents }));
    }
  }, []);

  /**
   * Read the local agent providers for the agents tab. Owned by the page, not
   * the detection section, so the import group renders from the same metadata
   * without depending on that half (D2). Only the newest answer may paint.
   */
  const agentProvidersSeq = useRef(0);
  const agentProvidersRead = useRef(false);
  const readAgentProviders = useCallback(async () => {
    const seq = ++agentProvidersSeq.current;
    setAgentProvidersStatus("loading");
    setAgentProvidersError(null);
    try {
      const providers = await listAgentProviders();
      if (seq !== agentProvidersSeq.current) return;
      setAgentProviders(providers);
      setAgentProvidersStatus("ready");
    } catch (e) {
      if (seq !== agentProvidersSeq.current) return;
      setAgentProvidersStatus("failed");
      setAgentProvidersError(e instanceof ApiError ? e.message : String(e));
    }
  }, []);

  const loadSeq = useRef(0);
  const load = useCallback(
    async (preserveDirty = false) => {
      // Only the newest read may write. A mount read, a reconnect read and a
      // retry can overlap, and a late rejection from an older one used to be
      // able to paint the failure state over a form a newer read had loaded.
      const seq = ++loadSeq.current;
      setError(null);
      // The skeleton replaces the failure state the moment a retry starts, so
      // the retry button cannot be pressed a second time while the read is out.
      setLoadError(null);
      try {
        const s = await getSettings();
        if (seq !== loadSeq.current) return;
        setSettings(s);
        applyServerSettings(s, preserveDirty);
        setActiveProviderId(s["provider.active_id"] ?? "");
        // The default-agent row depends on settings, not on the provider
        // registry below: a slow or half-open providers read must not leave
        // the row saying "loading" with no way forward.
        void loadAgentCatalog();
        try {
          const reg = await listProviders();
          if (seq !== loadSeq.current) return;
          setProviders(reg.providers ?? []);
          setActiveProviderId(reg.active_id ?? s["provider.active_id"] ?? "");
        } catch {
          if (seq === loadSeq.current) setProviders([]);
        }
      } catch (e) {
        if (seq !== loadSeq.current) return;
        if (e instanceof ApiError && e.status === 401) return;
        // Do not touch `settings`: a failed reload keeps the values already on
        // screen, and a failed first read has none to lose.
        setLoadError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [applyServerSettings, loadAgentCatalog],
  );

  const retryLoad = () => {
    setLoadError(null);
    void load();
  };

  useEffect(() => {
    void load();
  }, [load]);

  // A generation the page has already answered. Comparing against the ref,
  // rather than only skipping `reconnectGen === 0`, keeps a mount after an
  // earlier reconnect from issuing a second read beside the mount read.
  const seenReconnect = useRef(reconnectGen);
  useEffect(() => {
    if (reconnectGen === seenReconnect.current) return;
    seenReconnect.current = reconnectGen;
    void load(true);
  }, [reconnectGen, load]);

  // Opening Settings on any other tab must not read /api/agent-providers. The
  // first activation starts it; coming back keeps the old answer and time. A
  // reconnect while the tab is open re-reads, like the page's own reload.
  const seenProviderReconnect = useRef(reconnectGen);
  useEffect(() => {
    const reconnected = reconnectGen !== seenProviderReconnect.current;
    seenProviderReconnect.current = reconnectGen;
    if (activeTab !== "agents") return;
    if (!reconnected && agentProvidersRead.current) return;
    agentProvidersRead.current = true;
    void readAgentProviders();
  }, [reconnectGen, activeTab, readAgentProviders]);

  /**
   * Save the shared settings form. `scope` is the group whose Save button was
   * pressed: a request failure is rendered under that button. Validation
   * failures are routed by the field that failed instead — bad price JSON is a
   * price-table problem even when Save was pressed in the limits group.
   */
  const save = async (scope?: "price" | "agentLimits" | "limitPolicy") => {
    setBusy(true);
    setError(null);
    setPriceError(null);
    setAgentLimitsError(null);
    setLimitPolicyError(null);
    // Validate price table JSON client-side for faster feedback.
    try {
      JSON.parse(priceTable);
    } catch {
      setPriceError(tr("settings.price.invalidJson"));
      setBusy(false);
      return;
    }
    // Validate agent_limits JSON client-side.
    try {
      JSON.parse(agentLimitsText);
    } catch {
      setAgentLimitsError(tr("settings.agentLimits.invalidJson"));
      setBusy(false);
      return;
    }
    try {
      const submitted = draftValuesRef.current;
      const body: Parameters<typeof updateSettings>[0] = {
        price_table: priceTable,
        agent_limits: agentLimitsText,
        agent_roles: serializeAgentRoles(roles),
        "agent.default": agentDefault.trim(),
        limit_policy: limitPolicy,
        "limit_policy.fallback_agents": limitFallbackText.trim() || "[]",
      };
      const s = await updateSettings(body);
      setSettings(s);
      setActiveProviderId(s["provider.active_id"] ?? activeProviderId);
      // Bless only the values this request carried. An edit made while the
      // answer was out stays in the form and remains dirty.
      applySavedSettings(s, submitted);
      pushToast(tr("settings.saved"), "info");
      window.dispatchEvent(new Event("kin:agent-sessions-changed"));
      // The session host reads roles once and stays mounted across routes;
      // without this, a role saved here would not reach the composer's `/`
      // menu until a reload.
      window.dispatchEvent(new Event(AGENT_ROLES_CHANGED_EVENT));
      // The default agent is read from the shared machine snapshot by the
      // new-chat face and the Run settings sheet, not from this page's list.
      // Without this, a save leaves them naming the old agent until the
      // snapshot's freshness window runs out. Fire and forget: the Save
      // button must not wait on an inventory read to finish.
      void refreshMachines();
      void loadAgentCatalog();
    } catch (e) {
      const message = e instanceof ApiError ? e.message : String(e);
      if (scope === "price") setPriceError(message);
      else if (scope === "agentLimits") setAgentLimitsError(message);
      else if (scope === "limitPolicy") setLimitPolicyError(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  };

  const importSessions = async () => {
    setError(null);
    try {
      // Every machine, not only this one: the sidebar offers the same errand
      // under the same label, and a person on a phone who tapped this one
      // instead would otherwise get a session list that silently means "here".
      const result = await importEveryMachine();
      window.dispatchEvent(
        new CustomEvent("kin:agent-sessions-changed", {
          detail: { skipAutoImport: true },
        }),
      );
      const toast = importToast(result, tr);
      pushToast(toast.message, toast.kind);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  // One provider's sessions on this machine, which is the machine whose
  // provider rows these are: the list above is read from this daemon's
  // registry, so a provider id in it means this machine's provider. That rule
  // lives in the import hook (importTargetsFor) rather than here, so this row
  // and the sidebar's per-provider rows cannot come to disagree about it — and
  // going through the same import is also what makes the two buttons disable
  // each other while one of them runs.
  const importProviderSessions = async (agentId: string) => {
    setError(null);
    try {
      const result = await importEveryMachine([agentId]);
      window.dispatchEvent(
        new CustomEvent("kin:agent-sessions-changed", {
          detail: { skipAutoImport: true },
        }),
      );
      const toast = importToast(result, tr);
      pushToast(toast.message, toast.kind);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const refreshAgentCatalog = async () => {
    setRefreshingAgentCatalog(true);
    // A press is also the one path that starts the read on a tab whose first
    // activation answer has not landed yet (or failed).
    agentProvidersRead.current = true;
    try {
      // Both reads report through their own state; this only owns the shared
      // busy flag, which clears when the slower one is done.
      await Promise.all([loadAgentCatalog(), readAgentProviders()]);
    } finally {
      setRefreshingAgentCatalog(false);
    }
  };

  const applyProviderList = (reg: { active_id: string; providers: ProviderEntry[] }) => {
    setProviders(reg.providers ?? []);
    setActiveProviderId(reg.active_id ?? "");
  };

  const openNewProvider = () => {
    setEditingId("");
    setProvName("");
    setProvBase("");
    setProvKey("");
    setProvModel("");
    setProvStream(false);
    setProvKeyDirty(false);
    setReveal(false);
    setProvModelOptions([]);
    setProvModelError(null);
    setProvSupportsAgents("");
    setProvModels([]);
    setShowRouting(false);
    setProviderBaseline(
      providerDraftKey({
        name: "",
        base: "",
        key: "",
        model: "",
        stream: false,
        keyDirty: false,
        supportsAgents: "",
        models: [],
      }),
    );
  };

  const openEditProvider = (p: ProviderEntry) => {
    setEditingId(p.id);
    setProvName(p.name || "");
    setProvBase(p.base_url || "");
    setProvKey(p.api_key || "");
    setProvModel(p.model || "");
    setProvStream(!!p.stream);
    setProvKeyDirty(false);
    setReveal(false);
    setProvModelOptions([]);
    setProvModelError(null);
    setProvSupportsAgents((p.supports_agents || []).join(", "));
    setProvModels(p.models || []);
    setShowRouting((p.supports_agents?.length || 0) > 0 || (p.models?.length || 0) > 0);
    setProviderBaseline(
      providerDraftKey({
        name: p.name || "",
        base: p.base_url || "",
        key: p.api_key || "",
        model: p.model || "",
        stream: !!p.stream,
        keyDirty: false,
        supportsAgents: (p.supports_agents || []).join(", "),
        models: p.models || [],
      }),
    );
  };

  const closeProviderForm = () => {
    setEditingId(null);
    setProvKeyDirty(false);
    setReveal(false);
    setProvModelOptions([]);
    setProvModelError(null);
    setProviderBaseline(null);
  };

  const fetchProviderModels = async () => {
    if (!provBase.trim()) {
      setProvModelError(tr("settings.provider.modelsNeedBaseUrl"));
      return;
    }
    setProvModelLoading(true);
    setProvModelError(null);
    try {
      const res = await listProviderModels({
        id: editingId || undefined,
        kind: "openai-compatible",
        base_url: provBase.trim(),
        api_key: provKeyDirty ? provKey.trim() : undefined,
      });
      setProvModelOptions(res.models ?? []);
      if (!res.models?.length) {
        setProvModelError(tr("settings.provider.modelsEmpty"));
      }
    } catch (e) {
      setProvModelOptions([]);
      setProvModelError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setProvModelLoading(false);
    }
  };

  const saveProvider = async () => {
    if (!provBase.trim() || !provModel.trim()) {
      setError(tr("settings.provider.required"));
      return;
    }
    const submitted = providerDraftKey(providerValuesRef.current);
    const submittedEditingId = editingId;
    setProvBusy(true);
    setError(null);
    try {
      const payload = {
        name: provName.trim(),
        kind: "openai-compatible",
        base_url: provBase.trim(),
        model: provModel.trim(),
        stream: provStream,
        // New entries become active; edits keep current active selection.
        active: editingId === "" ? true : undefined,
        // Routing fields.
        supports_agents: provSupportsAgents
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        models: provModels,
      } as Parameters<typeof createProvider>[0];
      if (provKeyDirty) {
        if (!provKey.trim()) {
          payload.clear_api_key = true;
          payload.api_key = "";
        } else {
          payload.api_key = provKey.trim();
        }
      }
      let reg;
      if (editingId) {
        reg = await updateProvider(editingId, payload);
      } else {
        reg = await createProvider(payload);
      }
      applyProviderList(reg);
      const current = providerDraftKey(providerValuesRef.current);
      if (current === submitted) {
        closeProviderForm();
      } else {
        // The form gained edits while the request was out. Bless only the
        // request's snapshot so those later edits remain visibly unsaved.
        if (submittedEditingId === "") setEditingId(reg.active_id);
        setProviderBaseline(submitted);
      }
      // refresh settings so kin availability / active mirror updates
      const s = await getSettings();
      setSettings(s);
      pushToast(tr("settings.provider.savedEntry"), "info");
      void loadAgentCatalog();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setProvBusy(false);
    }
  };

  const onActivateProvider = async (id: string) => {
    setProvBusy(true);
    setError(null);
    try {
      const reg = await activateProvider(id);
      applyProviderList(reg);
      const s = await getSettings();
      setSettings(s);
      pushToast(tr("settings.provider.switched"), "info");
      void loadAgentCatalog();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setProvBusy(false);
    }
  };

  const onDeleteProvider = async (id: string) => {
    if (!window.confirm(tr("settings.provider.confirmDelete"))) return;
    setProvBusy(true);
    setError(null);
    try {
      const reg = await deleteProvider(id);
      applyProviderList(reg);
      if (editingId === id) closeProviderForm();
      const s = await getSettings();
      setSettings(s);
      pushToast(tr("settings.provider.deleted"), "info");
      void loadAgentCatalog();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setProvBusy(false);
    }
  };

  if (!settings && loadError) {
    return (
      <div className="flex-1 overflow-y-auto overflow-x-hidden kin-scroll phone-footer-clearance px-4 sm:px-6 py-6">
        <h1 className="hidden text-hero font-bold md:block">{tr("settings.title")}</h1>
        {/* One named failure with one action, in place of the form: a person
            whose daemon restarted mid-edit should not have to leave Settings to
            try again. The daemon's text stays as a muted detail underneath. */}
        <div role="alert" className="mt-3">
          <MobileEmpty
            icon={<IconAlert size={30} />}
            title={tr("settings.loadFailed")}
            hint={tr("settings.loadFailedHint")}
            action={<Button onClick={retryLoad}>{tr("common.retry")}</Button>}
          />
          <p className="px-8 pb-2 text-center text-caption leading-4 text-kin-muted break-words">
            {loadError}
          </p>
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex-1 overflow-y-auto overflow-x-hidden kin-scroll phone-footer-clearance px-4 sm:px-6 py-6 space-y-4">
        <h1 className="hidden text-hero font-bold md:block">{tr("settings.title")}</h1>
        <SlowConnectHint show={slow} />
        <div className="rounded-xl border border-[var(--kin-hairline)] p-4 space-y-3">
          <SkeletonLine className="h-40 w-40" />
          <SkeletonLine className="h-4 w-1/2" />
          <SkeletonLine className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  // What the directory says each section is set to. Every value comes from
  // state the page already holds — the loaded form, the provider registry, the
  // theme preference — so nothing here reads storage, calls the daemon, or
  // invents an answer. `undefined` is deliberate: a value not loaded yet keeps
  // the section's description, and a failed reload (#232's banner) keeps the
  // values from the last good read rather than blanking them.
  const themeSummary = tr(`settings.appearance.${theme}`);
  const activeProvider =
    providers.find((entry) => entry.id === activeProviderId) ??
    providers.find((entry) => entry.active);
  const providerSummary = activeProvider?.name || undefined;
  const limitSummary =
    limitPolicy === "wait"
      ? tr("settings.summary.limitWait")
      : limitPolicy === "ask"
        ? tr("settings.summary.limitAsk")
        : limitPolicy === "switch"
          ? tr("settings.summary.limitSwitch")
          : undefined;

  const settingsTabs: SettingsTabItem[] = [
    {
      id: "general",
      label: tr("settings.tabs.general"),
      description: tr("settings.tabs.generalDesc"),
      summary: themeSummary,
    },
    {
      id: "agents",
      label: tr("settings.tabs.agents"),
      description: tr("settings.tabs.agentsDesc"),
    },
    {
      id: "operations",
      label: tr("settings.tabs.operations"),
      description: tr("settings.tabs.operationsDesc"),
    },
    {
      id: "providers",
      label: tr("settings.tabs.providers"),
      description: tr("settings.tabs.providersDesc"),
      summary: providerSummary,
    },
    {
      id: "routing",
      label: tr("settings.tabs.routing"),
      description: tr("settings.tabs.routingDesc"),
      summary: limitSummary,
    },
    {
      id: "advanced",
      label: tr("settings.tabs.advanced"),
      description: tr("settings.tabs.advancedDesc"),
    },
  ];

  return (
    <SettingsLayout
      title={tr("settings.title")}
      /* The same header block on every tab. Dropping the tagline for one tab
         changed the header's height and moved the section list under it; and
         Operations gives that column up for its wide table anyway, so the
         tagline never appears beside the console. */
      subtitle={tr("settings.subtitle")}
      tabs={settingsTabs}
      activeTab={activeTab}
      onTabChange={selectTab}
    >
      {loadError ? (
        <p
          className="rounded-lg border border-kin-orange/30 bg-kin-orange/10 px-3 py-2 text-body leading-4 text-kin-orange-ink"
          role="alert"
        >
          {tr("settings.disconnected")}
        </p>
      ) : null}

      {error ? (
        <p
          className="rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-body leading-4 text-kin-red-ink"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <ProviderSettingsSection
        active={activeTab === "providers"}
        providers={providers}
        activeProviderId={activeProviderId}
        providerBusy={provBusy}
        editingId={editingId}
        providerName={provName}
        providerBaseUrl={provBase}
        providerApiKey={provKey}
        providerModel={provModel}
        providerStream={provStream}
        revealApiKey={reveal}
        providerModelOptions={provModelOptions}
        providerModelLoading={provModelLoading}
        providerModelError={provModelError}
        showRouting={showRouting}
        providerSupportsAgents={provSupportsAgents}
        providerModels={provModels}
        agentDefault={agentDefault}
        agentList={agentCatalog.agents}
        agentCatalogStatus={agentCatalog.status}
        onRetryAgentCatalog={() => void loadAgentCatalog()}
        settingsBusy={busy}
        onAddProvider={openNewProvider}
        onActivateProvider={(id) => void onActivateProvider(id)}
        onEditProvider={openEditProvider}
        onDeleteProvider={(id) => void onDeleteProvider(id)}
        onProviderNameChange={setProvName}
        onProviderBaseUrlChange={setProvBase}
        onProviderApiKeyChange={setProvKey}
        onProviderApiKeyDirty={setProvKeyDirty}
        onProviderModelChange={setProvModel}
        onProviderStreamChange={setProvStream}
        onToggleApiKeyReveal={() => setReveal((value) => !value)}
        onFetchProviderModels={() => void fetchProviderModels()}
        onToggleRouting={() => setShowRouting((value) => !value)}
        onProviderSupportsAgentsChange={setProvSupportsAgents}
        onProviderModelsChange={setProvModels}
        onCloseProviderForm={closeProviderForm}
        onSaveProvider={() => void saveProvider()}
        onAgentDefaultChange={setAgentDefault}
        onSaveSettings={() => void save()}
      />

      <LocalAgentSettingsSection
        active={activeTab === "agents"}
        agentProviders={agentProviders}
        providersStatus={agentProvidersStatus}
        providersError={agentProvidersError}
        online={online}
        refreshingAgentCatalog={refreshingAgentCatalog}
        importingSessions={importingEveryMachine}
        settingsBusy={busy}
        onRefreshAgentCatalog={() => void refreshAgentCatalog()}
        onImportSessions={() => void importSessions()}
        onImportProviderSessions={(agentId) => void importProviderSessions(agentId)}
        onSaveSettings={() => void save()}
        roles={roles}
        onRolesChange={setRoles}
      />

      {/* Operations hosts the agent console itself. The panel stays mounted so
          a tab switch is never a departure, but the page inside is rendered
          only while its tab is open: opening Settings must not start the
          console's reads (AGENTS.md, passive views). E4a moves the body. */}
      <SettingsTabPanel id="operations" active={activeTab === "operations"}>
        {activeTab === "operations" ? <AgentsPage embedded /> : null}
      </SettingsTabPanel>

      {/* Appearance (design 3c / 3e) */}
      <SettingsTabPanel id="general" active={activeTab === "general"}>
        <SettingsSection title={tr("settings.appearance.heading")}>
          <div className="flex flex-wrap gap-2">
            {(["system", "light", "dark"] as const).map((value) => (
              <Button
                key={value}
                variant="secondary"
                aria-pressed={theme === value}
                onClick={() => {
                  setTheme(value);
                  setThemeMode(value);
                  applyTheme(value);
                }}
                className={[
                  "px-3 text-strong font-medium",
                  theme === value
                    ? "border-kin-blue bg-kin-blue/15 text-kin-blue-ink"
                    : "border-[var(--kin-hairline)] text-kin-secondary hover:bg-[var(--kin-fill)]",
                ].join(" ")}
              >
                {tr(`settings.appearance.${value}`)}
              </Button>
            ))}
          </div>
        </SettingsSection>
        <AccountSection />
        {/* The iPhone shell's only remaining notification control: iOS adds
            Kin to Settings → Notifications only after the app asked once, and
            that ask must be a tap. Renders nothing once granted. */}
        <PushPermissionRow />
      </SettingsTabPanel>

      {/* Price table (M4) — defaults from open LiteLLM price list */}
      <SettingsTabPanel id="advanced" active={activeTab === "advanced"}>
        <SettingsSection
          title={tr("settings.price.heading")}
          titleId="settings-price-heading"
          action={
            <a
              href="https://github.com/BerriAI/litellm"
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 touch-floor items-center text-caption text-kin-blue-ink hover:underline shrink-0 sm:min-h-0"
              title={tr("settings.price.sourceHint")}
            >
              {tr("settings.price.sourceName")} ↗
            </a>
          }
        >
          <p id="settings-price-description" className="text-body text-kin-muted leading-prose">
            {tr("settings.price.descA")}
            <code className="text-kin-secondary">total_cost_usd</code>
            {tr("settings.price.descB")}
            <a
              href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json"
              target="_blank"
              rel="noreferrer"
              className="text-kin-blue-ink hover:underline py-2"
            >
              {tr("settings.price.sourceName")}
            </a>
            {tr("settings.price.descC")}
            <code className="text-kin-secondary">
              {`{"model": {"in": 1.25, "out": 10.0, "ctx": 400000}}`}
            </code>
          </p>
          <p className="text-caption text-kin-muted">{tr("settings.price.ctxHint")}</p>
          <p className="text-caption text-kin-muted">
            {tr("settings.price.sourceHint")}
            {" · "}
            {tr("settings.price.overrideHint")}
          </p>
          <TextArea
            label={tr("settings.price.heading")}
            isLabelHidden
            value={priceTable}
            onChange={(e) => setPriceTable(e.target.value)}
            rows={10}
            spellCheck={false}
            aria-describedby={
              priceError
                ? "settings-price-description settings-price-error"
                : "settings-price-description"
            }
            className="font-mono text-body leading-4 resize-y min-h-40"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy} onClick={() => void save("price")}>
              {busy ? tr("settings.saving") : tr("settings.price.save")}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setPriceError(null);
                  try {
                    // Clear override → server returns embedded LiteLLM defaults.
                    const s = await updateSettings({ price_table: "" });
                    setSettings(s);
                    try {
                      setPriceTable(JSON.stringify(JSON.parse(s.price_table || "{}"), null, 2));
                    } catch {
                      setPriceTable(s.price_table ?? "");
                    }
                    pushToast(tr("settings.saved"), "info");
                  } catch (e) {
                    setPriceError(e instanceof ApiError ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
              title={tr("settings.price.sourceHint")}
            >
              {tr("settings.price.resetDefaults")}
            </Button>
          </div>
          {priceError ? (
            <p
              id="settings-price-error"
              aria-live="assertive"
              className="text-body leading-4 text-kin-red-ink"
            >
              {priceError}
            </p>
          ) : null}
        </SettingsSection>

        {/* Agent usage limits */}
        <SettingsSection
          title={tr("settings.agentLimits.heading")}
          titleId="settings-agent-limits-heading"
        >
          <p id="settings-agent-limits-description" className="text-body leading-4 text-kin-muted">
            {tr("settings.agentLimits.desc")}
            <code className="text-kin-secondary">{tr("settings.agentLimits.shape")}</code>
          </p>
          <TextArea
            label={tr("settings.agentLimits.heading")}
            isLabelHidden
            value={agentLimitsText}
            onChange={(e) => setAgentLimitsText(e.target.value)}
            rows={6}
            spellCheck={false}
            aria-describedby={
              agentLimitsError
                ? "settings-agent-limits-description settings-agent-limits-error"
                : "settings-agent-limits-description"
            }
            className="font-mono text-body leading-4 resize-y min-h-24"
          />
          <div className="flex items-center gap-3">
            <Button disabled={busy} onClick={() => void save("agentLimits")}>
              {busy ? tr("settings.saving") : tr("settings.agentLimits.save")}
            </Button>
          </div>
          {agentLimitsError ? (
            <p
              id="settings-agent-limits-error"
              aria-live="assertive"
              className="text-body leading-4 text-kin-red-ink"
            >
              {agentLimitsError}
            </p>
          ) : null}
        </SettingsSection>
      </SettingsTabPanel>

      {/* Rate-limit policy */}
      <SettingsTabPanel id="routing" active={activeTab === "routing"}>
        <SettingsSection title={tr("settings.limitPolicy.heading")}>
          <p className="text-body leading-4 text-kin-muted">{tr("settings.limitPolicy.desc")}</p>
          <div className="flex flex-col gap-2">
            {(
              [
                ["wait", "settings.limitPolicy.wait"],
                ["ask", "settings.limitPolicy.ask"],
                ["switch", "settings.limitPolicy.switch"],
              ] as const
            ).map(([value, labelKey]) => (
              <label
                key={value}
                className="flex items-center gap-2 text-strong text-kin-secondary cursor-pointer"
              >
                <input
                  type="radio"
                  name="limit_policy"
                  value={value}
                  checked={limitPolicy === value}
                  onChange={() => setLimitPolicy(value)}
                />
                {tr(labelKey)}
              </label>
            ))}
          </div>
          {limitPolicy === "switch" ? (
            <SettingsRow
              label={tr("settings.limitPolicy.fallback")}
              description={tr("settings.limitPolicy.fallbackHint")}
              labelId="limit-policy-fallback-label"
              descriptionId="limit-policy-fallback-hint"
            >
              <input
                value={limitFallbackText}
                onChange={(e) => setLimitFallbackText(e.target.value)}
                className="kin-input font-mono text-body leading-4"
                spellCheck={false}
                aria-labelledby="limit-policy-fallback-label"
                aria-describedby="limit-policy-fallback-hint"
              />
            </SettingsRow>
          ) : null}
          <Button disabled={busy} onClick={() => void save("limitPolicy")}>
            {busy ? tr("settings.saving") : tr("settings.limitPolicy.save")}
          </Button>
          {limitPolicyError ? (
            <p
              id="settings-limit-policy-error"
              aria-live="assertive"
              className="text-body leading-4 text-kin-red-ink"
            >
              {limitPolicyError}
            </p>
          ) : null}
        </SettingsSection>

        {/* Auto Model Routing — defaults */}
        <RoutingDefaultsSection onDirtyChange={onRoutingDefaultsDirty} />

        {/* Auto Model Routing — team profiles */}
        <RoutingProfilesSection onDirtyChange={onRoutingProfilesDirty} />
      </SettingsTabPanel>
    </SettingsLayout>
  );
}
