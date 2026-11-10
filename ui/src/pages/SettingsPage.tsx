import { useCallback, useEffect, useState } from "react";
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
import {
  isAutoImportSnapshot,
  LocalAgentSettingsSection,
  type AutoImportSnapshot,
} from "../components/settings/LocalAgentSettingsSection";
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
  settingsTabFromSearch,
  type SettingsTabId,
  type SettingsTabItem,
} from "../components/settings/SettingsPrimitives";
import { useSlowHint } from "../hooks/useSlowHint";
import { applyTheme, getThemeMode, setThemeMode, type ThemeMode } from "../lib/theme";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";

export default function SettingsPage() {
  const tr = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [priceTable, setPriceTable] = useState("");
  const [agentLimitsText, setAgentLimitsText] = useState("");
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [limitPolicy, setLimitPolicy] = useState("wait");
  const [limitFallbackText, setLimitFallbackText] = useState("[]");
  const [autoImportMode, setAutoImportMode] = useState<"prompt" | "enabled" | "disabled">("prompt");
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
  const [lastAutoImport, setLastAutoImport] = useState<AutoImportSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => getThemeMode());
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() =>
    typeof window === "undefined" ? "general" : settingsTabFromSearch(window.location.search),
  );
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const pushToast = useAppStore((s) => s.pushToast);
  const slow = useSlowHint(!settings && !error);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await getSettings();
      setSettings(s);
      setAgentDefault(s["agent.default"] ?? "");
      setLimitPolicy((s.limit_policy as string) || "wait");
      setLimitFallbackText(s["limit_policy.fallback_agents"] || "[]");
      setAutoImportMode(s["agent_sessions.auto_import_mode"] || "prompt");
      setActiveProviderId(s["provider.active_id"] ?? "");
      try {
        const reg = await listProviders();
        setProviders(reg.providers ?? []);
        setActiveProviderId(reg.active_id ?? s["provider.active_id"] ?? "");
      } catch {
        setProviders([]);
      }
      try {
        setPriceTable(JSON.stringify(JSON.parse(s.price_table || "{}"), null, 2));
      } catch {
        setPriceTable(s.price_table ?? "");
      }
      try {
        setAgentLimitsText(JSON.stringify(JSON.parse(s.agent_limits || "{}"), null, 2));
      } catch {
        setAgentLimitsText(s.agent_limits ?? "{}");
      }
      setRoles(parseAgentRoles(s.agent_roles));
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void load();
  }, [reconnectGen, load]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("kin_agent_sessions_last_sync");
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isAutoImportSnapshot(parsed)) setLastAutoImport(parsed);
      }
    } catch {
      // Ignore unavailable or stale browser storage.
    }
    const onSync = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (isAutoImportSnapshot(detail)) setLastAutoImport(detail);
    };
    window.addEventListener("kin:agent-sessions-sync", onSync);
    return () => window.removeEventListener("kin:agent-sessions-sync", onSync);
  }, []);

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
      const body: Parameters<typeof updateSettings>[0] = {
        price_table: priceTable,
        agent_limits: agentLimitsText,
        agent_roles: serializeAgentRoles(roles),
        "agent.default": agentDefault.trim(),
        limit_policy: limitPolicy,
        "limit_policy.fallback_agents": limitFallbackText.trim() || "[]",
        "agent_sessions.auto_import_mode": autoImportMode,
      };
      const s = await updateSettings(body);
      setSettings(s);
      setAgentDefault(s["agent.default"] ?? "");
      setLimitPolicy((s.limit_policy as string) || "wait");
      setLimitFallbackText(s["limit_policy.fallback_agents"] || "[]");
      setAutoImportMode(s["agent_sessions.auto_import_mode"] || "prompt");
      setActiveProviderId(s["provider.active_id"] ?? activeProviderId);
      try {
        setPriceTable(JSON.stringify(JSON.parse(s.price_table || "{}"), null, 2));
      } catch {
        setPriceTable(s.price_table ?? "");
      }
      try {
        setAgentLimitsText(JSON.stringify(JSON.parse(s.agent_limits || "{}"), null, 2));
      } catch {
        setAgentLimitsText(s.agent_limits ?? "{}");
      }
      // Re-read rather than keep the draft: the serializer drops half-written
      // rows, and the fields should show what was actually saved.
      setRoles(parseAgentRoles(s.agent_roles));
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
  };

  const closeProviderForm = () => {
    setEditingId(null);
    setProvKeyDirty(false);
    setReveal(false);
    setProvModelOptions([]);
    setProvModelError(null);
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
      closeProviderForm();
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
      onTabChange={setActiveTab}
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
        autoImportMode={autoImportMode}
        lastAutoImport={lastAutoImport}
        settingsBusy={busy}
        onRefreshAgentCatalog={() => void refreshAgentCatalog()}
        onImportSessions={() => void importSessions()}
        onImportProviderSessions={(agentId) => void importProviderSessions(agentId)}
        onAutoImportModeChange={setAutoImportMode}
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
        <RoutingDefaultsSection />

        {/* Auto Model Routing — team profiles */}
        <RoutingProfilesSection />
      </SettingsTabPanel>
    </SettingsLayout>
  );
}
