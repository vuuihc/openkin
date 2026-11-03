import { FormEvent, useEffect, useRef, useState } from "react";
import { AuthError, claimOwner, joinHub, signIn, startOIDC } from "../api/account";
import { authErrorText, CODE_FIELDS, prefilledCode } from "../lib/accountGate";
import { withoutClaimHash } from "../lib/loginLink";
import { hasFinePointer } from "../lib/pointer";
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
 * The code parameters go with them: the account they created now exists, and
 * leaving a spent code in the address bar leaves it in the history too.
 */
function reloadClean(): void {
  const url = new URL(window.location.href);
  for (const key of ["auth_error", "auth_error_code", "auth_notice", "invite", "claim"]) {
    url.searchParams.delete(key);
  }
  window.location.replace(withoutClaimHash(url.toString()));
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
  // A phone must not land on this screen with a field already focused: the
  // keyboard covers the form, and iOS zooms the page first (the field is drawn
  // at 13px). Desktop keeps the convenience. See `lib/pointer`.
  const focusOnMount = hasFinePointer();

  // An invitation link carries its code, and so does the claim link an agent
  // prints. Reading it once is enough: the fragment is cleared below, and
  // nothing else changes the URL.
  const [code, setCode] = useState(() =>
    prefilledCode(mode, window.location.search, window.location.hash),
  );
  // Whether the code arrived in the URL, as opposed to being typed. The input's
  // value cannot answer that: it becomes truthy on the first keystroke, and the
  // help text would then claim a link the person never followed.
  const [codeCameFromLink] = useState(
    () => prefilledCode(mode, window.location.search, window.location.hash) !== "",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  // An OIDC round trip that failed lands back here with the reason on the URL,
  // and a claim link carries its code in the fragment. Both are consumed once:
  // the error is moved into state and the code into the form above, and the
  // fragment is removed so the credential does not stay in history.
  //
  // StrictMode mounts every effect twice in development. The first pass spends
  // the URL, so the second would read nothing and set the error back to null.
  // The ref makes this mount work happen once; StrictMode preserves it across
  // the simulated remount, which is exactly the lifetime this needs.
  const readVisitURL = useRef(false);
  useEffect(() => {
    if (readVisitURL.current) return;
    readVisitURL.current = true;
    setError(takeAuthErrorFromURL());
    // The code was read into the form above, so neither shape needs to stay in
    // the address bar. The query form is what links printed by older versions
    // use; the fragment is the current one.
    const url = new URL(window.location.href);
    url.searchParams.delete("claim");
    const cleaned = withoutClaimHash(url.toString());
    if (cleaned !== window.location.href) {
      window.history.replaceState({}, "", cleaned);
    }
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
    <div className="touch-lg min-h-[100dvh] flex flex-col items-center justify-center px-safe py-10 bg-[var(--kin-page)] text-kin-text">
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
                autoFocus={focusOnMount}
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
              autoFocus={mode === "login" && focusOnMount}
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

          {/* Federated sign-in is offered only when signing in. Claiming and
              joining both spend a code that the provider flow does not carry,
              so the callback can only answer "this hub already has an owner" —
              a false statement on an unclaimed Hub and a dead end either way.
              The account is created with a password, then linked from Settings. */}
          {mode === "login" && oidcProviders.length > 0 && (
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

        {/* What the login form is asking for, and what to do when the answer is
            gone. Both sentences exist because the account is chosen at claim
            time and then never shown again: the console stores only an argon2
            hash, so "I forgot" has no self-service path by design. The way back
            in is a one-time link the operator's agent mints on the Hub, which is
            why this text names an agent rather than a shell command: the person
            reading a login screen is not the person who can run one. */}
        {mode === "login" && (
          <div className="rounded-xl border border-kin-hairline-strong bg-kin-elevated/40 px-4 py-3 text-body text-kin-muted space-y-2 leading-prose">
            <p>
              <span className="font-medium text-kin-muted">{tr("account.loginWhereTitle")}</span>{" "}
              {tr("account.loginWhereBody")}
            </p>
            <p>
              <span className="font-medium text-kin-muted">{tr("account.forgotTitle")}</span>{" "}
              {tr("account.forgotBody")}
            </p>
          </div>
        )}

        {/* A claim link arrives with the code already in the field, so the
            "where do I find it" paragraph is left out in that case -- telling
            somebody to look for what is on their screen is how a working link
            reads as broken. */}
        {mode === "claim" && (
          <div className="rounded-xl border border-kin-hairline-strong bg-kin-elevated/40 px-4 py-3 text-body text-kin-muted space-y-2 leading-prose">
            {codeCameFromLink ? (
              <p>{tr("account.claimLinkBody")}</p>
            ) : (
              <>
                <p className="font-medium text-kin-muted">{tr("account.whereTitle")}</p>
                <p>{tr("account.whereBody")}</p>
              </>
            )}
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
