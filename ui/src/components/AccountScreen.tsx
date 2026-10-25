import { FormEvent, useEffect, useState } from "react";
import { AuthError, claimOwner, joinHub, signIn, startOIDC } from "../api/account";
import { authErrorText, CODE_FIELDS, prefilledCode } from "../lib/accountGate";
import { useT } from "../i18n/react";
import { useAppStore, type AccountMode, type AccountProvider } from "../store/appStore";

/**
 * Account gate for a Hub.
 *
 * A Hub owns the account, so "who are you" is answered once here and then held
 * as an HttpOnly session cookie. A standalone daemon never reaches this
 * screen: it has no providers, and the console keeps its token flow.
 *
 * Three situations arrive at the same form, because they are one question asked
 * at different moments. Claiming happens exactly once, on a Hub that has no
 * owner and printed a one-time code to its logs. Joining happens when somebody
 * the owner invited follows the link. Signing in happens every time after that.
 */

/**
 * The words each way in uses.
 *
 * A table rather than nested conditionals: there are three of them, and the two
 * that take a code differ only in the sentence above the form.
 */
const COPY: Record<AccountMode, { title: string; blurb: string; action: string }> = {
  claim: {
    title: "account.claimTitle",
    blurb: "account.claimBlurb",
    action: "account.claimAction",
  },
  join: { title: "account.joinTitle", blurb: "account.joinBlurb", action: "account.joinAction" },
  login: {
    title: "account.loginTitle",
    blurb: "account.loginBlurb",
    action: "account.loginAction",
  },
};

/** The OIDC callback reports failures through the URL, not a JSON body. */
function takeAuthErrorFromURL(): { code: string; message: string } | null {
  const params = new URLSearchParams(window.location.search);
  const message = params.get("auth_error");
  const code = params.get("auth_error_code");
  if (!message && !code) return null;
  for (const key of ["auth_error", "auth_error_code", "auth_notice"]) {
    params.delete(key);
  }
  const qs = params.toString();
  window.history.replaceState(
    {},
    "",
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
  );
  return { code: code || "sign_in_failed", message: message || "" };
}

/**
 * Reload in place with the auth query parameters cleared.
 *
 * `invite` goes with them: the account it created now exists, and leaving a
 * spent code in the address bar leaves it in the history too.
 */
function reloadClean(): void {
  const url = new URL(window.location.href);
  for (const key of ["auth_error", "auth_error_code", "auth_notice", "invite"]) {
    url.searchParams.delete(key);
  }
  window.location.replace(url.toString());
}

export default function AccountScreen({ mode }: { mode: AccountMode }) {
  const account = useAppStore((s) => s.account);
  const requireAccount = useAppStore((s) => s.requireAccount);
  const tr = useT();

  // Two of the three ways in take a code and ask for a name. One predicate for
  // that is what keeps "join" a third row in the tables above rather than a
  // third arm on every field below.
  const enrolling = mode !== "login";
  const copy = COPY[mode];
  const codeField = mode === "login" ? null : CODE_FIELDS[mode];

  // An invitation link carries its code, so the person who was invited never
  // types it. Reading it once is enough: nothing below changes the URL.
  const [code, setCode] = useState(() => prefilledCode(mode, window.location.search));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  // An OIDC round trip that failed lands back here with the reason on the URL.
  useEffect(() => {
    setError(takeAuthErrorFromURL());
  }, []);

  /**
   * Leave the invitation behind and sign in as somebody who already has an
   * account.
   *
   * The parameter goes with it. Keeping it would pin the next screen to `join`
   * the moment anything re-read the URL, which is how the visitor got stuck.
   */
  function switchToSignIn(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    window.history.replaceState({}, "", url.toString());
    requireAccount("login");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "claim") {
        await claimOwner({ code, email, password, displayName });
      } else if (mode === "join") {
        await joinHub({ code, email, password, displayName });
      } else {
        await signIn(email, password);
      }
      reloadClean();
    } catch (err) {
      setError(
        err instanceof AuthError
          ? { code: err.code, message: err.message }
          : { code: "sign_in_failed", message: "" },
      );
      setBusy(false);
    }
  }

  const oidcProviders = account.providers.filter((p) => p.kind === "oidc");
  const errorText = error ? authErrorText(error, tr) : null;

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-safe py-10 bg-[var(--kin-page)] text-kin-text">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-kin-hairline-strong bg-kin-elevated text-hero leading-8 font-bold text-kin-blue-ink">
            K
          </div>
          <h1 className="text-hero leading-7 font-semibold text-kin-text">{tr(copy.title)}</h1>
          <p className="text-strong text-kin-muted leading-prose">{tr(copy.blurb)}</p>
        </div>

        <form onSubmit={onSubmit} className="rounded-2xl bg-kin-elevated p-5 space-y-4 shadow-e3">
          {codeField && (
            <label className="block space-y-1.5">
              <span className="text-body leading-4 font-medium text-kin-muted">
                {tr(codeField.label)}
              </span>
              <input
                type="text"
                required
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(codeField.format(e.target.value))}
                placeholder={tr(codeField.placeholder)}
                className="w-full min-h-11 rounded-xl border border-kin-hairline-strong bg-kin-bg px-3 py-2.5 font-mono text-subtitle leading-6 tracking-label text-kin-text placeholder:tracking-normal placeholder:text-kin-muted focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
              />
            </label>
          )}

          <label className="block space-y-1.5">
            <span className="text-body leading-4 font-medium text-kin-muted">
              {tr("account.emailLabel")}
            </span>
            <input
              type="email"
              required
              autoFocus={mode === "login"}
              autoComplete="email"
              inputMode="email"
              autoCapitalize="off"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={tr("account.emailPlaceholder")}
              className="w-full min-h-11 rounded-xl border border-kin-hairline-strong bg-kin-bg px-3 py-2.5 text-strong leading-5 text-kin-text placeholder:text-kin-muted focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-body leading-4 font-medium text-kin-muted">
              {tr("account.passwordLabel")}
            </span>
            <input
              type="password"
              required
              autoComplete={enrolling ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={enrolling ? tr("account.newPasswordPlaceholder") : "••••••••"}
              className="w-full min-h-11 rounded-xl border border-kin-hairline-strong bg-kin-bg px-3 py-2.5 text-strong leading-5 text-kin-text placeholder:text-kin-muted focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
            />
            {enrolling && (
              <span className="block text-body leading-4 text-kin-muted">
                {tr("account.passwordHint")}
              </span>
            )}
          </label>

          {enrolling && (
            <label className="block space-y-1.5">
              <span className="text-body leading-4 font-medium text-kin-muted">
                {tr("account.nameLabel")}
              </span>
              <input
                type="text"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={tr("account.namePlaceholder")}
                className="w-full min-h-11 rounded-xl border border-kin-hairline-strong bg-kin-bg px-3 py-2.5 text-strong leading-5 text-kin-text placeholder:text-kin-muted focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
              />
            </label>
          )}

          {errorText && (
            <p className="text-strong leading-5 text-kin-red-ink" role="alert">
              {errorText}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full min-h-12 rounded-xl bg-kin-blue px-4 py-3 text-strong leading-5 font-semibold text-kin-on-brand hover:bg-kin-blue/90 active:scale-[0.99] transition disabled:opacity-60"
          >
            {busy ? tr("account.working") : tr(copy.action)}
          </button>

          {/* OIDC is hidden while joining, because it cannot work there:
              LoginIdentity refuses to attach a provider to a Hub that closed
              registration. Offering a button whose only outcome is an error is
              worse than offering nothing. */}
          {mode !== "join" && oidcProviders.length > 0 && (
            <div className="space-y-3 pt-1">
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-kin-hairline-strong" />
                <span className="text-body leading-4 text-kin-muted">
                  {tr("account.orDivider")}
                </span>
                <span className="h-px flex-1 bg-kin-hairline-strong" />
              </div>
              {oidcProviders.map((provider) => (
                <OIDCButton key={provider.id} provider={provider} label={tr} />
              ))}
            </div>
          )}
        </form>

        {/* The way out of an invitation.
            A join link is the one way in that reaches people it was not meant
            for: it gets forwarded, it gets bookmarked, and whoever already has
            an account here cannot spend it. Without this they are pinned to a
            form that can only fail, with the address bar as the only exit --
            which is not an exit on a phone. */}
        {mode === "join" && (
          <p className="text-center text-body leading-5 text-kin-muted">
            {tr("account.haveAccount")}{" "}
            <button
              type="button"
              onClick={switchToSignIn}
              className="rounded font-medium text-kin-blue underline-offset-2 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-kin-focus-ring"
            >
              {tr("account.signInInstead")}
            </button>
          </p>
        )}

        {mode === "claim" && (
          <div className="rounded-xl border border-kin-hairline-strong bg-kin-elevated/40 px-4 py-3 text-body text-kin-muted space-y-2 leading-prose">
            <p className="font-medium text-kin-muted">{tr("account.whereTitle")}</p>
            <p>{tr("account.whereBody")}</p>
            <code className="block rounded-lg bg-kin-bg px-2 py-1.5 text-kin-secondary">
              docker compose logs kin
            </code>
            {!account.claimable && (
              <p className="text-kin-orange-ink/90">{tr("account.codeExpired")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OIDCButton({
  provider,
  label,
}: {
  provider: AccountProvider;
  label: ReturnType<typeof useT>;
}) {
  return (
    <button
      type="button"
      onClick={() => startOIDC(provider, window.location.pathname)}
      className="w-full min-h-12 rounded-xl border border-kin-hairline-strong bg-kin-bg px-4 py-3 text-strong leading-5 font-medium text-kin-text hover:bg-kin-elevated active:scale-[0.99] transition"
    >
      {label("account.continueWith", { provider: provider.label })}
    </button>
  );
}
