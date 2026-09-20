import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  ApiError,
  adoptRelayURL,
  activateProvider,
  bindCloudflareRelayDomain,
  createProvider,
  deleteProvider,
  deployCloudflareRelay,
  getSettings,
  importAgentSessions,
  listCloudflareAccounts,
  listCloudflareZones,
  listAgentProviders,
  listAgents,
  listProviderModels,
  listProviders,
  refreshRelayPairing,
  startCloudflareOAuth,
  testNotify,
  updateProvider,
  updateSettings,
  type AgentInfo,
  type AgentProvider,
  type AgentSessionImportResult,
  type CloudflareAccount,
  type CloudflareZone,
  type ModelSpec,
  type ProviderEntry,
  type Settings,
} from "../api/client";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { RoutingDefaultsSection, RoutingProfilesSection } from "../components/settings/RoutingSettings";
import { useSlowHint } from "../hooks/useSlowHint";
import {
  applyTheme,
  getThemeMode,
  setThemeMode,
  type ThemeMode,
} from "../lib/theme";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";
import { Link } from "react-router-dom";
import {
  agentCatalogState,
  runnableAgents,
  sortAgentCatalog,
} from "../lib/agentCatalog";

type AutoImportSnapshot = AgentSessionImportResult & { synced_at: number };

function isAutoImportSnapshot(value: unknown): value is AutoImportSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<AutoImportSnapshot>;
  return (
    typeof snapshot.synced_at === "number" &&
    Number.isFinite(snapshot.synced_at) &&
    typeof snapshot.imported === "number" &&
    Number.isFinite(snapshot.imported) &&
    !!snapshot.providers &&
    typeof snapshot.providers === "object"
  );
}

function formatSyncTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function probePublicURL(rawURL: string, timeoutMs = 5000): Promise<boolean> {
  if (!rawURL) return false;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(rawURL, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

function defaultRelayHostname(zoneName: string): string {
  return zoneName ? `kin-relay.${zoneName}` : "";
}

export default function SettingsPage() {
  const tr = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bark, setBark] = useState("");
  const [ntfy, setNtfy] = useState("");
  const [quotaWaitNotifySecs, setQuotaWaitNotifySecs] = useState("900");
  const [baseURL, setBaseURL] = useState("");
  const [relayURL, setRelayURL] = useState("");
  const [relayBusy, setRelayBusy] = useState(false);
  const [cloudflareAccounts, setCloudflareAccounts] = useState<CloudflareAccount[]>([]);
  const [cloudflareZones, setCloudflareZones] = useState<CloudflareZone[]>([]);
  const [cloudflareAccountID, setCloudflareAccountID] = useState("");
  const [cloudflareZoneID, setCloudflareZoneID] = useState("");
  const [cloudflareHostname, setCloudflareHostname] = useState("");
  const [cloudflareScriptName, setCloudflareScriptName] = useState("kin-relay");
  const [cloudflareBusy, setCloudflareBusy] = useState(false);
  const [cloudflareDeploying, setCloudflareDeploying] = useState(false);
  const [cloudflareBindingDomain, setCloudflareBindingDomain] = useState(false);
  const [priceTable, setPriceTable] = useState("");
  const [agentLimitsText, setAgentLimitsText] = useState("");
  const [limitPolicy, setLimitPolicy] = useState("wait");
  const [limitFallbackText, setLimitFallbackText] = useState("[]");
  const [autoImportMode, setAutoImportMode] = useState<"prompt" | "enabled" | "disabled">("prompt");
  const [importingSessions, setImportingSessions] = useState(false);
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
  const [saved, setSaved] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => getThemeMode());
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const pushToast = useAppStore((s) => s.pushToast);
  const slow = useSlowHint(!settings && !error);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await getSettings();
      setSettings(s);
      setBark(s["notify.bark_url"] ?? "");
      setNtfy(s["notify.ntfy_topic"] ?? "");
      setQuotaWaitNotifySecs(s["notify.quota_wait_after_secs"] || "900");
      setBaseURL(s["ui.base_url"] ?? "");
      setRelayURL(s["relay.url"] ?? "");
      setCloudflareAccountID(s["cloudflare.account_id"] ?? "");
      setCloudflareZoneID(s["cloudflare.relay_zone_id"] ?? "");
      setCloudflareHostname(s["cloudflare.relay_custom_domain"] ?? "");
      setCloudflareScriptName(s["cloudflare.relay_script_name"] || "kin-relay");
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
      listAgents()
        .then(setAgentList)
        .catch(() => undefined);
      listAgentProviders()
        .then(setAgentProviders)
        .catch(() => undefined);
      if (s["cloudflare.authenticated"]) {
        listCloudflareAccounts()
          .then((res) => {
            setCloudflareAccounts(res.accounts ?? []);
            if (!s["cloudflare.account_id"] && res.accounts?.length === 1) {
              setCloudflareAccountID(res.accounts[0].id);
            }
          })
          .catch(() => undefined);
        listCloudflareZones(s["cloudflare.account_id"])
          .then((res) => {
            setCloudflareZones(res.zones ?? []);
            if (!s["cloudflare.relay_zone_id"] && res.zones?.length === 1) {
              setCloudflareZoneID(res.zones[0].id);
            }
          })
          .catch(() => undefined);
      } else {
        setCloudflareAccounts([]);
        setCloudflareZones([]);
      }
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
    if (!settings?.["relay.url"]) return;
    const timer = window.setInterval(() => {
      void getSettings()
        .then((next) => setSettings(next))
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [settings?.["relay.url"]]);

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
    setSaved(false);
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
        "notify.bark_url": bark.trim(),
        "notify.ntfy_topic": ntfy.trim(),
        "notify.quota_wait_after_secs": quotaWaitNotifySecs.trim() || "900",
        "ui.base_url": baseURL.trim(),
        price_table: priceTable,
        agent_limits: agentLimitsText,
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
      setQuotaWaitNotifySecs(s["notify.quota_wait_after_secs"] || "900");
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
      setSaved(true);
      pushToast(tr("settings.saved"), "info");
      window.dispatchEvent(new Event("kin:agent-sessions-changed"));
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
    setImportingSessions(true);
    setError(null);
    try {
      const result = await importAgentSessions();
      window.dispatchEvent(
        new CustomEvent("kin:agent-sessions-changed", {
          detail: { skipAutoImport: true },
        }),
      );
      const errorCount = Object.keys(result.errors ?? {}).length;
      pushToast(
        errorCount > 0
          ? tr("settings.localAgents.importPartial", {
              imported: result.imported,
              errors: errorCount,
            })
          : tr("settings.localAgents.imported", { imported: result.imported }),
        errorCount > 0 ? "error" : "info",
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setImportingSessions(false);
    }
  };

  const importProviderSessions = async (agentId: string) => {
    setImportingSessions(true);
    setError(null);
    try {
      const result = await importAgentSessions([agentId]);
      window.dispatchEvent(
        new CustomEvent("kin:agent-sessions-changed", {
          detail: { skipAutoImport: true },
        }),
      );
      const errorCount = Object.keys(result.errors ?? {}).length;
      pushToast(
        errorCount > 0
          ? tr("settings.localAgents.importPartial", {
              imported: result.imported,
              errors: errorCount,
            })
          : tr("settings.localAgents.imported", { imported: result.imported }),
        errorCount > 0 ? "error" : "info",
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setImportingSessions(false);
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

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  const applyRelaySettings = (s: Settings) => {
    setSettings(s);
    setRelayURL(s["relay.url"] ?? "");
  };

  const adoptRelaySettings = (s: Settings) => {
    applyRelaySettings(s);
    adoptRelayURL(s["relay.open_url"] ?? "");
    const target = s["relay.open_url"]
      ? s["relay.open_url"]
      : s["ui.base_url"]
        ? `${s["ui.base_url"].replace(/\/+$/, "")}/?token=${encodeURIComponent(s.token)}`
        : "";
    if (target) window.location.assign(target);
  };

  const saveRelay = async () => {
    setRelayBusy(true);
    setError(null);
    try {
      const s = await updateSettings({ "relay.url": relayURL.trim() });
      pushToast(tr("settings.relay.saved"), "info");
      adoptRelaySettings(s);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRelayBusy(false);
    }
  };

  const refreshPairing = async () => {
    setRelayBusy(true);
    setError(null);
    try {
      const s = await refreshRelayPairing();
      setSettings(s);
      pushToast(tr("settings.relay.pairingRefreshed"), "info");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRelayBusy(false);
    }
  };

  const connectCloudflare = async () => {
    setCloudflareBusy(true);
    setError(null);
    try {
      const { auth_url } = await startCloudflareOAuth();
      window.open(auth_url, "_blank", "noopener,noreferrer");
      pushToast(tr("settings.relay.cloudflareLoginOpened"), "info");
      let connected = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await wait(2000);
        const next = await getSettings();
        setSettings(next);
        if (next["cloudflare.authenticated"]) {
          connected = true;
          setCloudflareAccountID(next["cloudflare.account_id"] ?? "");
          setCloudflareScriptName(next["cloudflare.relay_script_name"] || "kin-relay");
          try {
            const res = await listCloudflareAccounts();
            setCloudflareAccounts(res.accounts ?? []);
            const accountID = next["cloudflare.account_id"] || res.accounts?.[0]?.id || "";
            if (!next["cloudflare.account_id"] && res.accounts?.length === 1) {
              setCloudflareAccountID(res.accounts[0].id);
            }
            if (accountID) {
              const zoneRes = await listCloudflareZones(accountID);
              setCloudflareZones(zoneRes.zones ?? []);
              if (!next["cloudflare.relay_zone_id"] && zoneRes.zones?.length === 1) {
                setCloudflareZoneID(zoneRes.zones[0].id);
                setCloudflareHostname((current) => current || defaultRelayHostname(zoneRes.zones[0].name));
              }
            }
          } catch (accountErr) {
            setError(accountErr instanceof ApiError ? accountErr.message : String(accountErr));
          }
          break;
        }
      }
      if (!connected) {
        pushToast(tr("settings.relay.cloudflareLoginTimedOut"), "error");
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCloudflareBusy(false);
    }
  };

  const refreshCloudflareAccounts = async () => {
    setCloudflareBusy(true);
    setError(null);
    try {
      const res = await listCloudflareAccounts();
      setCloudflareAccounts(res.accounts ?? []);
      if (!cloudflareAccountID && res.accounts?.length === 1) {
        setCloudflareAccountID(res.accounts[0].id);
      }
      const next = await getSettings();
      setSettings(next);
      if (next["cloudflare.account_id"]) {
        setCloudflareAccountID(next["cloudflare.account_id"]);
      }
      const accountID = next["cloudflare.account_id"] || cloudflareAccountID || res.accounts?.[0]?.id || "";
      if (accountID) {
        const zoneRes = await listCloudflareZones(accountID);
        setCloudflareZones(zoneRes.zones ?? []);
        if (!cloudflareZoneID && zoneRes.zones?.length === 1) {
          setCloudflareZoneID(zoneRes.zones[0].id);
          setCloudflareHostname((current) => current || defaultRelayHostname(zoneRes.zones[0].name));
        }
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCloudflareBusy(false);
    }
  };

  const refreshCloudflareZones = async (accountID = cloudflareAccountID) => {
    if (!accountID) return [];
    const res = await listCloudflareZones(accountID);
    const zones = res.zones ?? [];
    setCloudflareZones(zones);
    if (!cloudflareZoneID && zones.length === 1) {
      setCloudflareZoneID(zones[0].id);
      setCloudflareHostname((current) => current || defaultRelayHostname(zones[0].name));
    }
    return zones;
  };

  const bindRelayCustomDomain = async (zoneID = cloudflareZoneID, hostname = cloudflareHostname) => {
    setCloudflareBindingDomain(true);
    setError(null);
    try {
      const zone = cloudflareZones.find((z) => z.id === zoneID);
      const nextHostname = hostname.trim() || defaultRelayHostname(zone?.name ?? "");
      const s = await bindCloudflareRelayDomain({
        account_id: cloudflareAccountID,
        zone_id: zoneID,
        hostname: nextHostname,
        script_name: cloudflareScriptName,
      });
      setCloudflareHostname(s["cloudflare.relay_custom_domain"] || nextHostname);
      setCloudflareZoneID(s["cloudflare.relay_zone_id"] || zoneID);
      pushToast(tr("settings.relay.cloudflareDomainBound"), "info");
      adoptRelaySettings(s);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCloudflareBindingDomain(false);
    }
  };

  const deployRelayWorker = async () => {
    setCloudflareDeploying(true);
    setError(null);
    try {
      const s = await deployCloudflareRelay({
        account_id: cloudflareAccountID,
        script_name: cloudflareScriptName,
      });
      pushToast(tr("settings.relay.cloudflareDeployed"), "info");
      applyRelaySettings(s);
      const workerURL = s["cloudflare.relay_worker_url"] || s["relay.url"];
      if (workerURL && !(await probePublicURL(workerURL))) {
        pushToast(tr("settings.relay.workerDevUnreachable"), "error");
        const zones = cloudflareZones.length ? cloudflareZones : await refreshCloudflareZones(cloudflareAccountID);
        if (zones.length === 1) {
          await bindRelayCustomDomain(zones[0].id, defaultRelayHostname(zones[0].name));
        }
      } else {
        adoptRelaySettings(s);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCloudflareDeploying(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await testNotify();
      if (!res.results?.length) {
        pushToast(tr("settings.notify.noChannels"), "error");
        return;
      }
      const parts = res.results.map((r) =>
        r.ok ? `${r.channel}: ok` : `${r.channel}: ${r.error || "failed"}`,
      );
      pushToast(parts.join(" · "), res.ok ? "info" : "error");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      pushToast(e instanceof ApiError ? e.message : String(e), "error");
    } finally {
      setTesting(false);
    }
  };

  if (error && !settings) {
    return (
      <div className="flex-1 overflow-y-auto kin-scroll px-4 sm:px-6 py-6">
        <h1 className="text-[22px] font-semibold">{tr("settings.title")}</h1>
        <p className="text-sm text-kin-red mt-3" role="alert">
          {error}
        </p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex-1 overflow-y-auto kin-scroll px-4 sm:px-6 py-6 space-y-4">
        <h1 className="text-[22px] font-semibold">{tr("settings.title")}</h1>
        <SlowConnectHint show={slow} />
        <div className="rounded-xl border border-[var(--kin-hairline)] p-4 space-y-3">
          <SkeletonLine className="h-40 w-40" />
          <SkeletonLine className="h-4 w-1/2" />
          <SkeletonLine className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  const connectURL = settings.connect_url || "";
  const token = settings.token || "";
  const mode = settings.network_mode || "—";
  const relayState =
    settings["relay.state"] === "connected" ||
    settings["relay.state"] === "connecting" ||
    settings["relay.state"] === "disabled" ||
    settings["relay.state"] === "error"
      ? settings["relay.state"]
      : "disabled";

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="max-w-[720px] mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{tr("settings.title")}</h1>
        <p className="mt-1 text-sm text-kin-secondary">
          {tr("settings.subtitle")}
        </p>
      </div>

      {/* Cognition providers — powers agent "kin" */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
              {tr("settings.provider.heading")}
            </h2>
            <p className="text-[12px] text-kin-secondary leading-relaxed">
              {tr("settings.provider.descA")}
              <code className="text-[11px] px-1 rounded bg-[var(--kin-fill)]">kin</code>
              {tr("settings.provider.descB")}
            </p>
          </div>
          <button
            type="button"
            disabled={provBusy}
            onClick={openNewProvider}
            className="kin-btn-secondary shrink-0 disabled:opacity-50"
          >
            {tr("settings.provider.add")}
          </button>
        </div>

        {providers.length === 0 ? (
          <p className="text-[13px] text-kin-muted">{tr("settings.provider.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {providers.map((p) => {
              const isActive = p.id === activeProviderId || p.active;
              return (
                <li
                  key={p.id}
                  className={[
                    "rounded-lg border p-3 flex flex-col sm:flex-row sm:items-center gap-3",
                    isActive
                      ? "border-kin-blue bg-kin-blue-soft/40"
                      : "border-[var(--kin-hairline)] bg-[var(--kin-fill)]/40",
                  ].join(" ")}
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium truncate">
                        {p.name || p.model || p.id}
                      </span>
                      {isActive ? (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-kin-blue">
                          {tr("settings.provider.activeBadge")}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-kin-muted font-mono truncate">
                      {p.model}
                      {p.base_url ? ` · ${p.base_url}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    {!isActive ? (
                      <button
                        type="button"
                        disabled={provBusy}
                        onClick={() => void onActivateProvider(p.id)}
                        className="kin-btn-secondary text-[12px] min-h-[36px] disabled:opacity-50"
                      >
                        {tr("settings.provider.use")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={provBusy}
                      onClick={() => openEditProvider(p)}
                      className="kin-btn-secondary text-[12px] min-h-[36px] disabled:opacity-50"
                    >
                      {tr("settings.provider.edit")}
                    </button>
                    <button
                      type="button"
                      disabled={provBusy}
                      onClick={() => void onDeleteProvider(p.id)}
                      className="kin-btn-secondary text-[12px] min-h-[36px] text-kin-red disabled:opacity-50"
                    >
                      {tr("settings.provider.delete")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {editingId !== null ? (
          <div className="rounded-lg border border-[var(--kin-hairline)] p-3 space-y-3 bg-kin-elevated">
            <h3 className="text-[12px] font-semibold text-kin-secondary">
              {editingId
                ? tr("settings.provider.editHeading")
                : tr("settings.provider.addHeading")}
            </h3>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.provider.name")}
              </span>
              <input
                type="text"
                value={provName}
                onChange={(e) => setProvName(e.target.value)}
                placeholder={tr("settings.provider.namePlaceholder")}
                className="kin-input min-h-[44px]"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.provider.baseUrl")}
              </span>
              <input
                type="url"
                value={provBase}
                onChange={(e) => setProvBase(e.target.value)}
                placeholder="https://api.openai.com/v1 · http://127.0.0.1:8317/v1"
                className="kin-input min-h-[44px] font-mono text-xs"
                autoComplete="off"
              />
              <span className="text-[11px] text-kin-muted">
                {tr("settings.provider.baseUrlHintA")}
                <code className="text-[10px]">/v1</code>
                {tr("settings.provider.baseUrlHintB")}
              </span>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.provider.apiKey")}
              </span>
              <div className="flex gap-2">
                <input
                  type={reveal ? "text" : "password"}
                  value={provKey}
                  onChange={(e) => {
                    setProvKey(e.target.value);
                    setProvKeyDirty(true);
                  }}
                  className="kin-input min-h-[44px] font-mono text-xs flex-1"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="kin-btn-secondary shrink-0"
                  onClick={() => setReveal((v) => !v)}
                >
                  {reveal ? tr("settings.hide") : tr("settings.reveal")}
                </button>
              </div>
              <span className="text-[11px] text-kin-muted">
                {tr("settings.provider.apiKeyHint")}
              </span>
            </label>
            <label className="block space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-kin-secondary">
                  {tr("settings.provider.model")}
                </span>
                <button
                  type="button"
                  disabled={provModelLoading}
                  onClick={() => void fetchProviderModels()}
                  className="text-[11px] text-kin-blue hover:underline disabled:opacity-50 shrink-0"
                >
                  {provModelLoading
                    ? tr("settings.provider.modelsFetching")
                    : tr("settings.provider.modelsFetch")}
                </button>
              </div>
              <input
                type="text"
                list="provider-model-options"
                value={provModel}
                onChange={(e) => setProvModel(e.target.value)}
                placeholder="gpt-4.1-mini · grok-3 · llama3.2"
                className="kin-input min-h-[44px] font-mono text-xs"
              />
              <datalist id="provider-model-options">
                {provModelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {provModelError ? (
                <span className="block text-[11px] text-kin-red">{provModelError}</span>
              ) : null}
              {provModelOptions.length > 0 ? (
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) setProvModel(e.target.value);
                  }}
                  className="kin-input min-h-[40px] text-xs mt-1"
                >
                  <option value="">
                    {tr("settings.provider.modelsPick").replace(
                      "{count}",
                      String(provModelOptions.length),
                    )}
                  </option>
                  {provModelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : null}
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={provStream}
                onChange={(e) => setProvStream(e.target.checked)}
                className="mt-1"
              />
              <span className="space-y-0.5">
                <span className="block text-xs font-medium text-kin-secondary">
                  {tr("settings.provider.stream")}
                </span>
                <span className="block text-[11px] text-kin-muted">
                  {tr("settings.provider.streamHint")}
                </span>
              </span>
            </label>
            {/* Routing section (collapsible) */}
            <div className="border-t border-[var(--kin-hairline)] pt-2">
              <button
                type="button"
                onClick={() => setShowRouting((v) => !v)}
                className="flex items-center gap-1 text-xs font-medium text-kin-secondary hover:text-kin-blue"
              >
                <span className={`transition-transform ${showRouting ? "rotate-90" : ""}`}>▸</span>
                {tr("settings.routing.heading")}
              </button>
              {showRouting && (
                <div className="mt-2 space-y-3">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-kin-secondary">
                      {tr("settings.routing.supportsAgents")}
                    </span>
                    <input
                      type="text"
                      value={provSupportsAgents}
                      onChange={(e) => setProvSupportsAgents(e.target.value)}
                      className="kin-input min-h-[40px] font-mono text-xs"
                      placeholder="claude-code, kin, codex"
                    />
                    <span className="text-[10px] text-kin-muted">
                      Comma-separated agent IDs that can use this provider for auto routing
                    </span>
                  </label>
                  {/* Model list for routing */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-kin-secondary">
                        {tr("settings.routing.models")}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setProvModels([...provModels, { id: "", tier: "balanced", cost_label: "unknown" }])
                        }
                        className="text-[11px] text-kin-blue hover:underline"
                      >
                        {tr("settings.routing.addModel")}
                      </button>
                    </div>
                    {provModels.map((m, i) => (
                      <div key={i} className="rounded border border-[var(--kin-hairline)] p-2 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-mono text-kin-muted">Model {i + 1}</span>
                          <button
                            type="button"
                            onClick={() => setProvModels(provModels.filter((_, j) => j !== i))}
                            className="text-[10px] text-kin-red hover:underline"
                          >
                            remove
                          </button>
                        </div>
                        <input
                          type="text"
                          value={m.id}
                          onChange={(e) => {
                            const next = [...provModels];
                            next[i] = { ...next[i], id: e.target.value };
                            setProvModels(next);
                          }}
                          className="kin-input min-h-[32px] text-xs font-mono"
                          placeholder="claude-sonnet-4-20250514"
                        />
                        <div className="flex gap-2">
                          <select
                            value={m.tier}
                            onChange={(e) => {
                              const next = [...provModels];
                              next[i] = { ...next[i], tier: e.target.value };
                              setProvModels(next);
                            }}
                            className="kin-input min-h-[32px] text-xs flex-1"
                          >
                            <option value="smart">smart</option>
                            <option value="balanced">balanced</option>
                            <option value="fast">fast</option>
                            <option value="free">free</option>
                          </select>
                          <select
                            value={m.cost_label}
                            onChange={(e) => {
                              const next = [...provModels];
                              next[i] = { ...next[i], cost_label: e.target.value };
                              setProvModels(next);
                            }}
                            className="kin-input min-h-[32px] text-xs flex-1"
                          >
                            <option value="paid">paid</option>
                            <option value="company">company</option>
                            <option value="free">free</option>
                            <option value="unknown">unknown</option>
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={provBusy}
                onClick={() => void saveProvider()}
                className="kin-btn-primary disabled:opacity-50"
              >
                {provBusy ? tr("settings.saving") : tr("settings.provider.saveEntry")}
              </button>
              <button
                type="button"
                disabled={provBusy}
                onClick={closeProviderForm}
                className="kin-btn-secondary disabled:opacity-50"
              >
                {tr("settings.provider.cancel")}
              </button>
            </div>
          </div>
        ) : null}

        <label className="block space-y-1">
          <span className="text-xs font-medium text-kin-secondary">
            {tr("settings.provider.defaultAgent")}
          </span>
          <select
            value={agentDefault}
            onChange={(e) => setAgentDefault(e.target.value)}
            className="kin-input min-h-[44px]"
          >
            <option value="">{tr("settings.provider.autoOption")}</option>
            {sortAgentCatalog(runnableAgents(agentList)).map((a) => {
              const state = agentCatalogState(a);
              let suffix = "";
              if (a.default) {
                suffix = tr("settings.provider.currentDefault").replace(/^\s*—\s*/, "");
              } else if (state === "generic") {
                suffix = tr("agentCatalog.generic");
              }
              return (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id})
                  {suffix ? ` — ${suffix}` : ""}
                </option>
              );
            })}
          </select>
          <span className="text-[11px] text-kin-muted">
            {tr("settings.provider.defaultAgentHint")}
          </span>
          {agentList.some((a) => !a.available) ? (
            <Link to="/agents" className="text-[11px] text-kin-blue hover:underline pt-1">
              {tr("agents.manageLink")}
            </Link>
          ) : null}
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="kin-btn-primary disabled:opacity-50"
        >
          {busy ? tr("settings.saving") : tr("settings.provider.save")}
        </button>
      </section>

      {/* Local Agent sessions */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <div>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
                {tr("settings.localAgents.heading")}
              </h2>
              <p className="mt-1 text-xs text-kin-muted leading-relaxed">
                {tr("settings.localAgents.desc")}
              </p>
            </div>
            <button
              type="button"
              disabled={refreshingAgentCatalog}
              onClick={() => void refreshAgentCatalog()}
              className="kin-btn-secondary text-[11px] min-h-[32px] disabled:opacity-50"
            >
              {refreshingAgentCatalog
                ? tr("settings.localAgents.refreshing")
                : tr("settings.localAgents.refresh")}
            </button>
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-kin-secondary">
            {tr("settings.localAgents.providersHeading")}
          </div>
          <div className="divide-y divide-[var(--kin-hairline)] rounded-lg border border-[var(--kin-hairline)]">
            {agentProviders.map((agent) => {
              const capabilities = new Map(
                (agent.capabilities ?? []).map((capability) => [capability.capability, capability]),
              );
              const statusText =
                agent.state === "available"
                  ? tr("settings.localAgents.available")
                  : agent.state === "unsupported"
                    ? tr("settings.localAgents.unsupported")
                    : agent.state === "not_detected"
                      ? tr("settings.localAgents.notDetected")
                      : agent.state === "degraded"
                        ? tr("settings.localAgents.degraded")
                        : agent.state === "permission_required"
                          ? tr("settings.localAgents.permissionRequired")
                          : tr("settings.localAgents.unavailable");
              const canImport = capabilities.get("session_list")?.state === "available";
              const capabilityBadge = (id: string, label: string) => {
                const capability = capabilities.get(id);
                if (!capability) return null;
                const supported = capability.state === "available";
                return (
                  <span
                    title={capability.evidence}
                    className={[
                      "px-1.5 py-0.5 rounded border text-[10px]",
                      supported
                        ? "border-kin-border text-kin-muted"
                        : "border-kin-orange/40 text-kin-orange",
                    ].join(" ")}
                  >
                    {supported
                      ? label
                      : `${label} · ${tr("settings.localAgents.capabilityUnsupported")}`}
                  </span>
                );
              };
              return (
                <div key={agent.id} className="px-3 py-2.5 flex items-center gap-3">
                  <span
                    className={[
                      "w-2 h-2 rounded-full flex-none",
                      agent.state === "available"
                        ? "bg-kin-blue"
                        : agent.state === "unsupported"
                          ? "bg-kin-orange"
                          : "bg-kin-muted",
                    ].join(" ")}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] text-kin-text truncate">
                      {agent.name || agent.id}
                    </div>
                    <div className="text-[10.5px] text-kin-muted truncate">
                      {agent.id}
                      {" · "}
                      {statusText}
                      {agent.reason ? ` · ${agent.reason}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {capabilityBadge("session_list", tr("settings.localAgents.listCapability"))}
                    {capabilityBadge("session_history_read", tr("settings.localAgents.historyCapability"))}
                    {capabilityBadge("session_attach", tr("settings.localAgents.attachCapability"))}
                    {capabilityBadge("resume", tr("settings.localAgents.resumeCapability"))}
                    {capabilities.size === 0 && (
                      <span className="text-[10.5px] text-kin-muted">
                        {tr("settings.localAgents.noCapabilities")}
                      </span>
                    )}
                    {canImport && (
                      <button
                        type="button"
                        disabled={importingSessions}
                        onClick={() => void importProviderSessions(agent.id)}
                        className="kin-btn-secondary px-2 py-1 text-[10px] min-h-[26px] disabled:opacity-50"
                      >
                        {tr("settings.localAgents.importProvider")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {agentProviders.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-kin-muted">
                {tr("settings.localAgents.noProviders")}
              </div>
            )}
          </div>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-kin-secondary">
            {tr("settings.localAgents.autoImport")}
          </span>
          <select
            value={autoImportMode}
            onChange={(e) =>
              setAutoImportMode(e.target.value as "prompt" | "enabled" | "disabled")
            }
            className="kin-input min-h-[44px]"
          >
            <option value="prompt">{tr("settings.localAgents.modePrompt")}</option>
            <option value="enabled">{tr("settings.localAgents.modeEnabled")}</option>
            <option value="disabled">{tr("settings.localAgents.modeDisabled")}</option>
          </select>
          <span className="text-[11px] text-kin-muted">
            {tr("settings.localAgents.policy")}
          </span>
          <div className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/40 px-3 py-2 text-[11px] text-kin-muted" role="status">
            <span className="font-medium text-kin-secondary">
              {autoImportMode === "enabled"
                ? tr("settings.localAgents.autoSyncEnabled")
                : tr("settings.localAgents.autoSyncDisabled")}
            </span>
            {" · "}
            {lastAutoImport
              ? tr("settings.localAgents.lastSync", {
                  value: formatSyncTime(lastAutoImport.synced_at),
                  imported: lastAutoImport.imported,
                  errors: Object.keys(lastAutoImport.errors ?? {}).length,
                })
              : tr("settings.localAgents.neverSynced")}
          </div>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={importingSessions}
            onClick={() => void importSessions()}
            className="kin-btn-secondary disabled:opacity-50"
          >
            {importingSessions
              ? tr("settings.localAgents.importing")
              : tr("settings.localAgents.import")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="kin-btn-primary disabled:opacity-50"
          >
            {busy ? tr("settings.saving") : tr("settings.localAgents.save")}
          </button>
        </div>
      </section>

      {/* Appearance (design 3c / 3e) */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
          {tr("settings.appearance.heading")}
        </h2>
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
                "px-3 py-2 rounded-lg text-[13px] font-medium min-h-[40px] border",
                theme === value
                  ? "border-kin-blue bg-kin-blue-soft text-kin-blue"
                  : "border-[var(--kin-hairline)] text-kin-secondary hover:bg-[var(--kin-fill)]",
              ].join(" ")}
            >
              {tr(`settings.appearance.${value}`)}
            </button>
          ))}
        </div>
      </section>

      {/* Remote Relay */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
              {tr("settings.relay.heading")}
            </h2>
            <p className="text-[12px] text-kin-secondary leading-relaxed">
              {tr("settings.relay.desc")}
            </p>
          </div>
          <span
            className={[
              "shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              relayState === "connected"
                ? "bg-kin-green/15 text-kin-green"
                : relayState === "connecting"
                  ? "bg-kin-yellow/15 text-kin-yellow"
                : relayState === "disabled"
                    ? "bg-[var(--kin-fill)] text-kin-muted"
                    : "bg-kin-red/15 text-kin-red",
            ].join(" ")}
          >
            {tr(`settings.relay.state.${relayState}` as "settings.relay.state.disabled")}
          </span>
        </div>
        <div className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/40 p-3 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-kin-secondary">
                {tr("settings.relay.cloudflareTitle")}
              </p>
              <p className="text-[11px] text-kin-muted leading-relaxed">
                {settings["cloudflare.authenticated"]
                  ? tr("settings.relay.cloudflareConnected", {
                      account: settings["cloudflare.account_name"] || settings["cloudflare.account_id"] || "Cloudflare",
                    })
                  : tr("settings.relay.cloudflareDesc")}
              </p>
            </div>
            <button
              type="button"
              disabled={cloudflareBusy || cloudflareDeploying}
              onClick={() => void connectCloudflare()}
              className="kin-btn-secondary min-h-[40px] disabled:opacity-50"
            >
              {settings["cloudflare.authenticated"]
                ? tr("settings.relay.reconnectCloudflare")
                : tr("settings.relay.connectCloudflare")}
            </button>
          </div>
          {settings["cloudflare.relay_last_error"] ? (
            <p className="text-xs text-kin-red" role="alert">
              {settings["cloudflare.relay_last_error"]}
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.relay.cloudflareAccount")}
              </span>
              <select
                value={cloudflareAccountID}
                onChange={(e) => {
                  const next = e.target.value;
                  setCloudflareAccountID(next);
                  setCloudflareZoneID("");
                  setCloudflareHostname("");
                  void refreshCloudflareZones(next);
                }}
                disabled={!settings["cloudflare.authenticated"] || cloudflareBusy || cloudflareDeploying || cloudflareBindingDomain}
                className="kin-input min-h-[44px]"
              >
                <option value="">
                  {settings["cloudflare.authenticated"]
                    ? tr("settings.relay.selectAccount")
                    : tr("settings.relay.loginFirst")}
                </option>
                {cloudflareAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name || account.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.relay.workerName")}
              </span>
              <input
                type="text"
                value={cloudflareScriptName}
                onChange={(e) => setCloudflareScriptName(e.target.value)}
                disabled={cloudflareBusy || cloudflareDeploying || cloudflareBindingDomain}
                className="kin-input min-h-[44px] font-mono text-xs"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.relay.cloudflareZone")}
              </span>
              <select
                value={cloudflareZoneID}
                onChange={(e) => {
                  const next = e.target.value;
                  setCloudflareZoneID(next);
                  const zone = cloudflareZones.find((z) => z.id === next);
                  setCloudflareHostname((current) => current || defaultRelayHostname(zone?.name ?? ""));
                }}
                disabled={!settings["cloudflare.authenticated"] || cloudflareBusy || cloudflareDeploying || cloudflareBindingDomain}
                className="kin-input min-h-[44px]"
              >
                <option value="">
                  {settings["cloudflare.authenticated"]
                    ? tr("settings.relay.selectZone")
                    : tr("settings.relay.loginFirst")}
                </option>
                {cloudflareZones.map((zone) => (
                  <option key={zone.id} value={zone.id}>
                    {zone.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.relay.customDomain")}
              </span>
              <input
                type="text"
                value={cloudflareHostname}
                onChange={(e) => setCloudflareHostname(e.target.value)}
                disabled={cloudflareBusy || cloudflareDeploying || cloudflareBindingDomain}
                placeholder={tr("settings.relay.customDomainPlaceholder")}
                className="kin-input min-h-[44px] font-mono text-xs"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={cloudflareBusy || cloudflareDeploying || cloudflareBindingDomain || !settings["cloudflare.authenticated"]}
              onClick={() => void refreshCloudflareAccounts()}
              className="kin-btn-secondary min-h-[40px] disabled:opacity-50"
            >
              {tr("settings.relay.refreshAccounts")}
            </button>
            <button
              type="button"
              disabled={
                cloudflareBusy ||
                cloudflareDeploying ||
                cloudflareBindingDomain ||
                !settings["cloudflare.authenticated"] ||
                !cloudflareAccountID.trim()
              }
              onClick={() => void deployRelayWorker()}
              className="kin-btn-primary min-h-[40px] disabled:opacity-50"
            >
              {cloudflareDeploying
                ? tr("settings.relay.deployingWorker")
                : tr("settings.relay.deployWorker")}
            </button>
            <button
              type="button"
              disabled={
                cloudflareBusy ||
                cloudflareDeploying ||
                cloudflareBindingDomain ||
                !settings["cloudflare.authenticated"] ||
                !cloudflareAccountID.trim() ||
                !cloudflareZoneID.trim()
              }
              onClick={() => void bindRelayCustomDomain()}
              className="kin-btn-secondary min-h-[40px] disabled:opacity-50"
            >
              {cloudflareBindingDomain
                ? tr("settings.relay.bindingDomain")
                : tr("settings.relay.bindDomain")}
            </button>
          </div>
          {settings["cloudflare.relay_worker_url"] ? (
            <p className="break-all font-mono text-[11px] text-kin-muted">
              {settings["cloudflare.relay_worker_url"]}
            </p>
          ) : null}
          {settings["cloudflare.relay_custom_domain_url"] ? (
            <p className="break-all font-mono text-[11px] text-kin-green">
              {settings["cloudflare.relay_custom_domain_url"]}
            </p>
          ) : null}
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-kin-secondary">
            {tr("settings.relay.workerUrl")}
          </span>
          <input
            type="url"
            value={relayURL}
            onChange={(e) => setRelayURL(e.target.value)}
            placeholder="https://kin-relay.example.workers.dev"
            className="kin-input min-h-[44px] font-mono text-xs"
            autoComplete="url"
          />
          <span className="text-[11px] text-kin-muted">
            {tr("settings.relay.workerUrlHint")}
          </span>
        </label>
        {settings["relay.last_error"] ? (
          <p className="text-xs text-kin-red" role="alert">
            {settings["relay.last_error"]}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={relayBusy}
            onClick={() => void saveRelay()}
            className="kin-btn-secondary min-h-[40px] disabled:opacity-50"
          >
            {relayBusy ? tr("settings.saving") : tr("settings.relay.save")}
          </button>
          {settings["relay.url"] ? (
            <button
              type="button"
              disabled={relayBusy}
              onClick={() => void refreshPairing()}
              className="kin-btn-secondary min-h-[40px] disabled:opacity-50"
            >
              {tr("settings.relay.refreshPairing")}
            </button>
          ) : null}
        </div>
        {settings["relay.pairing_url"] ? (
          <div className="flex flex-col sm:flex-row gap-4 items-start border-t border-[var(--kin-hairline)] pt-4">
            <div className="rounded-lg bg-white p-3 shrink-0">
              <QRCodeSVG value={settings["relay.pairing_url"]} size={160} level="M" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-xs font-medium text-kin-secondary">
                {tr("settings.relay.pairingTitle")}
              </p>
              <p className="break-all font-mono text-[11px] text-kin-muted">
                {settings["relay.pairing_url"]}
              </p>
              <button
                type="button"
                onClick={() => void copy(settings["relay.pairing_url"])}
                className="min-h-[40px] text-xs text-kin-blue hover:underline"
              >
                {tr("settings.connection.copyUrl")}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Connection */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
          {tr("settings.connection.heading")}
        </h2>
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          {connectURL ? (
            <div className="rounded-lg bg-white p-3 shrink-0">
              <QRCodeSVG value={connectURL} size={160} level="M" />
            </div>
          ) : (
            <div className="h-40 w-40 rounded-lg border border-dashed border-surface-border flex items-center justify-center text-xs text-zinc-500">
              {tr("settings.connection.noUrl")}
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <div className="text-xs text-kin-muted">
                {tr("settings.connection.networkMode")}
              </div>
              <div className="mt-0.5 font-mono text-sm text-kin-blue">{mode}</div>
            </div>
            {connectURL && (
              <div>
                <div className="text-xs text-kin-muted">
                  {tr("settings.connection.connectUrl")}
                </div>
                <div className="mt-0.5 break-all font-mono text-xs text-kin-secondary">
                  {connectURL}
                </div>
                <button
                  type="button"
                  onClick={() => void copy(connectURL)}
                  className="mt-1 min-h-[44px] text-xs text-kin-blue hover:underline"
                >
                  {tr("settings.connection.copyUrl")}
                </button>
              </div>
            )}
            <div>
              <div className="text-xs text-kin-muted">
                {tr("settings.connection.token")}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <code className="break-all font-mono text-xs text-kin-text">
                  {reveal ? token : token ? "••••••••••••••••" : "—"}
                </code>
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  className="min-h-[44px] text-xs text-kin-blue hover:underline"
                >
                  {reveal ? tr("settings.hide") : tr("settings.reveal")}
                </button>
                {token && (
                  <button
                    type="button"
                    onClick={() => void copy(token)}
                    className="min-h-[44px] text-xs text-kin-blue hover:underline"
                  >
                    {tr("settings.connection.copy")}
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-kin-muted">
                {tr("settings.connection.tokenHintA")}
                <code className="text-kin-secondary">kin token rotate</code>
                {tr("settings.connection.tokenHintB")}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Notifications */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
          {tr("settings.notify.heading")}
        </h2>
        <p className="text-xs text-kin-muted">
          {tr("settings.notify.descA")}
          <code className="text-kin-secondary">ui.base_url</code>
          {tr("settings.notify.descB")}
        </p>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-kin-secondary">
            {tr("settings.notify.barkUrl")}
          </span>
          <input
            type="url"
            value={bark}
            onChange={(e) => setBark(e.target.value)}
            placeholder="https://api.day.app/DEVICE_KEY"
            className="kin-input min-h-[44px]"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-kin-secondary">
            {tr("settings.notify.ntfyTopic")}
          </span>
          <input
            type="text"
            value={ntfy}
            onChange={(e) => setNtfy(e.target.value)}
            placeholder="my-kin-topic or https://ntfy.sh/my-kin-topic"
            className="kin-input min-h-[44px]"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-kin-secondary">
            {tr("settings.notify.uiBaseUrl")}
          </span>
          <input
            type="url"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="http://192.168.x.x:7777"
            className="kin-input min-h-[44px]"
          />
          <span className="text-xs text-kin-muted">
            {tr("settings.notify.uiBaseUrlHint")}
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-kin-secondary">
            {tr("settings.notify.quotaWaitAfter")}
          </span>
          <input
            type="number"
            min={60}
            step={60}
            value={quotaWaitNotifySecs}
            onChange={(e) => setQuotaWaitNotifySecs(e.target.value)}
            className="kin-input min-h-[44px]"
          />
          <span className="text-xs text-kin-muted">
            {tr("settings.notify.quotaWaitAfterHint")}
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="kin-btn-primary disabled:opacity-50"
          >
            {busy ? tr("settings.saving") : tr("settings.notify.save")}
          </button>
          <button
            type="button"
            disabled={testing || busy}
            onClick={() => void sendTest()}
            className="kin-btn-secondary disabled:opacity-50"
          >
            {testing ? tr("settings.notify.sending") : tr("settings.notify.sendTest")}
          </button>
          {saved && (
            <span className="text-xs text-kin-green">
              {tr("settings.notify.savedShort")}
            </span>
          )}
          {error && <span className="text-xs text-kin-red">{error}</span>}
        </div>
      </section>

      {/* Price table (M4) — defaults from open LiteLLM price list */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
            {tr("settings.price.heading")}
          </h2>
          <a
            href="https://github.com/BerriAI/litellm"
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-kin-blue hover:underline shrink-0"
            title={tr("settings.price.sourceHint")}
          >
            {tr("settings.price.sourceName")} ↗
          </a>
        </div>
        <p className="text-xs text-kin-muted leading-relaxed">
          {tr("settings.price.descA")}
          <code className="text-kin-secondary">total_cost_usd</code>
          {tr("settings.price.descB")}
          <a
            href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json"
            target="_blank"
            rel="noreferrer"
            className="text-kin-blue hover:underline"
          >
            {tr("settings.price.sourceName")}
          </a>
          {tr("settings.price.descC")}
          <code className="text-kin-secondary">
            {`{"model": {"in": 1.25, "out": 10.0}}`}
          </code>
        </p>
        <p className="text-[11px] text-kin-muted">
          {tr("settings.price.sourceHint")}
          {" · "}
          {tr("settings.price.overrideHint")}
        </p>
        <textarea
          value={priceTable}
          onChange={(e) => setPriceTable(e.target.value)}
          rows={10}
          spellCheck={false}
          className="kin-input font-mono text-xs resize-y min-h-[160px]"
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
            onClick={() => void (async () => {
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
            })()}
            className="kin-btn-secondary disabled:opacity-50"
            title={tr("settings.price.sourceHint")}
          >
            {tr("settings.price.resetDefaults")}
          </button>
        </div>
      </section>


      {/* Rate-limit policy */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
          {tr("settings.limitPolicy.heading")}
        </h2>
        <p className="text-xs text-kin-muted">{tr("settings.limitPolicy.desc")}</p>
        <div className="flex flex-col gap-2">
          {(
            [
              ["wait", "settings.limitPolicy.wait"],
              ["ask", "settings.limitPolicy.ask"],
              ["switch", "settings.limitPolicy.switch"],
            ] as const
          ).map(([value, labelKey]) => (
            <label key={value} className="flex items-center gap-2 text-[13px] text-kin-secondary cursor-pointer">
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
            <span className="text-[11px] text-kin-muted">{tr("settings.limitPolicy.fallback")}</span>
            <input
              value={limitFallbackText}
              onChange={(e) => setLimitFallbackText(e.target.value)}
              className="kin-input font-mono text-xs"
              spellCheck={false}
            />
            <span className="text-[11px] text-kin-muted">{tr("settings.limitPolicy.fallbackHint")}</span>
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

      {/* Agent usage limits */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
          {tr("settings.agentLimits.heading")}
        </h2>
        <p className="text-xs text-kin-muted">
          {tr("settings.agentLimits.desc")}
          <code className="text-kin-secondary">{tr("settings.agentLimits.shape")}</code>
        </p>
        <textarea
          value={agentLimitsText}
          onChange={(e) => setAgentLimitsText(e.target.value)}
          rows={6}
          spellCheck={false}
          className="kin-input font-mono text-xs resize-y min-h-[100px]"
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
          {error && <span className="text-xs text-kin-red">{error}</span>}
        </div>
      </section>
      </div>
    </div>
  );
}
