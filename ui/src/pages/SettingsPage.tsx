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
import {
  AGENT_ROLES_CHANGED_EVENT,
  parseAgentRoles,
  serializeAgentRoles,
  type AgentRole,
} from "../lib/agentRoles";
import { importToast } from "../lib/agentSessionImport";
import { useAgentSessionImport } from "../hooks/useAgentSessionImport";
import { LocalAgentSettingsSection } from "../components/settings/LocalAgentSettingsSection";
import { ProviderSettingsSection } from "../components/settings/ProviderSettingsSection";
import { AccountSection } from "../components/settings/AccountSection";
import { PushPermissionRow } from "../components/settings/PushPermissionRow";
import {
  RoutingDefaultsSection,
  RoutingProfilesSection,
} from "../components/settings/RoutingSettings";
import {
  SettingsLayout,
  SettingsSection,
  SettingsTabPanel,
  type SettingsTabItem,
} from "../components/settings/SettingsPrimitives";
import { normalizeSettingsTab, type SettingsTabId } from "../lib/areaNavigation";
import { useSlowHint } from "../hooks/useSlowHint";
import { useLeaveGuard } from "../hooks/useLeaveGuard";
import { runGuardedNavigation } from "../lib/leaveGuard";
import { applyTheme, getThemeMode, setThemeMode, type ThemeMode } from "../lib/theme";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";

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
 * The panels this page can draw today.
 *
 * `operations` is a real settings destination — the area table owns it, a
 * notification link can name it, and the palette can offer it — but its body
 * arrives with N4, together with the Agent-operations move. Drawing the tab
 * now would show a blank page, so the page renders General for it; the URL
 * keeps the section, and N4 removes this narrowing when the panel lands.
 */
type RenderedSettingsTab = Exclude<SettingsTabId, "operations">;

function renderedSettingsTab(tab: SettingsTabId): RenderedSettingsTab {
  return tab === "operations" ? "general" : tab;
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
  const [agentList, setAgentList] = useState<AgentInfo[]>([]);
  const [agentProviders, setAgentProviders] = useState<AgentProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
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
  const [activeTab, setActiveTab] = useState<RenderedSettingsTab>(() =>
    renderedSettingsTab(normalizeSettingsTab(new URLSearchParams(location.search).get("tab"))),
  );
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    // A URL without `tab` is General: notification parsing canonicalizes
    // `?tab=general` to `/settings`, and mounted panels already keep their
    // drafts (`hidden` in `SettingsTabPanel`), so following the URL cannot
    // lose unsaved text.
    setActiveTab(renderedSettingsTab(normalizeSettingsTab(params.get("tab"))));
  }, [location.search]);
  const selectTab = useCallback(
    (tab: SettingsTabId) => {
      setActiveTab(renderedSettingsTab(tab));
      const path = settingsTabPath(tab, location.pathname, location.search);
      // Replacing while the leave-guard sentinel is on top would rewrite the
      // sentinel and leave the previous tab underneath. Release the sentinel
      // first (approved: a tab change does not discard drafts), then replace
      // the real entry so one approved Back still leaves Settings.
      const go = () => navigate(path, { replace: true });
      if (!runGuardedNavigation(go, true)) go();
    },
    [navigate, location.pathname, location.search],
  );
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const pushToast = useAppStore((s) => s.pushToast);
  const slow = useSlowHint(!settings && !error);
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

  const load = useCallback(
    async (preserveDirty = false) => {
      setError(null);
      try {
        const s = await getSettings();
        setSettings(s);
        applyServerSettings(s, preserveDirty);
        setActiveProviderId(s["provider.active_id"] ?? "");
        try {
          const reg = await listProviders();
          setProviders(reg.providers ?? []);
          setActiveProviderId(reg.active_id ?? s["provider.active_id"] ?? "");
        } catch {
          setProviders([]);
        }
        listAgents()
          .then(setAgentList)
          .catch(() => undefined);
        listAgentProviders()
          .then(setAgentProviders)
          .catch(() => undefined);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [applyServerSettings],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void load(true);
  }, [reconnectGen, load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    // Validate price table JSON client-side for faster feedback.
    try {
      JSON.parse(priceTable);
    } catch {
      setError(tr("settings.price.invalidJson"));
      setBusy(false);
      return;
    }
    // Validate agent_limits JSON client-side.
    try {
      JSON.parse(agentLimitsText);
    } catch {
      setError(tr("settings.agentLimits.invalidJson"));
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
      listAgents()
        .then(setAgentList)
        .catch(() => undefined);
      listAgentProviders()
        .then(setAgentProviders)
        .catch(() => undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
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
    try {
      const [agents, providers] = await Promise.all([listAgents(), listAgentProviders()]);
      setAgentList(agents);
      setAgentProviders(providers);
    } catch {
      // Keep the last-known-good snapshot visible when the daemon is reconnecting.
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
      listAgents()
        .then(setAgentList)
        .catch(() => undefined);
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
      listAgents()
        .then(setAgentList)
        .catch(() => undefined);
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
      listAgents()
        .then(setAgentList)
        .catch(() => undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setProvBusy(false);
    }
  };

  if (error && !settings) {
    return (
      <div className="flex-1 overflow-y-auto kin-scroll px-4 sm:px-6 py-6">
        <h1 className="hidden text-hero font-bold md:block">{tr("settings.title")}</h1>
        <p className="text-strong leading-5 text-kin-red-ink mt-3" role="alert">
          {error}
        </p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex-1 overflow-y-auto kin-scroll px-4 sm:px-6 py-6 space-y-4">
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

  const settingsTabs: SettingsTabItem[] = [
    {
      id: "general",
      label: tr("settings.tabs.general"),
      description: tr("settings.tabs.generalDesc"),
    },
    {
      id: "agents",
      label: tr("settings.tabs.agents"),
      description: tr("settings.tabs.agentsDesc"),
    },
    {
      id: "providers",
      label: tr("settings.tabs.providers"),
      description: tr("settings.tabs.providersDesc"),
    },
    {
      id: "routing",
      label: tr("settings.tabs.routing"),
      description: tr("settings.tabs.routingDesc"),
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
      subtitle={tr("settings.subtitle")}
      tabs={settingsTabs}
      activeTab={activeTab}
      onTabChange={selectTab}
    >
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
        agentList={agentList}
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

      {/* Appearance (design 3c / 3e) */}
      <SettingsTabPanel id="general" active={activeTab === "general"}>
        <SettingsSection title={tr("settings.appearance.heading")}>
          <div className="flex flex-wrap gap-2">
            {(["system", "light", "dark"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setTheme(value);
                  setThemeMode(value);
                  applyTheme(value);
                }}
                className={[
                  "px-3 py-2 rounded-lg text-strong font-medium min-h-11 sm:min-h-10 border",
                  theme === value
                    ? "border-kin-blue bg-kin-blue/15 text-kin-blue-ink"
                    : "border-[var(--kin-hairline)] text-kin-secondary hover:bg-[var(--kin-fill)]",
                ].join(" ")}
              >
                {tr(`settings.appearance.${value}`)}
              </button>
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
        <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
              {tr("settings.price.heading")}
            </h2>
            <a
              href="https://github.com/BerriAI/litellm"
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center text-caption text-kin-blue-ink hover:underline shrink-0 sm:min-h-0"
              title={tr("settings.price.sourceHint")}
            >
              {tr("settings.price.sourceName")} ↗
            </a>
          </div>
          <p className="text-body text-kin-muted leading-prose">
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
          <textarea
            value={priceTable}
            onChange={(e) => setPriceTable(e.target.value)}
            rows={10}
            spellCheck={false}
            className="kin-input font-mono text-body leading-4 resize-y min-h-40"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className="kin-btn-primary disabled:opacity-50"
            >
              {busy ? tr("settings.saving") : tr("settings.price.save")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError(null);
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
                    setError(e instanceof ApiError ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
              className="kin-btn-secondary disabled:opacity-50"
              title={tr("settings.price.sourceHint")}
            >
              {tr("settings.price.resetDefaults")}
            </button>
          </div>
        </section>

        {/* Agent usage limits */}
        <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
          <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
            {tr("settings.agentLimits.heading")}
          </h2>
          <p className="text-body leading-4 text-kin-muted">
            {tr("settings.agentLimits.desc")}
            <code className="text-kin-secondary">{tr("settings.agentLimits.shape")}</code>
          </p>
          <textarea
            value={agentLimitsText}
            onChange={(e) => setAgentLimitsText(e.target.value)}
            rows={6}
            spellCheck={false}
            className="kin-input font-mono text-body leading-4 resize-y min-h-24"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className="kin-btn-primary disabled:opacity-50"
            >
              {busy ? tr("settings.saving") : tr("settings.agentLimits.save")}
            </button>
            {error && <span className="text-body leading-4 text-kin-red-ink">{error}</span>}
          </div>
        </section>
      </SettingsTabPanel>

      {/* Rate-limit policy */}
      <SettingsTabPanel id="routing" active={activeTab === "routing"}>
        <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
          <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
            {tr("settings.limitPolicy.heading")}
          </h2>
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
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-kin-muted">
                {tr("settings.limitPolicy.fallback")}
              </span>
              <input
                value={limitFallbackText}
                onChange={(e) => setLimitFallbackText(e.target.value)}
                className="kin-input font-mono text-body leading-4"
                spellCheck={false}
              />
              <span className="text-caption text-kin-muted">
                {tr("settings.limitPolicy.fallbackHint")}
              </span>
            </label>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="kin-btn-primary disabled:opacity-50"
          >
            {busy ? tr("settings.saving") : tr("settings.limitPolicy.save")}
          </button>
        </section>

        {/* Auto Model Routing — defaults */}
        <RoutingDefaultsSection onDirtyChange={onRoutingDefaultsDirty} />

        {/* Auto Model Routing — team profiles */}
        <RoutingProfilesSection onDirtyChange={onRoutingProfilesDirty} />
      </SettingsTabPanel>
    </SettingsLayout>
  );
}
