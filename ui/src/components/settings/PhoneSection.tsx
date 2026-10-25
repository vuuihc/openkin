import { useT } from "../../i18n/react";
import { SettingsRow, SettingsSection, type SettingsTabId } from "./SettingsPrimitives";

/**
 * "How do I use this from my phone" — the question the console could not answer.
 *
 * Every fact here was already true and none of it was written down anywhere the
 * person holding the phone would look: a push notification links to
 * `<ui.base_url>/inbox?focus=<id>`, that link only works in a browser that has
 * been paired once, and pairing lives on another tab. The failure is silent and
 * looks like a broken feature — the notification opens a page explaining tokens.
 *
 * Deliberately *not* a second copy of the connection QR. That QR encodes a
 * connect URL carrying a token (`connect_url` is served only to a master
 * request), and a settings tab is a passive view: duplicating a credential onto
 * a screen someone may be screen-sharing is not a convenience. The button goes
 * to the one place the QR already lives instead — and on the phone itself the
 * QR is empty anyway (a paired device is not a master request), so a copy here
 * would render as an empty box exactly where it was meant to help.
 */
export function PhoneSection({
  baseUrl,
  onOpenTab,
}: {
  /** The *saved* `ui.base_url` — a draft in the field below is not what pushes use. */
  baseUrl: string;
  onOpenTab: (tab: SettingsTabId) => void;
}) {
  const tr = useT();
  const inboxURL = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/inbox` : "";

  const linkButton =
    "min-h-11 sm:min-h-10 rounded-lg border border-[var(--kin-hairline)] px-3 py-2 text-strong font-medium text-kin-secondary hover:bg-[var(--kin-fill)]";

  return (
    <SettingsSection title={tr("settings.phone.heading")} description={tr("settings.phone.blurb")}>
      <SettingsRow
        label={tr("settings.phone.pairLabel")}
        description={tr("settings.phone.pairHint")}
      >
        <button type="button" onClick={() => onOpenTab("remote")} className={linkButton}>
          {tr("settings.phone.openPairing")}
        </button>
      </SettingsRow>

      <SettingsRow
        label={tr("settings.phone.landLabel")}
        description={tr("settings.phone.landHint")}
      >
        {inboxURL ? (
          <div className="break-all font-mono text-body leading-5 text-kin-secondary">
            {inboxURL}
          </div>
        ) : (
          // Not decoration: with no base URL the pushes carry a bare path, which
          // a phone has nothing to open. That is worth saying in the colour the
          // console uses for "this will not work".
          <div className="rounded-lg border border-kin-orange/40 bg-kin-orange/10 px-3 py-2 text-body leading-prose text-kin-orange-ink">
            {tr("settings.phone.noBaseUrl")}
          </div>
        )}
      </SettingsRow>

      <SettingsRow
        label={tr("settings.phone.channelLabel")}
        description={tr("settings.phone.channelHint")}
      >
        <button type="button" onClick={() => onOpenTab("notifications")} className={linkButton}>
          {tr("settings.phone.openNotify")}
        </button>
      </SettingsRow>
    </SettingsSection>
  );
}
