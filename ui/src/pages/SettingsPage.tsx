import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  ApiError,
  activateProvider,
  createProvider,
  deleteProvider,
  getSettings,
  listAgents,
  listProviders,
  testNotify,
  updateProvider,
  updateSettings,
  type AgentInfo,
  type ProviderEntry,
  type Settings,
} from "../api/client";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import {
  applyTheme,
  getThemeMode,
  setThemeMode,
  type ThemeMode,
} from "../lib/theme";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";

export default function SettingsPage() {
  const tr = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bark, setBark] = useState("");
  const [ntfy, setNtfy] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [priceTable, setPriceTable] = useState("");
  const [agentLimitsText, setAgentLimitsText] = useState("");
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
  const [agentDefault, setAgentDefault] = useState("");
  const [agentList, setAgentList] = useState<AgentInfo[]>([]);
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
      setBaseURL(s["ui.base_url"] ?? "");
      setAgentDefault(s["agent.default"] ?? "");
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
        .catch(() => setAgentList([]));
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
        "ui.base_url": baseURL.trim(),
        price_table: priceTable,
        agent_limits: agentLimitsText,
        "agent.default": agentDefault.trim(),
      };
      const s = await updateSettings(body);
      setSettings(s);
      setAgentDefault(s["agent.default"] ?? "");
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
      listAgents()
        .then(setAgentList)
        .catch(() => undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
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
  };

  const closeProviderForm = () => {
    setEditingId(null);
    setProvKeyDirty(false);
    setReveal(false);
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
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.provider.model")}
              </span>
              <input
                type="text"
                value={provModel}
                onChange={(e) => setProvModel(e.target.value)}
                placeholder="gpt-4.1-mini · grok-3 · llama3.2"
                className="kin-input min-h-[44px] font-mono text-xs"
              />
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
            {agentList.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.available}>
                {a.name} ({a.id})
                {!a.available
                  ? tr("settings.provider.unavailable")
                  : a.default
                    ? tr("settings.provider.currentDefault")
                    : ""}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-kin-muted">
            {tr("settings.provider.defaultAgentHint")}
          </span>
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
