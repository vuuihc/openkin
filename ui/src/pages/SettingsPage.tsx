import { useCallback, useEffect, useRef, useState } from "react";
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
  listCloudflareAccounts,
  listCloudflareZones,
  listAgentProviders,
  listAgents,
  listProviderModels,
  listProviders,
  refreshRelayPairing,
  startCloudflareOAuth,
  updateProvider,
  updateSettings,
  type AgentInfo,
  type AgentProvider,
  type CloudflareAccount,
  type CloudflareZone,
  type ModelSpec,
  type ProviderEntry,
  type Settings,
} from "../api/client";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import SearchSelect from "../components/ui/SearchSelect";
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
import { NativePushSettings } from "../components/settings/NativePushSettings";
import { PhoneSection } from "../components/settings/PhoneSection";
import { relayPrimaryAction } from "../components/settings/RelayGuidance";
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
import { useLeaveGuard } from "../hooks/useLeaveGuard";
import { applyTheme, getThemeMode, setThemeMode, type ThemeMode } from "../lib/theme";
import { leaveDocument } from "../lib/fullPageNavigation";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";

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

function prettyJSON(raw: string | undefined, fallback: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || fallback), null, 2);
  } catch {
    return raw ?? fallback;
  }
}

type SettingsDraft = {
  quota: string;
  baseURL: string;
  relayURL: string;
  priceTable: string;
  agentLimits: string;
  roles: AgentRole[];
  agentDefault: string;
  limitPolicy: string;
  limitFallback: string;
};

// What the role editor is showing, not what its serializer keeps. A row with
// only a name is on screen as a draft and would be discarded on the way out,
// even though Save itself drops it; comparing the raw fields is what lets the
// leave guard tell the reader so.
function agentRolesDraftKey(roles: readonly AgentRole[]): string {
  return JSON.stringify(roles.map((role) => [role.id, role.name, role.prompt]));
}

// Every field save() writes, plus the relay URL that has its own Save. The
// baseline is built from the server payload rather than from the controlled
// inputs: a reconnect reload may normalize the JSON text, and a dirty flag that
// survives that normalization would nag on an untouched page.
function settingsDraftKey(v: SettingsDraft): string {
  return JSON.stringify([
    v.quota,
    v.baseURL,
    v.relayURL,
    v.priceTable,
    v.agentLimits,
    agentRolesDraftKey(v.roles),
    v.agentDefault,
    v.limitPolicy,
    v.limitFallback,
  ]);
}

function settingsDraftFromServer(s: Settings): SettingsDraft {
  return {
    quota: s["notify.quota_wait_after_secs"] || "900",
    baseURL: s["ui.base_url"] ?? "",
    relayURL: s["relay.url"] ?? "",
    priceTable: prettyJSON(s.price_table, "{}"),
    agentLimits: prettyJSON(s.agent_limits, "{}"),
    roles: parseAgentRoles(s.agent_roles),
    agentDefault: s["agent.default"] ?? "",
    limitPolicy: (s.limit_policy as string) || "wait",
    limitFallback: s["limit_policy.fallback_agents"] || "[]",
  };
}

/**
 * The Cloudflare deploy/bind form. These are editable inputs with their own
 * server values, so they are drafts like every other form on the page: an
 * outright reconnect or a relay jump must not silently replace them.
 */
type CloudflareDraft = {
  accountID: string;
  zoneID: string;
  hostname: string;
  scriptName: string;
};

const CLOUDFLARE_DEFAULT_SCRIPT = "kin-relay";

function cloudflareDraftFromServer(s: Settings): CloudflareDraft {
  return {
    accountID: s["cloudflare.account_id"] ?? "",
    zoneID: s["cloudflare.relay_zone_id"] ?? "",
    hostname: s["cloudflare.relay_custom_domain"] ?? "",
    scriptName: s["cloudflare.relay_script_name"] || CLOUDFLARE_DEFAULT_SCRIPT,
  };
}

function cloudflareDraftKey(v: CloudflareDraft): string {
  return JSON.stringify([v.accountID, v.zoneID, v.hostname, v.scriptName]);
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

function providerDraftKey(v: ProviderDraft): string {
  return JSON.stringify([
    v.name,
    v.base,
    v.key,
    v.model.trim(),
    v.stream,
    v.keyDirty,
    v.supportsAgents
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    v.models,
  ]);
}

export default function SettingsPage() {
  const tr = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
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
  const [saved, setSaved] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => getThemeMode());
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() =>
    typeof window === "undefined" ? "general" : settingsTabFromSearch(window.location.search),
  );
  const [workerDevUnreachable, setWorkerDevUnreachable] = useState(false);
  const [customDomainTouched, setCustomDomainTouched] = useState(false);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const pushToast = useAppStore((s) => s.pushToast);
  const slow = useSlowHint(!settings && !error);

  // Leave guard baselines. The page owns several independent forms that only
  // persist on an explicit Save; a phone edge swipe or system Back would
  // otherwise unmount it and silently drop them. Each baseline is the last
  // saved (or freshly opened) value, so typing then undoing is clean again.
  const [settingsBaseline, setSettingsBaseline] = useState<string | null>(null);
  const [providerBaseline, setProviderBaseline] = useState<string | null>(null);
  const [routingDirty, setRoutingDirty] = useState({ defaults: false, profiles: false });
  const [cloudflareBaseline, setCloudflareBaseline] = useState<string | null>(null);

  const settingsDraftValues: SettingsDraft = {
    quota: quotaWaitNotifySecs,
    baseURL,
    relayURL,
    priceTable,
    agentLimits: agentLimitsText,
    roles,
    agentDefault,
    limitPolicy,
    limitFallback: limitFallbackText,
  };
  const settingsDraft = settingsDraftKey(settingsDraftValues);
  // The latest rendered values, for async callbacks (a save or reload that
  // resolves after the reader kept typing) that must compare drafts without
  // re-creating themselves on every keystroke.
  const draftValuesRef = useRef(settingsDraftValues);
  useEffect(() => {
    draftValuesRef.current = settingsDraftValues;
  });
  // The last payload the server handed us, so a reconnect reload can tell a
  // field the reader changed from one the server changed under them.
  const serverDraftRef = useRef<SettingsDraft | null>(null);
  const settingsDirty =
    settings !== null && settingsBaseline !== null && settingsDraft !== settingsBaseline;

  // The Cloudflare form's own draft and last server snapshot, for the same
  // reason: a reconnect fills what the reader left alone and keeps the rest.
  const cloudflareDraftValues: CloudflareDraft = {
    accountID: cloudflareAccountID,
    zoneID: cloudflareZoneID,
    hostname: cloudflareHostname,
    scriptName: cloudflareScriptName,
  };
  const cloudflareDraft = cloudflareDraftKey(cloudflareDraftValues);
  const cloudflareDirty =
    cloudflareBaseline !== null && cloudflareDraft !== cloudflareBaseline;
  const cloudflareDraftRef = useRef(cloudflareDraftValues);
  const cloudflareServerRef = useRef<CloudflareDraft | null>(null);
  useEffect(() => {
    cloudflareDraftRef.current = cloudflareDraftValues;
  });

  // Adopt a server snapshot as the new baseline. With `preserveDirty`, a field
  // the reader has edited since the last snapshot keeps their text — a
  // reconnect is not an edit — while untouched fields take the server's.
  const applyServerSettings = useCallback((s: Settings, preserveDirty: boolean) => {
    const next = settingsDraftFromServer(s);
    const prev = serverDraftRef.current;
    const current = draftValuesRef.current;
    const keep = <K extends keyof SettingsDraft>(key: K): SettingsDraft[K] => {
      const edited =
        preserveDirty &&
        prev !== null &&
        JSON.stringify(current[key]) !== JSON.stringify(prev[key]);
      return edited ? current[key] : next[key];
    };
    setQuotaWaitNotifySecs(keep("quota"));
    setBaseURL(keep("baseURL"));
    setRelayURL(keep("relayURL"));
    setPriceTable(keep("priceTable"));
    setAgentLimitsText(keep("agentLimits"));
    setRoles(keep("roles"));
    setAgentDefault(keep("agentDefault"));
    setLimitPolicy(keep("limitPolicy"));
    setLimitFallbackText(keep("limitFallback"));
    serverDraftRef.current = next;
    setSettingsBaseline(settingsDraftKey(next));
  }, []);

  // Adopt the Cloudflare side of a server snapshot. Same rule as the settings
  // form: a rerender fills the untouched inputs and leaves the reader's text.
  const applyServerCloudflare = useCallback((s: Settings, preserveDirty: boolean) => {
    const next = cloudflareDraftFromServer(s);
    const prev = cloudflareServerRef.current;
    const current = cloudflareDraftRef.current;
    const keep = <K extends keyof CloudflareDraft>(key: K): CloudflareDraft[K] =>
      preserveDirty && prev !== null && current[key] !== prev[key] ? current[key] : next[key];
    setCloudflareAccountID(keep("accountID"));
    setCloudflareZoneID(keep("zoneID"));
    setCloudflareHostname(keep("hostname"));
    setCloudflareScriptName(keep("scriptName"));
    cloudflareServerRef.current = next;
    setCloudflareBaseline(cloudflareDraftKey(next));
  }, []);

  /** Move the Cloudflare baseline to a server snapshot without touching the
   *  inputs: a response that saved a subset must not rewrite the rest. */
  const rebaseCloudflareBaseline = useCallback((s: Settings) => {
    const next = cloudflareDraftFromServer(s);
    cloudflareServerRef.current = next;
    setCloudflareBaseline(cloudflareDraftKey(next));
  }, []);

  // A response that wrote one field without touching the others: only the
  // baseline moves, never a draft this request did not carry.
  const syncServerBaseline = useCallback(
    (s: Settings) => {
      const next = settingsDraftFromServer(s);
      serverDraftRef.current = next;
      setSettingsBaseline(settingsDraftKey(next));
      rebaseCloudflareBaseline(s);
    },
    [rebaseCloudflareBaseline],
  );

  /**
   * Adopt a normal save's answer.
   *
   * The server answers with the whole settings map, but this request carried
   * only the fields set below; the relay URL has its own Save and is never
   * written here, however late the answer lands. A carried field takes the
   * server's value only if the reader has not typed into it since the request
   * left. The baseline still becomes the server snapshot, so a kept edit
   * stays dirty.
   */
  const applySavedSettings = useCallback(
    (s: Settings, submitted: SettingsDraft) => {
      const next = settingsDraftFromServer(s);
      const current = draftValuesRef.current;
      const take = (key: keyof SettingsDraft) =>
        JSON.stringify(current[key]) === JSON.stringify(submitted[key]);
      if (take("quota")) setQuotaWaitNotifySecs(next.quota);
      if (take("baseURL")) setBaseURL(next.baseURL);
      if (take("priceTable")) setPriceTable(next.priceTable);
      if (take("agentLimits")) setAgentLimitsText(next.agentLimits);
      if (take("roles")) setRoles(next.roles);
      if (take("agentDefault")) setAgentDefault(next.agentDefault);
      if (take("limitPolicy")) setLimitPolicy(next.limitPolicy);
      if (take("limitFallback")) setLimitFallbackText(next.limitFallback);
      serverDraftRef.current = next;
      setSettingsBaseline(settingsDraftKey(next));
      rebaseCloudflareBaseline(s);
    },
    [rebaseCloudflareBaseline],
  );

  const providerDraft =
    editingId === null
      ? null
      : providerDraftKey({
          name: provName,
          base: provBase,
          key: provKey,
          model: provModel,
          stream: provStream,
          keyDirty: provKeyDirty,
          supportsAgents: provSupportsAgents,
          models: provModels,
        });
  const providerDirty =
    providerDraft !== null && providerBaseline !== null && providerDraft !== providerBaseline;

  // The async answers below (a relay save, a deploy) may land after the reader
  // has opened another form. Their closures were created at click time, so the
  // dirty answers have to be read from the latest commit, not captured.
  const liveDirtyRef = useRef({
    provider: false,
    routingDefaults: false,
    routingProfiles: false,
  });
  useEffect(() => {
    liveDirtyRef.current = {
      provider: providerDirty,
      routingDefaults: routingDirty.defaults,
      routingProfiles: routingDirty.profiles,
    };
  });

  const formDirty =
    settingsDirty ||
    providerDirty ||
    routingDirty.defaults ||
    routingDirty.profiles ||
    cloudflareDirty;
  const canLeaveSettings = useCallback(
    () => !formDirty || window.confirm(tr("settings.discardConfirm")),
    [formDirty, tr],
  );
  useLeaveGuard(canLeaveSettings, formDirty);

  // The in-app guard covers Back, the edge swipe and shortcuts. A reload, a
  // closed tab or a typed address is the browser's own departure, and this is
  // the only warning it will show for it.
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
    setRoutingDirty((prev) => (prev.defaults === dirty ? prev : { ...prev, defaults: dirty }));
  }, []);
  const onRoutingProfilesDirty = useCallback((dirty: boolean) => {
    setRoutingDirty((prev) => (prev.profiles === dirty ? prev : { ...prev, profiles: dirty }));
  }, []);


  const load = useCallback(
    async (preserveDirty = false) => {
      setError(null);
      try {
        const s = await getSettings();
        setSettings(s);
        setActiveProviderId(s["provider.active_id"] ?? "");
        applyServerSettings(s, preserveDirty);
        applyServerCloudflare(s, preserveDirty);
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
        if (!s["cloudflare.authenticated"]) {
          setCloudflareAccounts([]);
          setCloudflareZones([]);
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [applyServerSettings, applyServerCloudflare],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    // A reconnect re-reads the server under a page that may still hold edits;
    // the reload fills what the reader left alone and leaves their text alone.
    void load(true);
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
      const submitted = draftValuesRef.current;
      const body: Parameters<typeof updateSettings>[0] = {
        "notify.quota_wait_after_secs": quotaWaitNotifySecs.trim() || "900",
        "ui.base_url": baseURL.trim(),
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
      // The serializer drops half-written rows, so show what was saved rather
      // than keep the draft; a field this request did not carry, or one the
      // reader changed while it was out, keeps their text and stays dirty.
      applySavedSettings(s, submitted);
      setSaved(true);
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
      window.dispatchEvent(new CustomEvent("kin:agent-sessions-changed"));
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
      window.dispatchEvent(new CustomEvent("kin:agent-sessions-changed"));
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
    setProviderBaseline(null);
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

  // The answer's saved snapshot becomes the baseline; the drafts on screen are
  // only rewritten when the caller says this request owned that form.
  const applyRelaySettings = (s: Settings, keepRelayDraft = false) => {
    setSettings(s);
    if (!keepRelayDraft) setRelayURL(s["relay.url"] ?? "");
    syncServerBaseline(s);
  };

  // Leaving for the relay's origin replaces the whole document and there is no
  // Back from it. The relay URL this request carried is saved; every other
  // form on the page is a draft the reload would silently drop — including
  // text typed into the relay box itself while the request was out, and a
  // provider or routing draft opened after the click.
  const hasUnsavedDrafts = (s: Settings): boolean => {
    const saved = settingsDraftKey(settingsDraftFromServer(s));
    const live = liveDirtyRef.current;
    return (
      settingsDraftKey(draftValuesRef.current) !== saved ||
      live.provider ||
      live.routingDefaults ||
      live.routingProfiles ||
      cloudflareDraftKey(cloudflareDraftRef.current) !==
        cloudflareDraftKey(cloudflareDraftFromServer(s))
    );
  };

  const adoptRelaySettings = (s: Settings) => {
    const target = s["relay.open_url"]
      ? s["relay.open_url"]
      : s["ui.base_url"]
        ? `${s["ui.base_url"].replace(/\/+$/, "")}/?token=${encodeURIComponent(s.token)}`
        : "";
    // The response saved what the request carried. A live value that differs
    // from it is text typed while the request was out; adopting the answer
    // must not write the old value back over it.
    const liveRelay = draftValuesRef.current.relayURL;
    const savedRelay = s["relay.url"] ?? "";
    const relayKept = liveRelay.trim() !== savedRelay;
    if (!target) {
      applyRelaySettings(s, relayKept);
      adoptRelayURL("");
      return;
    }
    if (hasUnsavedDrafts(s) && !window.confirm(tr("settings.discardConfirm"))) {
      // Refusing the jump keeps every draft exactly as it is on screen.
      applyRelaySettings(s, true);
      return;
    }
    applyRelaySettings(s);
    adoptRelayURL(s["relay.open_url"] ?? "");
    leaveDocument(target);
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
                setCloudflareHostname(
                  (current) => current || defaultRelayHostname(zoneRes.zones[0].name),
                );
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
      const accountID =
        next["cloudflare.account_id"] || cloudflareAccountID || res.accounts?.[0]?.id || "";
      if (accountID) {
        const zoneRes = await listCloudflareZones(accountID);
        setCloudflareZones(zoneRes.zones ?? []);
        if (!cloudflareZoneID && zoneRes.zones?.length === 1) {
          setCloudflareZoneID(zoneRes.zones[0].id);
          setCloudflareHostname(
            (current) => current || defaultRelayHostname(zoneRes.zones[0].name),
          );
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

  const bindRelayCustomDomain = async (
    zoneID = cloudflareZoneID,
    hostname = cloudflareHostname,
  ) => {
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
      setWorkerDevUnreachable(false);
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
        setWorkerDevUnreachable(true);
        pushToast(tr("settings.relay.workerDevUnreachable"), "error");
        const zones = cloudflareZones.length
          ? cloudflareZones
          : await refreshCloudflareZones(cloudflareAccountID);
        if (zones.length === 1) {
          await bindRelayCustomDomain(zones[0].id, defaultRelayHostname(zones[0].name));
        }
      } else {
        setWorkerDevUnreachable(false);
        adoptRelaySettings(s);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCloudflareDeploying(false);
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
  const hasCloudflareWorker = !!settings["cloudflare.relay_worker_url"];
  const hasCloudflareCustomDomain = !!settings["cloudflare.relay_custom_domain_url"];
  const accountOptions =
    cloudflareAccountID && !cloudflareAccounts.some((account) => account.id === cloudflareAccountID)
      ? [
          {
            id: cloudflareAccountID,
            name: settings["cloudflare.account_name"] || cloudflareAccountID,
          },
          ...cloudflareAccounts,
        ]
      : cloudflareAccounts;
  const zoneOptions =
    cloudflareZoneID && !cloudflareZones.some((zone) => zone.id === cloudflareZoneID)
      ? [
          {
            id: cloudflareZoneID,
            name: settings["cloudflare.relay_zone_name"] || cloudflareZoneID,
          },
          ...cloudflareZones,
        ]
      : cloudflareZones;
  const cloudflareNeedsAccountRefresh =
    !!settings["cloudflare.authenticated"] &&
    !cloudflareAccountID.trim() &&
    accountOptions.length === 0;
  const relayPrimary = relayPrimaryAction({
    cloudflareAuthenticated: !!settings["cloudflare.authenticated"],
    needsAccountRefresh: cloudflareNeedsAccountRefresh,
    hasAccount: !!cloudflareAccountID.trim(),
    hasWorker: hasCloudflareWorker,
    hasZone: !!cloudflareZoneID.trim(),
    hasCustomDomain: hasCloudflareCustomDomain,
    customDomainRecommended: workerDevUnreachable || customDomainTouched,
  });
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
      id: "remote",
      label: tr("settings.tabs.remote"),
      description: tr("settings.tabs.remoteDesc"),
    },
    {
      id: "notifications",
      label: tr("settings.tabs.notifications"),
      description: tr("settings.tabs.notificationsDesc"),
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
        {/* First, and on the first tab, because this is the tab a phone opens
            and because the question it answers — how do I use this from here —
            was the one the console could not answer at all. */}
        <PhoneSection baseUrl={settings["ui.base_url"] ?? ""} onOpenTab={setActiveTab} />
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
      </SettingsTabPanel>

      {/* Remote Relay */}
      <SettingsTabPanel id="remote" active={activeTab === "remote"}>
        <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
                {tr("settings.relay.heading")}
              </h2>
              <p className="text-body text-kin-secondary leading-prose">
                {tr("settings.relay.desc")}
              </p>
            </div>
            <span
              className={[
                "shrink-0 rounded-full px-2 py-1 text-micro font-semibold uppercase tracking-label",
                relayState === "connected"
                  ? "bg-kin-green/15 text-kin-green-ink"
                  : relayState === "connecting"
                    ? "bg-kin-orange/15 text-kin-orange-ink"
                    : relayState === "disabled"
                      ? "bg-[var(--kin-fill)] text-kin-muted"
                      : "bg-kin-red/15 text-kin-red-ink",
              ].join(" ")}
            >
              {tr(`settings.relay.state.${relayState}` as "settings.relay.state.disabled")}
            </span>
          </div>
          <div className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-3 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div className="space-y-1">
                <p className="text-body leading-4 font-medium text-kin-secondary">
                  {tr("settings.relay.cloudflareTitle")}
                </p>
                <p className="text-caption text-kin-muted leading-prose">
                  {settings["cloudflare.authenticated"]
                    ? tr("settings.relay.cloudflareConnected", {
                        account:
                          settings["cloudflare.account_name"] ||
                          settings["cloudflare.account_id"] ||
                          "Cloudflare",
                      })
                    : tr("settings.relay.cloudflareDesc")}
                </p>
              </div>
              <button
                type="button"
                disabled={cloudflareBusy || cloudflareDeploying || cloudflareBindingDomain}
                onClick={() => void connectCloudflare()}
                className={[
                  relayPrimary === "connect-cloudflare" ? "kin-btn-primary" : "kin-btn-secondary",
                  "min-h-10 disabled:opacity-50",
                ].join(" ")}
              >
                {settings["cloudflare.authenticated"]
                  ? tr("settings.relay.reconnectCloudflare")
                  : tr("settings.relay.connectCloudflare")}
              </button>
            </div>
            {settings["cloudflare.relay_last_error"] ? (
              <p className="text-body leading-4 text-kin-red-ink" role="alert">
                {settings["cloudflare.relay_last_error"]}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
              <div className="block space-y-1">
                <span className="text-body leading-4 font-medium text-kin-secondary">
                  {tr("settings.relay.cloudflareAccount")}
                </span>
                <SearchSelect
                  variant="field"
                  label={tr("settings.relay.cloudflareAccount")}
                  value={cloudflareAccountID}
                  options={[
                    {
                      id: "",
                      label: settings["cloudflare.authenticated"]
                        ? tr("settings.relay.selectAccount")
                        : tr("settings.relay.loginFirst"),
                    },
                    ...accountOptions.map((account) => ({
                      id: account.id,
                      label: account.name || account.id,
                    })),
                  ]}
                  onChange={(next) => {
                    setCloudflareAccountID(next);
                    setCloudflareZoneID("");
                    setCloudflareHostname("");
                    setCustomDomainTouched(false);
                    void refreshCloudflareZones(next);
                  }}
                  disabled={
                    !settings["cloudflare.authenticated"] ||
                    cloudflareBusy ||
                    cloudflareDeploying ||
                    cloudflareBindingDomain
                  }
                />
              </div>
              <label className="block space-y-1">
                <span className="text-body leading-4 font-medium text-kin-secondary">
                  {tr("settings.relay.workerName")}
                </span>
                <input
                  type="text"
                  value={cloudflareScriptName}
                  onChange={(e) => setCloudflareScriptName(e.target.value)}
                  disabled={cloudflareBusy || cloudflareDeploying || cloudflareBindingDomain}
                  className="kin-input min-h-11 font-mono text-body leading-4"
                  autoComplete="off"
                />
              </label>
            </div>
            {hasCloudflareWorker ? (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                <div className="block space-y-1">
                  <span className="text-body leading-4 font-medium text-kin-secondary">
                    {tr("settings.relay.cloudflareZone")}
                  </span>
                  <SearchSelect
                    variant="field"
                    label={tr("settings.relay.cloudflareZone")}
                    value={cloudflareZoneID}
                    options={[
                      {
                        id: "",
                        label: settings["cloudflare.authenticated"]
                          ? tr("settings.relay.selectZone")
                          : tr("settings.relay.loginFirst"),
                      },
                      ...zoneOptions.map((zone) => ({ id: zone.id, label: zone.name })),
                    ]}
                    onChange={(next) => {
                      setCloudflareZoneID(next);
                      const zone = cloudflareZones.find((z) => z.id === next);
                      setCloudflareHostname(
                        (current) => current || defaultRelayHostname(zone?.name ?? ""),
                      );
                    }}
                    disabled={
                      !settings["cloudflare.authenticated"] ||
                      cloudflareBusy ||
                      cloudflareDeploying ||
                      cloudflareBindingDomain
                    }
                  />
                </div>
                <label className="block space-y-1">
                  <span className="text-body leading-4 font-medium text-kin-secondary">
                    {tr("settings.relay.customDomain")}
                  </span>
                  <input
                    type="text"
                    value={cloudflareHostname}
                    onChange={(e) => {
                      setCloudflareHostname(e.target.value);
                      setCustomDomainTouched(true);
                    }}
                    disabled={cloudflareBusy || cloudflareDeploying || cloudflareBindingDomain}
                    placeholder={tr("settings.relay.customDomainPlaceholder")}
                    className="kin-input min-h-11 font-mono text-body leading-4"
                    autoComplete="off"
                  />
                </label>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={
                  cloudflareBusy ||
                  cloudflareDeploying ||
                  cloudflareBindingDomain ||
                  !settings["cloudflare.authenticated"]
                }
                onClick={() => void refreshCloudflareAccounts()}
                className={[
                  relayPrimary === "refresh-accounts" ? "kin-btn-primary" : "kin-btn-secondary",
                  "min-h-10 disabled:opacity-50",
                ].join(" ")}
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
                className={[
                  relayPrimary === "deploy-worker" ? "kin-btn-primary" : "kin-btn-secondary",
                  "min-h-10 disabled:opacity-50",
                ].join(" ")}
              >
                {cloudflareDeploying
                  ? tr("settings.relay.deployingWorker")
                  : hasCloudflareWorker
                    ? tr("settings.relay.updateWorker")
                    : tr("settings.relay.deployWorker")}
              </button>
              {hasCloudflareWorker ? (
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
                  className={[
                    relayPrimary === "bind-domain" ? "kin-btn-primary" : "kin-btn-secondary",
                    "min-h-10 disabled:opacity-50",
                  ].join(" ")}
                >
                  {cloudflareBindingDomain
                    ? tr("settings.relay.bindingDomain")
                    : tr("settings.relay.bindDomain")}
                </button>
              ) : null}
            </div>
            {!hasCloudflareWorker && settings["cloudflare.authenticated"] ? (
              <p className="text-caption text-kin-muted leading-prose">
                {tr("settings.relay.deployFirst")}
              </p>
            ) : null}
            {settings["cloudflare.relay_worker_url"] ? (
              <p className="[overflow-wrap:anywhere] font-mono text-caption text-kin-muted">
                {settings["cloudflare.relay_worker_url"]}
              </p>
            ) : null}
            {settings["cloudflare.relay_custom_domain_url"] ? (
              <p className="[overflow-wrap:anywhere] font-mono text-caption text-kin-green-ink">
                {settings["cloudflare.relay_custom_domain_url"]}
              </p>
            ) : null}
          </div>
          <label className="block space-y-1">
            <span className="text-body leading-4 font-medium text-kin-secondary">
              {tr("settings.relay.workerUrl")}
            </span>
            <input
              type="url"
              value={relayURL}
              onChange={(e) => setRelayURL(e.target.value)}
              placeholder="https://kin-relay.example.workers.dev"
              className="kin-input min-h-11 font-mono text-body leading-4"
              autoComplete="url"
            />
            <span className="text-caption text-kin-muted">
              {tr("settings.relay.workerUrlHint")}
            </span>
          </label>
          {settings["relay.last_error"] ? (
            <p className="text-body leading-4 text-kin-red-ink" role="alert">
              {settings["relay.last_error"]}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={relayBusy}
              onClick={() => void saveRelay()}
              className="kin-btn-secondary min-h-10 disabled:opacity-50"
            >
              {relayBusy ? tr("settings.saving") : tr("settings.relay.save")}
            </button>
            {settings["relay.url"] ? (
              <button
                type="button"
                disabled={relayBusy}
                onClick={() => void refreshPairing()}
                className="kin-btn-secondary min-h-10 disabled:opacity-50"
              >
                {tr("settings.relay.refreshPairing")}
              </button>
            ) : null}
          </div>
          {settings["relay.pairing_url"] ? (
            <div className="flex flex-col sm:flex-row gap-4 items-start border-t border-[var(--kin-hairline)] pt-4">
              {/* White, and not a token: this is the QR's quiet zone. A scanner
                  needs the light margin the code was rendered against, so the
                  one square on this page that must not follow the theme is the
                  one a camera reads. */}
              <div className="rounded-lg bg-white p-3 shrink-0">
                <QRCodeSVG value={settings["relay.pairing_url"]} size={160} level="M" />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-body leading-4 font-medium text-kin-secondary">
                  {tr("settings.relay.pairingTitle")}
                </p>
                <p className="[overflow-wrap:anywhere] font-mono text-caption text-kin-muted">
                  {settings["relay.pairing_url"]}
                </p>
                <button
                  type="button"
                  onClick={() => void copy(settings["relay.pairing_url"])}
                  className="min-h-10 text-body leading-4 text-kin-blue-ink hover:underline"
                >
                  {tr("settings.connection.copyUrl")}
                </button>
              </div>
            </div>
          ) : null}
        </section>

        {/* Connection */}
        <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
          <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
            {tr("settings.connection.heading")}
          </h2>
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            {connectURL ? (
              // Same quiet zone as the pairing code above.
              <div className="rounded-lg bg-white p-3 shrink-0">
                <QRCodeSVG value={connectURL} size={160} level="M" />
              </div>
            ) : (
              <div className="h-40 w-40 rounded-lg border border-dashed border-kin-hairline-strong flex items-center justify-center text-body leading-4 text-kin-muted">
                {tr("settings.connection.noUrl")}
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <div className="text-body leading-4 text-kin-muted">
                  {tr("settings.connection.networkMode")}
                </div>
                <div className="mt-0.5 font-mono text-strong leading-5 text-kin-blue-ink">
                  {mode}
                </div>
              </div>
              {connectURL && (
                <div>
                  <div className="text-body leading-4 text-kin-muted">
                    {tr("settings.connection.connectUrl")}
                  </div>
                  <div className="mt-0.5 [overflow-wrap:anywhere] font-mono text-body leading-4 text-kin-secondary">
                    {connectURL}
                  </div>
                  <button
                    type="button"
                    onClick={() => void copy(connectURL)}
                    className="mt-1 min-h-11 text-body leading-4 text-kin-blue-ink hover:underline"
                  >
                    {tr("settings.connection.copyUrl")}
                  </button>
                </div>
              )}
              {token ? (
                <div>
                  <div className="text-body leading-4 text-kin-muted">
                    {tr("settings.connection.token")}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    <code className="[overflow-wrap:anywhere] font-mono text-body leading-4 text-kin-text">
                      {reveal ? token : "••••••••••••••••"}
                    </code>
                    <button
                      type="button"
                      onClick={() => setReveal((v) => !v)}
                      className="min-h-11 text-body leading-4 text-kin-blue-ink hover:underline"
                    >
                      {reveal ? tr("settings.hide") : tr("settings.reveal")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void copy(token)}
                      className="min-h-11 text-body leading-4 text-kin-blue-ink hover:underline"
                    >
                      {tr("settings.connection.copy")}
                    </button>
                  </div>
                  <p className="mt-1 text-body leading-4 text-kin-muted">
                    {tr("settings.connection.tokenHintA")}
                    <code className="text-kin-secondary">kin token rotate</code>
                    {tr("settings.connection.tokenHintB")}
                  </p>
                </div>
              ) : (
                // A Hub answers this endpoint without a token on purpose: the
                // browser got in with an account, and handing it the daemon's own
                // credential would outlive the session it came from.
                <p className="text-body text-kin-muted leading-prose">
                  {tr("settings.connection.accountSession")}
                </p>
              )}
            </div>
          </div>
        </section>
      </SettingsTabPanel>

      {/* Notifications */}
      <SettingsTabPanel id="notifications" active={activeTab === "notifications"}>
        <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
          <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
            {tr("settings.notify.heading")}
          </h2>
          <p className="text-body leading-4 text-kin-muted">
            {tr("settings.notify.descA")}
            <code className="text-kin-secondary">ui.base_url</code>
            {tr("settings.notify.descB")}
          </p>
          <label className="block space-y-1">
            <span className="text-body leading-4 font-medium text-kin-secondary">
              {tr("settings.notify.uiBaseUrl")}
            </span>
            <input
              type="url"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="http://192.168.x.x:7777"
              className="kin-input min-h-11"
            />
            <span className="text-body leading-4 text-kin-muted">
              {tr("settings.notify.uiBaseUrlHint")}
            </span>
          </label>
          <label className="block space-y-1">
            <span className="text-body leading-4 font-medium text-kin-secondary">
              {tr("settings.notify.quotaWaitAfter")}
            </span>
            <input
              type="number"
              min={60}
              step={60}
              value={quotaWaitNotifySecs}
              onChange={(e) => setQuotaWaitNotifySecs(e.target.value)}
              className="kin-input min-h-11"
            />
            <span className="text-body leading-4 text-kin-muted">
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
            {saved && (
              <span className="text-body leading-4 text-kin-green-ink">
                {tr("settings.notify.savedShort")}
              </span>
            )}
            {error && <span className="text-body leading-4 text-kin-red-ink">{error}</span>}
          </div>
        </section>
        <NativePushSettings />
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
                    // The text on screen is now exactly the server's table;
                    // without moving the baseline the guard would call the
                    // server's own answer an unsaved change.
                    syncServerBaseline(s);
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
