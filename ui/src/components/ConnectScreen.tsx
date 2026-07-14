import { FormEvent, useState } from "react";
import { setToken } from "../api/client";
import { useAppStore } from "../store/appStore";

/**
 * Full-screen recovery when the session has no token or the API returns 401.
 * Token lives at ~/.kin/token on the host, and in Settings → connection QR on
 * an already-authorized device.
 */
export default function ConnectScreen({ reason }: { reason: "missing" | "unauthorized" }) {
  const setAuthOk = useAppStore((s) => s.setAuthOk);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const token = value.trim();
    if (!token) {
      setError("Paste a token to continue.");
      return;
    }
    setToken(token);
    setAuthOk();
    // Hard reload so WS and all pages re-bind with the new token.
    window.location.reload();
  }

  const title =
    reason === "unauthorized"
      ? "Session no longer authorized"
      : "Connect to your Kin daemon";

  const blurb =
    reason === "unauthorized"
      ? "The token stored in this browser is invalid or was rotated. Paste a fresh token to reconnect."
      : "This browser has no auth token. Paste the daemon token to open the console.";

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 py-10 safe-pad bg-surface">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-surface-border bg-surface-raised text-2xl font-bold text-accent">
            K
          </div>
          <h1 className="text-xl font-semibold text-zinc-50">{title}</h1>
          <p className="text-sm text-zinc-400 leading-relaxed">{blurb}</p>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-surface-border bg-surface-raised p-5 space-y-4 shadow-xl shadow-black/30"
        >
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-zinc-400">Auth token</span>
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
              placeholder="Paste token…"
              className="w-full min-h-[44px] rounded-xl border border-surface-border bg-surface px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>

          {error && (
            <p className="text-sm text-red-300" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full min-h-[48px] rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-zinc-900 hover:bg-accent-muted active:scale-[0.99] transition"
          >
            Connect
          </button>
        </form>

        <div className="rounded-xl border border-surface-border/80 bg-surface-raised/40 px-4 py-3 text-xs text-zinc-500 space-y-2 leading-relaxed">
          <p className="font-medium text-zinc-400">Where to find the token</p>
          <ul className="list-disc pl-4 space-y-1">
            <li>
              On the host:{" "}
              <code className="text-zinc-300">~/.kin/token</code>
            </li>
            <li>
              From an authorized device:{" "}
              <span className="text-zinc-300">Settings → connection QR</span>{" "}
              (or reveal/copy token there)
            </li>
            <li>
              From the terminal: the open URL printed by{" "}
              <code className="text-zinc-300">kin serve</code> includes{" "}
              <code className="text-zinc-300">?token=</code>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
