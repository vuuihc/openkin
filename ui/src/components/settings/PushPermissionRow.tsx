import { useEffect, useRef, useState } from "react";
import { deletePushDevice, registerPushDevice } from "../../api/client";
import { useT } from "../../i18n/react";
import {
  NativePushPermissionError,
  enableNativePush,
  nativePushPlugin,
  rememberNativeDevice,
  rememberedNativeDevice,
  syncNativePush,
  type NativePushApi,
  type NativePushPermission,
  type NativePushPlugin,
} from "../../lib/nativePush";
import { useAppStore } from "../../store/appStore";

/**
 * The one notification control the console keeps after R0b-3.
 *
 * The Notifications settings tab is gone: the console does not list devices,
 * send test pushes, or configure APNs any more. What remains is the single
 * thing the system settings app cannot do for us — iOS only adds Kin to
 * Settings → Notifications after the app has called `requestAuthorization`
 * once, and that call has to come from a tap. So this row appears only inside
 * the iPhone shell, and only until the permission is granted; a granted phone
 * registers itself on launch (see `syncNativePush` in NotificationTaps), and
 * a denied one is pointed at the system settings that own the switch.
 *
 * It renders nothing on the Mac and in a browser: there is no APNs plugin, and
 * macOS notifications are the desktop shell's own.
 */
const clientApi: NativePushApi = { registerPushDevice, deletePushDevice };

export type PushPermissionRowProps = {
  plugin?: NativePushPlugin | null;
  api?: NativePushApi;
};

export function PushPermissionRow({
  plugin = nativePushPlugin(),
  api = clientApi,
}: PushPermissionRowProps) {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const [permission, setPermission] = useState<NativePushPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // The re-read listeners below are installed once; they must see a failure
  // that happened after they were created.
  const failedRef = useRef(false);
  const noteFailed = (value: boolean) => {
    failedRef.current = value;
    setFailed(value);
  };

  useEffect(() => {
    if (!plugin) return;
    let cancelled = false;
    void plugin
      .permission()
      .then((result) => {
        if (cancelled) return;
        // A granted phone hides this row, so an install that never recorded a
        // node row (cleared storage, or a registration that failed on another
        // page) has no other place to notice. Ask the silent sync to make one;
        // if it cannot, surface the retry instead of hiding a broken state.
        if (result.status === "granted" && !rememberedNativeDevice()) {
          void syncNativePush(plugin, api)
            .then((saved) => {
              if (saved) rememberNativeDevice(saved.id);
            })
            .catch(() => {
              if (!cancelled) noteFailed(true);
            });
        }
        setPermission(result.status);
      })
      .catch(() => {
        if (!cancelled) setPermission(null);
      });
    return () => {
      cancelled = true;
    };
  }, [plugin]);

  // Returning from the system settings app does not remount the console; the
  // permission the reader just changed is the one thing this row must not keep
  // showing from before.
  useEffect(() => {
    if (!plugin) return;
    const reread = () => {
      void plugin
        .permission()
        .then((result) => {
          if (result.status !== "granted" || !failedRef.current) {
            setPermission(result.status);
            return;
          }
          // The tap got the grant, but the node call after it failed and the
          // row stayed up with its retry message. Finish that registration
          // without asking again, and stay visible until a row exists.
          void syncNativePush(plugin, api)
            .then((saved) => {
              if (!saved) return;
              rememberNativeDevice(saved.id);
              noteFailed(false);
              setPermission("granted");
            })
            .catch(() => undefined);
        })
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
  }, [plugin, api]);

  if (!plugin || permission === null) return null;
  // Granted with no failure is the quiet case. A granted phone whose
  // registration failed keeps this row (and its retry) until a row exists —
  // otherwise a focus re-read would hide the only sign that push is off.
  if (permission === "granted" && !failed && !busy) return null;

  const enable = async () => {
    setBusy(true);
    noteFailed(false);
    try {
      const { id } = await enableNativePush(plugin, api);
      rememberNativeDevice(id);
      setPermission("granted");
      pushToast(tr("settings.push.enabled"), "info");
    } catch (e) {
      if (e instanceof NativePushPermissionError) {
        setPermission(e.permission);
      } else {
        noteFailed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl bg-kin-elevated/60 p-4">
      <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
        {tr("settings.push.heading")}
      </h2>
      <p className="mt-2 text-body leading-prose text-kin-secondary">
        {permission === "granted"
          ? tr("settings.push.unregistered")
          : permission === "denied"
            ? tr("settings.push.denied")
            : tr("settings.push.prompt")}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {permission === "denied" ? (
          <button
            type="button"
            onClick={() => void plugin.openSettings().catch(() => undefined)}
            className="min-h-11 rounded-lg border border-[var(--kin-hairline)] px-3 text-strong font-medium text-kin-secondary hover:bg-[var(--kin-fill)]"
          >
            {tr("settings.push.openSettings")}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void enable()}
            className="min-h-11 rounded-lg bg-kin-blue px-3 text-strong font-medium text-kin-on-brand disabled:opacity-50"
          >
            {busy ? tr("settings.push.enabling") : tr("settings.push.enable")}
          </button>
        )}
        {failed ? (
          <span role="alert" className="text-caption text-kin-red-ink">
            {tr("settings.push.failed")}
          </span>
        ) : null}
      </div>
    </section>
  );
}
