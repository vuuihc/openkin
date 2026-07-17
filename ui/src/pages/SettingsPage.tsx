import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  ApiError,
  getSettings,
  listAgents,
  testNotify,
  updateSettings,
  type AgentInfo,
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
  const [provBase, setProvBase] = useState("");
  const [provKey, setProvKey] = useState("");
  const [provModel, setProvModel] = useState("");
  const [provKeyDirty, setProvKeyDirty] = useState(false);
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
      setProvBase(s["provider.base_url"] ?? "");
      setProvKey(s["provider.api_key"] ?? "");
      setProvModel(s["provider.model"] ?? "");
      setAgentDefault(s["agent.default"] ?? "");
      setProvKeyDirty(false);
      try {
        setPriceTable(JSON.stringify(JSON.parse(s.price_table || "{}"), null, 2));
      } catch {
        setPriceTable(s.price_table ?? "");
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
    try {
      const body: Parameters<typeof updateSettings>[0] = {
        "notify.bark_url": bark.trim(),
        "notify.ntfy_topic": ntfy.trim(),
        "ui.base_url": baseURL.trim(),
        price_table: priceTable,
        "provider.kind": "openai-compatible",
        "provider.base_url": provBase.trim(),
        "provider.model": provModel.trim(),
        "agent.default": agentDefault.trim(),
      };
      if (provKeyDirty) {
        if (!provKey.trim()) {
          body["provider.clear_api_key"] = "1";
        } else {
          body["provider.api_key"] = provKey.trim();
        }
      }
      const s = await updateSettings(body);
      setSettings(s);
      setProvBase(s["provider.base_url"] ?? "");
      setProvKey(s["provider.api_key"] ?? "");
      setProvModel(s["provider.model"] ?? "");
      setAgentDefault(s["agent.default"] ?? "");
      setProvKeyDirty(false);
      try {
        setPriceTable(JSON.stringify(JSON.parse(s.price_table || "{}"), null, 2));
      } catch {
        setPriceTable(s.price_table ?? "");
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

      {/* Cognition provider — powers agent "kin" */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
            {tr("settings.provider.heading")}
          </h2>
          <p className="mt-1 text-xs text-kin-muted">
            {tr("settings.provider.descA")}
            <b className="text-kin-text">Kin</b>
            {tr("settings.provider.descB")}
          </p>
        </div>
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
          />
          <span className="text-[11px] text-kin-muted">
            {tr("settings.provider.baseUrlHintA")}
            <code className="text-kin-text">/v1</code>
            {tr("settings.provider.baseUrlHintB")}
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-kin-secondary">
            {tr("settings.provider.apiKey")}
          </span>
          <input
            type="password"
            value={provKey}
            onChange={(e) => {
              setProvKey(e.target.value);
              setProvKeyDirty(true);
            }}
            placeholder="sk-… (optional for local proxies)"
            className="kin-input min-h-[44px] font-mono text-xs"
            autoComplete="off"
          />
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
              <option key={a.id} value={a.id} disabled={!a.available && a.id === "kin"}>
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

      {/* Price table (M4) */}
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
          {tr("settings.price.heading")}
        </h2>
        <p className="text-xs text-kin-muted">
          {tr("settings.price.descA")}
          <code className="text-kin-secondary">total_cost_usd</code>
          {tr("settings.price.descB")}
          <code className="text-kin-secondary">
            {`{"model": {"in": 1.25, "out": 10.0}}`}
          </code>
        </p>
        <textarea
          value={priceTable}
          onChange={(e) => setPriceTable(e.target.value)}
          rows={10}
          spellCheck={false}
          className="kin-input font-mono text-xs resize-y min-h-[160px]"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="kin-btn-primary disabled:opacity-50"
          >
            {busy ? tr("settings.saving") : tr("settings.price.save")}
          </button>
        </div>
      </section>
      </div>
    </div>
  );
}
