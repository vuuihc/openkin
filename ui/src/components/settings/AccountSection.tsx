import { useState } from "react";
import { clearToken } from "../../api/client";
import { signOut } from "../../api/account";
import { useT } from "../../i18n/react";
import { useAppStore } from "../../store/appStore";
import { SettingsSection } from "./SettingsPrimitives";

/**
 * The Hub account this browser is signed in as.
 *
 * Renders nothing on a standalone daemon: there is no account there, and the
 * token panel already covers how that console is reached.
 */
export function AccountSection() {
  const account = useAppStore((s) => s.account);
  const tr = useT();
  const [busy, setBusy] = useState(false);

  if (!account.enabled) return null;

  const identity = account.displayName || account.email || "";

  return (
    <SettingsSection
      title={tr("settings.account.heading")}
      description={tr("settings.account.blurb")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-[13px] text-kin-text">
            {identity || tr("settings.account.unknownUser")}
          </p>
          {account.displayName && account.email ? (
            <p className="truncate text-[12px] text-kin-muted">{account.email}</p>
          ) : null}
          <p className="text-[11px] text-kin-muted">
            {tr("settings.account.deviceCountNote")}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            // The token is a second way into this console; signing out has to
            // close both, or the button would appear to do nothing.
            clearToken();
            void signOut().finally(() => {
              window.location.assign("/");
            });
          }}
          className="min-h-[40px] rounded-lg border border-[var(--kin-hairline)] px-3 py-2 text-[13px] font-medium text-kin-secondary hover:bg-[var(--kin-fill)] disabled:opacity-60"
        >
          {busy ? tr("settings.account.signingOut") : tr("settings.account.signOut")}
        </button>
      </div>
    </SettingsSection>
  );
}
