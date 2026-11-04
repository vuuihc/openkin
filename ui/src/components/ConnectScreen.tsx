import { FormEvent, useEffect, useState } from "react";
import { setToken } from "../api/client";
import { currentHubUrl, hubConfigPlugin, isHubShell } from "../lib/hubConfig";
import { useT } from "../i18n/react";
import { useAppStore } from "../store/appStore";

/**
 * Full-screen recovery when the session has no token or the API returns 401.
 * Token lives at ~/.kin/token on the host, and in Settings → connection QR on
 * an already-authorized device.
 *
 * Inside the native shell this screen has a second job (G8): a first-run app
 * has no Hub URL yet, so before any token question can matter, the shell needs
 * an origin to point the webview at. `isHubShell` distinguishes the two — the
 * entry form is a shell-only surface, and a browser keeps the token paste it
 * has always had.
 */
export default function ConnectScreen({ reason }: { reason: "missing" | "unauthorized" }) {
  const setAuthOk = useAppStore((s) => s.setAuthOk);
  const tr = useT();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The shell's stored URL, "" while none is set, null while unknown. A shell
  // that already has a Hub opens this screen only when that Hub went missing —
  // the URL form stays available below the token form in both shell states.
  const [shellUrl, setShellUrl] = useState<string | null>(null);
  const [insecure, setInsecure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const plugin = hubConfigPlugin();

  useEffect(() => {
    if (!plugin) return;
    let cancelled = false;
    void currentHubUrl(plugin).then((url) => {
      if (!cancelled) setShellUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [plugin]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const token = value.trim();
    if (!token) {
      setError(tr("connect.pasteToContinue"));
      return;
    }
    setToken(token);
    setAuthOk();
    // Hard reload so WS and all pages re-bind with the new token.
    window.location.reload();
  }

  /**
   * Hand the typed origin to the shell.
   *
   * The shell persists it and points the webview at it in one action — that
   * navigation is what makes the session cookie first-party, so "saved" and
   * "opened" are deliberately not two steps. A plain-HTTP answer means a LAN
   * origin: the shell allows it but says so, and this confirm step is where
   * the person decides knowing what the network can see.
   */
  async function submitHubUrl(e: FormEvent) {
    e.preventDefault();
    if (!plugin || busy) return;
    const raw = value.trim();
    if (!raw) {
      setError(tr("connect.hubInvalid"));
      return;
    }
    if (!/^https?:\/\//i.test(raw)) {
      setError(tr("connect.hubInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await plugin.setHubUrl({ url: raw });
      if (result.insecure && !insecure) {
        // The shell refused nothing — it navigated — but it flagged the origin.
        // Show why HTTPS matters and require the tap that means it was read.
        // The URL is already saved, so confirming just re-sets it and reloads.
        setInsecure(result.url);
        setBusy(false);
        return;
      }
      setInsecure(null);
      setShellUrl(result.url);
    } catch {
      setBusy(false);
      setError(tr("connect.hubInvalid"));
    }
  }

  const title =
    reason === "unauthorized" ? tr("connect.unauthorizedTitle") : tr("connect.missingTitle");

  const blurb =
    reason === "unauthorized" ? tr("connect.unauthorizedBlurb") : tr("connect.missingBlurb");

  const showHubForm = isHubShell();

  return (
    <div className="touch-lg min-h-[100dvh] flex flex-col items-center justify-center px-safe py-10 bg-[var(--kin-page)] text-kin-text">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-kin-hairline-strong bg-kin-elevated text-hero leading-8 font-bold text-kin-blue-ink">
            K
          </div>
          {showHubForm && !shellUrl ? (
            <>
              <h1 className="text-hero leading-7 font-semibold text-kin-text">
                {tr("connect.hubTitle")}
              </h1>
              <p className="text-strong text-kin-muted leading-prose">{tr("connect.hubBlurb")}</p>
            </>
          ) : (
            <>
              <h1 className="text-hero leading-7 font-semibold text-kin-text">{title}</h1>
              <p className="text-strong text-kin-muted leading-prose">{blurb}</p>
            </>
          )}
        </div>

        {showHubForm && (
          <form onSubmit={submitHubUrl} className="rounded-2xl bg-kin-elevated p-5 space-y-4 shadow-e3">
            <label className="block space-y-1.5">
              <span className="text-body leading-4 font-medium text-kin-muted">
                {tr("connect.hubLabel")}
              </span>
              <input
                type="url"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                placeholder={tr("connect.hubPlaceholder")}
                className="w-full min-h-11 rounded-xl border border-kin-hairline-strong bg-kin-bg px-3 py-2.5 text-strong leading-5 text-kin-text placeholder:text-kin-muted focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
              />
            </label>

            {insecure && (
              <div
                className="rounded-xl border border-kin-hairline-strong bg-kin-bg px-4 py-3 space-y-2"
                role="alert"
              >
                <p className="text-strong font-medium text-kin-orange-ink">
                  {tr("connect.hubInsecureTitle")}
                </p>
                <p className="text-body leading-prose text-kin-muted">
                  {tr("connect.hubInsecureBody")}
                </p>
                <button
                  type="submit"
                  className="w-full min-h-11 rounded-xl border border-kin-hairline-strong px-4 py-2.5 text-strong font-medium text-kin-text hover:bg-kin-elevated active:scale-[0.99] transition"
                >
                  {tr("connect.hubInsecureConfirm")}
                </button>
              </div>
            )}

            {error && (
              <p className="text-strong leading-5 text-kin-red-ink" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full min-h-12 rounded-xl bg-kin-blue px-4 py-3 text-strong leading-5 font-semibold text-kin-on-brand hover:bg-kin-blue/90 active:scale-[0.99] transition disabled:opacity-60"
            >
              {busy ? tr("connect.hubChanged") : tr("connect.hubConnect")}
            </button>
          </form>
        )}

        {!showHubForm && (
          <form onSubmit={onSubmit} className="rounded-2xl bg-kin-elevated p-5 space-y-4 shadow-e3">
            <label className="block space-y-1.5">
              <span className="text-body leading-4 font-medium text-kin-muted">
                {tr("connect.tokenLabel")}
              </span>
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                placeholder={tr("connect.pasteToken")}
                className="w-full min-h-11 rounded-xl border border-kin-hairline-strong bg-kin-bg px-3 py-2.5 font-mono text-strong leading-5 text-kin-text placeholder:text-kin-muted focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
              />
            </label>

            {error && (
              <p className="text-strong leading-5 text-kin-red-ink" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              className="w-full min-h-12 rounded-xl bg-kin-blue px-4 py-3 text-strong leading-5 font-semibold text-kin-on-brand hover:bg-kin-blue/90 active:scale-[0.99] transition"
            >
              {tr("connect.connect")}
            </button>
          </form>
        )}

        {showHubForm && (
          <div className="rounded-xl border border-kin-hairline-strong bg-kin-elevated/40 px-4 py-3 text-body text-kin-muted space-y-2 leading-prose">
            <p>{tr("connect.hubBlurb")}</p>
          </div>
        )}

        {!showHubForm && (
          <div className="rounded-xl border border-kin-hairline-strong bg-kin-elevated/40 px-4 py-3 text-body text-kin-muted space-y-2 leading-prose">
            <p className="font-medium text-kin-muted">{tr("connect.whereTitle")}</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>
                {tr("connect.whereHost")} <code className="text-kin-secondary">~/.kin/token</code>
              </li>
              <li>
                {tr("connect.whereDevice")}{" "}
                <span className="text-kin-secondary">{tr("connect.whereSettings")}</span>{" "}
                {tr("connect.whereSettingsHint")}
              </li>
              <li>
                {tr("connect.whereTerminal")} {tr("connect.whereServe")}{" "}
                <code className="text-kin-secondary">kin serve</code> includes{" "}
                <code className="text-kin-secondary">?token=</code>
              </li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
