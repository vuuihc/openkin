import { FormEvent, useState } from "react";
import { setToken } from "../api/client";
import { useT } from "../i18n/react";
import { useAppStore } from "../store/appStore";

/**
 * Full-screen recovery when the session has no token or the API returns 401.
 * Token lives at ~/.kin/token on the host, and in Settings → connection QR on
 * an already-authorized device.
 */
export default function ConnectScreen({ reason }: { reason: "missing" | "unauthorized" }) {
  const setAuthOk = useAppStore((s) => s.setAuthOk);
  const tr = useT();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  const title =
    reason === "unauthorized" ? tr("connect.unauthorizedTitle") : tr("connect.missingTitle");

  const blurb =
    reason === "unauthorized" ? tr("connect.unauthorizedBlurb") : tr("connect.missingBlurb");

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-safe py-10 bg-[var(--kin-page)] text-kin-text">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-kin-hairline-strong bg-kin-elevated text-hero leading-8 font-bold text-kin-blue-ink">
            K
          </div>
          <h1 className="text-hero leading-7 font-semibold text-kin-text">{title}</h1>
          <p className="text-strong text-kin-muted leading-prose">{blurb}</p>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-kin-hairline-strong bg-kin-elevated p-5 space-y-4 shadow-e3"
        >
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
      </div>
    </div>
  );
}
