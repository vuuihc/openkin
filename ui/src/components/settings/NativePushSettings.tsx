import { useCallback, useEffect, useState } from "react";
import {
  deletePushDevice,
  listPushDevices,
  registerPushDevice,
  testNotify,
  testPushDevice,
  type PushDevice,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { isKinDesktop, openNotificationSettings } from "../../lib/desktop";
import {
  NativePushPermissionError,
  disableNativePush,
  enableNativePush,
  flushPendingNativeDelete,
  forgetNativeDevice,
  isNotFoundError,
  nativePushPlugin,
  pushErrorKey,
  rememberedNativeDevice,
  rememberNativeDevice,
  syncNativePush,
  type NativePushApi,
  type NativePushPermission,
  type NativePushPlugin,
} from "../../lib/nativePush";
import { useAppStore } from "../../store/appStore";

const clientApi: NativePushApi = { registerPushDevice, deletePushDevice };

type Message = { kind: "info" | "error"; text: string };

export type NativePushSettingsProps = {
  /** The iOS bridge; null in a browser and on macOS. */
  plugin?: NativePushPlugin | null;
  /** Whether this console is inside the Electron shell. */
  desktop?: boolean;
  api?: NativePushApi;
};

/**
 * The device block under Settings → Notifications.
 *
 * It shows one device first — this Mac or this iPhone — because the question a
 * reader has is "will *this* thing ring", not "how many registrations exist".
 * The node's list is drawn below as phones, and only after the page has loaded
 * (listing is local and reads no secret; the old browser-push config endpoint
 * minted a key pair, which is why that one had to wait for a click).
 *
 * A plain browser gets an explanation and no controls: after KIN-NOTIFY-001
 * there is no browser channel to turn on.
 */
export function NativePushSettings({
  plugin = nativePushPlugin(),
  desktop = isKinDesktop(),
  api = clientApi,
}: NativePushSettingsProps) {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  // Apple's reasons are machine tokens; the ones a person can act on get a
  // sentence, and anything else stays as it arrived.
  const describePushReason = (reason: string): string => {
    const key = pushErrorKey(reason);
    return key ? tr(key) : reason;
  };
  // The registry stores Apple's machine values; a reader sees their names.
  const describePlatform = (platform: string): string =>
    platform === "ios" ? tr("settings.nativePush.platformIos") : platform;
  const describeEnvironment = (environment: string): string => {
    if (environment === "sandbox") return tr("settings.nativePush.environmentSandbox");
    if (environment === "production") return tr("settings.nativePush.environmentProduction");
    return environment;
  };
  const [permission, setPermission] = useState<NativePushPermission>("prompt");
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [apnsConfigured, setApnsConfigured] = useState(true);
  const [deviceID, setDeviceID] = useState<string | null>(() => rememberedNativeDevice());
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listPushDevices();
      setDevices(list.devices ?? []);
      setApnsConfigured(list.apns_configured);
      setUnreachable(false);
      return list.devices ?? [];
    } catch (e) {
      // The last known state is not the current one: a node that cannot be
      // reached cannot confirm this device is still registered.
      setUnreachable(true);
      throw e;
    }
  }, []);

  useEffect(() => {
    if (!plugin && !desktop) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Finish a deletion an earlier attempt could not confirm, before the
        // list is read, so the page does not show a row this phone already
        // turned off.
        await flushPendingNativeDelete(api).catch(() => true);
        if (cancelled) return;
        const list = await refresh();
        if (cancelled) return;
        if (plugin) {
          const status = (await plugin.permission()).status;
          if (cancelled) return;
          setPermission(status);
          // Registering again on every granted load is what repairs a token
          // that rotated while the app was closed. syncNativePush never
          // prompts, and the install-keyed upsert keeps the same row id.
          const remembered = rememberedNativeDevice();
          if (status === "granted" && remembered) {
            const synced = await syncNativePush(plugin, api).catch(() => null);
            if (cancelled) return;
            if (synced) {
              rememberNativeDevice(synced.id);
              setDeviceID(synced.id);
              if (!list.some((d) => d.id === synced.id)) await refresh();
            }
          }
        }
      } catch (e) {
        if (cancelled) return;
        setMessage({
          kind: "error",
          text: e instanceof Error ? e.message : tr("settings.nativePush.unknown"),
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, desktop, plugin, refresh, tr]);

  // Returning from the system settings app does not remount the console. The
  // permission the reader just changed is the one thing this block must not
  // keep showing from before.
  useEffect(() => {
    if (!plugin) return;
    const reread = () => {
      void plugin
        .permission()
        .then((result) => setPermission(result.status))
        .catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") reread();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", reread);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", reread);
    };
  }, [plugin]);

  const enable = async () => {
    if (!plugin) return;
    setBusy(true);
    setMessage(null);
    try {
      const { id } = await enableNativePush(plugin, api);
      rememberNativeDevice(id);
      setDeviceID(id);
      setPermission("granted");
      await refresh();
      pushToast(tr("settings.nativePush.enabled"), "info");
    } catch (e) {
      if (e instanceof NativePushPermissionError) {
        setPermission(e.permission);
        setMessage({ kind: "error", text: tr("settings.nativePush.blockedHint") });
      } else {
        setMessage({
          kind: "error",
          text: e instanceof Error ? e.message : tr("settings.nativePush.enableFailed"),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!plugin || !deviceID) return;
    setBusy(true);
    setMessage(null);
    try {
      const { pending } = await disableNativePush(plugin, api, deviceID);
      forgetNativeDevice();
      setDeviceID(null);
      await refresh().catch(() => undefined);
      if (pending) {
        // This phone is off locally, but the node has not confirmed the row is
        // gone. The next settings load retries; saying "off" would hide a row
        // that can still ring it.
        setMessage({ kind: "info", text: tr("settings.nativePush.removePending") });
      } else {
        pushToast(tr("settings.nativePush.disabled"), "info");
      }
    } catch {
      // The local registration is still there, which is the truth: the phone
      // can still be reached until the node row is gone.
      setMessage({ kind: "error", text: tr("settings.nativePush.removeFailed") });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (!plugin || !deviceID) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await testPushDevice(deviceID);
      if (!result.configured) {
        setMessage({ kind: "error", text: tr("settings.nativePush.apnsMissing") });
        return;
      }
      if (result.expired) {
        // Apple will never accept this token again and the node has already
        // deleted the row. Leave "on" and offer enable, which mints a new one.
        forgetNativeDevice();
        setDeviceID(null);
        setMessage({ kind: "error", text: tr("settings.nativePush.expired") });
        await refresh().catch(() => undefined);
        return;
      }
      if (result.ok) {
        setMessage({ kind: "info", text: tr("settings.nativePush.testSent") });
        return;
      }
      const reason = result.results?.[0]?.error;
      setMessage({
        kind: "error",
        text: reason
          ? `${tr("settings.nativePush.testFailed")}: ${describePushReason(reason)}`
          : tr("settings.nativePush.testTimeout"),
      });
      // An expired token is deleted by the node; the list must stop showing it.
      await refresh().catch(() => undefined);
    } catch (e) {
      // 410 is the node saying this login ended and it deleted the row. Read
      // the status structurally so the check does not depend on the error class
      // a caller (or a test double) happens to use.
      const status = (e as { status?: unknown } | null)?.status;
      if (status === 410) {
        // The login this phone registered under has ended, and the node has
        // already deleted the row. This phone must not claim it is still on.
        forgetNativeDevice();
        setDeviceID(null);
        setMessage({ kind: "error", text: tr("settings.nativePush.sessionEnded") });
        await refresh().catch(() => undefined);
        return;
      }
      if (status === 404) {
        // The row is gone: another tab signed out, or an earlier send found
        // the token dead. Showing "device not found" would leave the page
        // claiming this phone is still registered.
        forgetNativeDevice();
        setDeviceID(null);
        setMessage({ kind: "error", text: tr("settings.nativePush.notRegistered") });
        await refresh().catch(() => undefined);
        return;
      }
      setMessage({
        kind: "error",
        text: e instanceof Error ? e.message : tr("settings.nativePush.testFailed"),
      });
    } finally {
      setBusy(false);
    }
  };

  const sendMacTest = async () => {
    setBusy(true);
    setMessage(null);
    try {
      // Desktop only: testing this Mac must not ring every paired phone, and a
      // phone failure must not make the Mac's own banner look broken.
      const result = await testNotify("desktop");
      const desktop = result.results?.find((r) => r.channel === "desktop");
      if (desktop?.ok) {
        setMessage({ kind: "info", text: tr("settings.nativePush.testSent") });
      } else {
        setMessage({
          kind: "error",
          text: desktop?.error || tr("settings.nativePush.testFailed"),
        });
      }
    } catch (e) {
      setMessage({
        kind: "error",
        text: e instanceof Error ? e.message : tr("settings.nativePush.testFailed"),
      });
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (device: PushDevice) => {
    setBusy(true);
    setMessage(null);
    try {
      if (plugin && device.id === deviceID) {
        // This is the phone in hand: turn it off through the same path as the
        // main button, which also remembers a node deletion it could not
        // confirm.
        const { pending } = await disableNativePush(plugin, api, device.id);
        forgetNativeDevice();
        setDeviceID(null);
        if (pending) {
          setMessage({ kind: "info", text: tr("settings.nativePush.removePending") });
        }
      } else {
        try {
          await api.deletePushDevice(device.id);
        } catch (e) {
          // Already gone is the outcome the click asked for.
          if (!isNotFoundError(e)) throw e;
        }
      }
      await refresh().catch(() => undefined);
    } catch {
      setMessage({ kind: "error", text: tr("settings.nativePush.removeFailed") });
    } finally {
      setBusy(false);
    }
  };

  const openSettings = () => {
    void plugin?.openSettings().catch(() => undefined);
  };

  const openMacSettings = async () => {
    const result = await openNotificationSettings();
    if (!result.ok) {
      setMessage({ kind: "error", text: tr("settings.nativePush.openSettingsFailed") });
    }
  };

  if (!plugin && !desktop) {
    return (
      <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-2">
        <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
          {tr("settings.nativePush.heading")}
        </h2>
        <p className="text-body leading-4 text-kin-muted">
          {tr("settings.nativePush.browserOnly")}
        </p>
        <p className="text-body leading-4 text-kin-muted">
          {tr("settings.nativePush.browserHint")}
        </p>
      </section>
    );
  }

  const title = plugin
    ? tr("settings.nativePush.iphoneTitle")
    : tr("settings.nativePush.macTitle");
  const stateLabel = loading || unreachable
    ? tr("settings.nativePush.unknown")
    : !plugin
    ? tr("settings.nativePush.macManaged")
    : permission === "denied"
      ? tr("settings.nativePush.blocked")
      : permission === "granted" && deviceID
        ? tr("settings.nativePush.on")
        : tr("settings.nativePush.off");

  return (
    <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
      <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
        {tr("settings.nativePush.heading")}
      </h2>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body font-medium text-kin-secondary">{title}</span>
          <span
            role="status"
            aria-live="polite"
            className={
              stateLabel === tr("settings.nativePush.on")
                ? "text-body text-kin-green-ink"
                : "text-body text-kin-muted"
            }
          >
            {stateLabel}
          </span>
        </div>
        {!plugin && (
          <div className="space-y-2">
            <p className="text-body leading-4 text-kin-muted">
              {tr("settings.nativePush.macDesc")}
            </p>
            <p className="text-body leading-4 text-kin-muted">
              {tr("settings.nativePush.macSettingsHint")}
            </p>
          </div>
        )}
        <p className="text-body leading-4 text-kin-muted">
          {tr("settings.nativePush.eventsHint")}
        </p>

        {plugin && permission === "denied" && (
          <div className="space-y-2">
            <p className="text-body leading-4 text-kin-muted">
              {tr("settings.nativePush.blockedHint")}
            </p>
            <button
              type="button"
              onClick={openSettings}
              className="kin-btn-secondary min-h-11"
            >
              {tr("settings.nativePush.openSettings")}
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {plugin && permission !== "denied" && !deviceID && (
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => void enable()}
              className="kin-btn-primary min-h-11 disabled:opacity-50"
            >
              {busy ? tr("settings.nativePush.enabling") : tr("settings.nativePush.enable")}
            </button>
          )}
          {plugin && deviceID && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void sendTest()}
                className="kin-btn-secondary min-h-11 disabled:opacity-50"
              >
                {busy ? tr("settings.nativePush.testing") : tr("settings.nativePush.sendTest")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void disable()}
                className="kin-btn-secondary min-h-11 disabled:opacity-50"
              >
                {tr("settings.nativePush.disable")}
              </button>
            </>
          )}
          {!plugin && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void sendMacTest()}
                className="kin-btn-secondary min-h-11 disabled:opacity-50"
              >
                {busy ? tr("settings.nativePush.testing") : tr("settings.nativePush.sendTest")}
              </button>
              <button
                type="button"
                onClick={() => void openMacSettings()}
                className="kin-btn-secondary min-h-11"
              >
                {tr("settings.nativePush.openSettings")}
              </button>
            </>
          )}
        </div>

        {plugin && !apnsConfigured && (
          <p className="text-body leading-4 text-kin-red-ink">{tr("settings.nativePush.apnsMissing")}</p>
        )}
        {message && (
          <p
            role={message.kind === "error" ? "alert" : "status"}
            className={
              message.kind === "error"
                ? "text-body leading-4 text-kin-red-ink"
                : "text-body leading-4 text-kin-green-ink"
            }
          >
            {message.text}
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-kin-hairline pt-3">
        <h3 className="text-body font-medium text-kin-secondary">
          {tr("settings.nativePush.devicesHeading")}
        </h3>
        {devices.length === 0 ? (
          <p className="text-body leading-4 text-kin-muted">
            {tr("settings.nativePush.noDevices")}
          </p>
        ) : (
          <ul className="space-y-2">
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-kin-elevated/60 px-3 py-2"
              >
                <span className="text-body font-medium text-kin-secondary">
                  {device.name || describePlatform(device.platform)}
                </span>
                <span className="text-caption text-kin-muted">
                  {describeEnvironment(device.environment)}
                </span>
                {device.last_error ? (
                  <span className="text-caption text-kin-red-ink">
                    {tr("settings.nativePush.lastError")}: {describePushReason(device.last_error)}
                  </span>
                ) : (
                  <span className="text-caption text-kin-muted">
                    {tr("settings.nativePush.lastOk")}:{" "}
                    {device.last_ok_at
                      ? new Date(device.last_ok_at).toLocaleString()
                      : tr("settings.nativePush.never")}
                  </span>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeDevice(device)}
                  className="ml-auto text-caption text-kin-muted underline disabled:opacity-50"
                >
                  {tr("settings.nativePush.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
