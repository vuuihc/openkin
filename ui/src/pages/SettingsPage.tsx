import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  ApiError,
  getSettings,
  updateSettings,
  type Settings,
} from "../api/client";

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bark, setBark] = useState("");
  const [ntfy, setNtfy] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [priceTable, setPriceTable] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await getSettings();
      setSettings(s);
      setBark(s["notify.bark_url"] ?? "");
      setNtfy(s["notify.ntfy_topic"] ?? "");
      setBaseURL(s["ui.base_url"] ?? "");
      try {
        setPriceTable(JSON.stringify(JSON.parse(s.price_table || "{}"), null, 2));
      } catch {
        setPriceTable(s.price_table ?? "");
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setSaved(false);
    setError(null);
    // Validate price table JSON client-side for faster feedback.
    try {
      JSON.parse(priceTable);
    } catch {
      setError("price_table must be valid JSON");
      setBusy(false);
      return;
    }
    try {
      const s = await updateSettings({
        "notify.bark_url": bark.trim(),
        "notify.ntfy_topic": ntfy.trim(),
        "ui.base_url": baseURL.trim(),
        price_table: priceTable,
      });
      setSettings(s);
      try {
        setPriceTable(JSON.stringify(JSON.parse(s.price_table || "{}"), null, 2));
      } catch {
        setPriceTable(s.price_table ?? "");
      }
      setSaved(true);
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

  if (error && !settings) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-zinc-50">Settings</h1>
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-zinc-50">Settings</h1>
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  const connectURL = settings.connect_url || "";
  const token = settings.token || "";
  const mode = settings.network_mode || "—";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-50">Settings</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Connection, token, notifications, and price table.
        </p>
      </div>

      {/* Connection */}
      <section className="rounded-xl border border-surface-border bg-surface-raised/50 p-4 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Connection
        </h2>
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          {connectURL ? (
            <div className="rounded-lg bg-white p-3 shrink-0">
              <QRCodeSVG value={connectURL} size={160} level="M" />
            </div>
          ) : (
            <div className="h-40 w-40 rounded-lg border border-dashed border-surface-border flex items-center justify-center text-xs text-zinc-500">
              No URL
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <div className="text-xs text-zinc-500">Network mode</div>
              <div className="mt-0.5 font-mono text-sm text-accent">{mode}</div>
            </div>
            {connectURL && (
              <div>
                <div className="text-xs text-zinc-500">Connect URL</div>
                <div className="mt-0.5 break-all font-mono text-xs text-zinc-300">
                  {connectURL}
                </div>
                <button
                  type="button"
                  onClick={() => void copy(connectURL)}
                  className="mt-1 text-xs text-accent hover:underline"
                >
                  Copy URL
                </button>
              </div>
            )}
            <div>
              <div className="text-xs text-zinc-500">Token</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <code className="break-all font-mono text-xs text-zinc-200">
                  {reveal ? token : token ? "••••••••••••••••" : "—"}
                </code>
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  className="text-xs text-accent hover:underline"
                >
                  {reveal ? "Hide" : "Reveal"}
                </button>
                {token && (
                  <button
                    type="button"
                    onClick={() => void copy(token)}
                    className="text-xs text-accent hover:underline"
                  >
                    Copy
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Rotate with <code className="text-zinc-400">kin token rotate</code> if
                leaked. A running daemon picks up the new token automatically.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Notifications */}
      <section className="rounded-xl border border-surface-border bg-surface-raised/50 p-4 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Notifications
        </h2>
        <p className="text-xs text-zinc-500">
          Fire-and-forget webhooks on approval requests and task completion. Deep links
          use <code className="text-zinc-400">ui.base_url</code>.
        </p>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-400">Bark URL</span>
          <input
            type="url"
            value={bark}
            onChange={(e) => setBark(e.target.value)}
            placeholder="https://api.day.app/DEVICE_KEY"
            className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-accent focus:outline-none"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-400">ntfy topic</span>
          <input
            type="text"
            value={ntfy}
            onChange={(e) => setNtfy(e.target.value)}
            placeholder="my-kin-topic or https://ntfy.sh/my-kin-topic"
            className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-accent focus:outline-none"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-400">UI base URL</span>
          <input
            type="url"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="http://192.168.x.x:7777"
            className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-accent focus:outline-none"
          />
          <span className="text-xs text-zinc-500">
            Set automatically from the most-public listener at serve start; override for
            tunnels.
          </span>
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black hover:bg-accent-muted disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {saved && <span className="text-xs text-accent">Saved</span>}
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </section>

      {/* Price table (M4) */}
      <section className="rounded-xl border border-surface-border bg-surface-raised/50 p-4 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Price table
        </h2>
        <p className="text-xs text-zinc-500">
          USD per 1M tokens for Codex cost math. Claude Code uses{" "}
          <code className="text-zinc-400">total_cost_usd</code> from the CLI and ignores
          this table. Shape:{" "}
          <code className="text-zinc-400">
            {`{"model": {"in": 1.25, "out": 10.0}}`}
          </code>
        </p>
        <textarea
          value={priceTable}
          onChange={(e) => setPriceTable(e.target.value)}
          rows={10}
          spellCheck={false}
          className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-accent focus:outline-none resize-y"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black hover:bg-accent-muted disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save price table"}
          </button>
        </div>
      </section>
    </div>
  );
}
