import { useEffect, useState } from "react";
import { signOut, startOIDC } from "../../api/account";
import { authErrorText } from "../../lib/accountGate";
import { isHubShell } from "../../lib/hubConfig";
import { useT } from "../../i18n/react";
import { useAppStore, type AccountProvider } from "../../store/appStore";
import { SettingsSection } from "./SettingsPrimitives";

/**
 * The Hub account this browser is signed in as.
 *
 * Renders nothing on a standalone daemon: there is no account there, and the
 * token panel already covers how that console is reached.
 *
 * The sign-in methods matter as much as the name here. An account claimed with
 * a password and later linked to GitHub has two ways in; one that never had a
 * password has only the provider, and the recovery command in the login screen
 * cannot help it. Showing what is attached is what makes that legible before
 * somebody is locked out.
 */
export function AccountSection() {
  const account = useAppStore((s) => s.account);
  const pushToast = useAppStore((s) => s.pushToast);
  const tr = useT();
  const [busy, setBusy] = useState(false);

  // The provider callback returns to this page with its result in the query
  // string. The login screen owns that protocol, so nothing else here would
  // read it: a failed link would drop the owner back on Settings with the
  // button still there and no word about what went wrong. The account screen
  // consumes the same parameters; this is the Settings half of that contract.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const message = params.get("auth_error");
    const code = params.get("auth_error_code");
    const notice = params.get("auth_notice");
    if (!message && !code && !notice) return;
    for (const key of ["auth_error", "auth_error_code", "auth_notice"]) {
      params.delete(key);
    }
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
    if (notice === "linked") pushToast(tr("settings.account.linked"), "info");
    if (message || code) {
      pushToast(
        authErrorText({ code: code || "sign_in_failed", message: message || "" }, tr),
        "error",
      );
    }
  }, [pushToast, tr]);

  if (!account.enabled) return null;

  const identity = account.displayName || account.email || "";

  const labelFor = (id: string): string => {
    const provider = account.providers.find((p) => p.id === id);
    if (provider) {
      return provider.kind === "password" ? tr("settings.account.methodPassword") : provider.label;
    }
    if (id === "password") return tr("settings.account.methodPassword");
    // The provider was removed from the Hub's configuration after this
    // identity was linked. The credential still exists, so say so rather than
    // hiding a way in that will fail at the provider.
    return tr("settings.account.methodOther");
  };

  // Every configured provider stays linkable, even after one identity from it
  // is attached. One OIDC issuer can front several connectors — Dex puts GitHub
  // and Google behind one — and each connector mints its own subject, so
  // linking GitHub must not hide the action that links Google.
  const oidcProviders: AccountProvider[] = account.providers.filter((p) => p.kind === "oidc");
  const hasLinkedOIDC = oidcProviders.some((p) => account.identities.includes(p.id));

  return (
    <SettingsSection
      title={tr("settings.account.heading")}
      description={tr("settings.account.blurb")}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="truncate text-strong text-kin-text">
              {identity || tr("settings.account.unknownUser")}
            </p>
            {account.displayName && account.email ? (
              <p className="truncate text-body text-kin-muted">{account.email}</p>
            ) : null}
            <p className="text-caption text-kin-muted">{tr("settings.account.deviceCountNote")}</p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              // signOut drops the stored token before its first request, so a
              // hung network cannot leave the second credential behind; the
              // redirect happens once the attempt settles either way.
              void signOut().finally(() => {
                window.location.assign("/");
              });
            }}
            className="min-h-11 rounded-lg border border-[var(--kin-hairline)] px-3 py-2 text-strong font-medium text-kin-secondary hover:bg-[var(--kin-fill)] disabled:opacity-60 sm:min-h-10"
          >
            {busy ? tr("settings.account.signingOut") : tr("settings.account.signOut")}
          </button>
        </div>

        <div className="space-y-2 border-t border-kin-hairline pt-3">
          <p className="text-body font-medium text-kin-muted">
            {tr("settings.account.methods")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {account.identities.map((id, index) => (
              <span
                key={`${id}:${index}`}
                className="rounded-lg bg-[var(--kin-fill)] px-2.5 py-1 text-body text-kin-secondary"
              >
                {labelFor(id)}
              </span>
            ))}
            {/* Linking signs the provider in inside THIS webview — the session
                re-checked at the callback must be this origin's cookie, and the
                shell's webview is the only place that cookie lives. Opening the
                provider hop in the system browser would leave the Set-Cookie
                in Safari's jar, and the webview gate rightly refuses to send
                the bridge to a foreign origin. So on the shell the action is
                not offered rather than offered-and-doomed (G9: linking from
                the phone waits for the sign-in code bridge to cover bind
                flows). The identity chips above stay visible either way. */}
            {!isHubShell() &&
              oidcProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => startOIDC(provider, "/settings")}
                  className="rounded-lg border border-kin-hairline-strong px-2.5 py-1 text-body font-medium text-kin-blue hover:bg-[var(--kin-fill)]"
                >
                  {hasLinkedOIDC
                    ? tr("settings.account.linkAnotherProvider")
                    : tr("settings.account.linkProvider", { provider: provider.label })}
                </button>
              ))}
          </div>
          <p className="text-caption text-kin-muted">
            {isHubShell() ? tr("settings.account.methodsHintShell") : tr("settings.account.methodsHint")}
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
