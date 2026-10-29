import { useEffect, useState } from "react";
import {
  getPushConfig,
  subscribePush,
  testPush,
  unsubscribePush,
} from "../../api/client";
import { useT } from "../../i18n/react";
import {
  PushPermissionError,
  PushUnsubscribeError,
  currentPushSubscription,
  disablePush,
  enablePush,
  pushPermission,
  pushSupported,
  requestPushPermission,
  serializeSubscription,
  type PushState,
} from "../../lib/push";
import { useAppStore } from "../../store/appStore";

/**
 * Browser push, under the notification settings.
 *
 * The state shown is the browser's, not the daemon's: what matters to the
 * reader is whether *this* device will ring. The daemon's count of
 * registrations is only fetched on an explicit action, because the config
 * endpoint mints the node's VAPID keypair the first time it is asked, and a
 * settings page that mints key material just by being opened is exactly the
 * kind of implicit side effect the integration rules forbid.
 */
export function PushSettingsSection() {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const [state, setState] = useState<PushState>(() =>
    pushSupported() ? "off" : "unsupported",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported()) return;
    let cancelled = false;
    void (async () => {
      const subscription = await currentPushSubscription().catch(() => null);
      if (cancelled) return;
      if (subscription) setState("on");
      else if (pushPermission() === "denied") setState("blocked");
      else setState("off");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      // Ask for the permission before anything else. WebKit drops the user
      // activation at the first await, and a prompt issued after the config
      // round trip is ignored or auto-denied — on iOS, which is the platform
      // the hint names.
      const permission = await requestPushPermission();
      if (permission !== "granted") {
        setState("blocked");
        pushToast(tr("settings.push.blocked"), "error");
        return;
      }
      const config = await getPushConfig();
      const subscription = await enablePush(config.public_key);
      const body = serializeSubscription(subscription);
      if (!body) throw new Error(tr("settings.push.subscribeFailed"));
      await subscribePush(body);
      setState("on");
      pushToast(tr("settings.push.enabled"), "info");
    } catch (e) {
      if (e instanceof PushPermissionError) {
        setState("blocked");
        pushToast(tr("settings.push.blocked"), "error");
      } else {
        pushToast(e instanceof Error ? e.message : tr("settings.push.enableFailed"), "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const endpoint = await disablePush();
      if (endpoint) await unsubscribePush(endpoint);
      setState("off");
      pushToast(tr("settings.push.disabled"), "info");
    } catch (e) {
      if (e instanceof PushUnsubscribeError) {
        pushToast(tr("settings.push.disableFailed"), "error");
        return;
      }
      pushToast(e instanceof Error ? e.message : tr("settings.push.disableFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const result = await testPush();
      pushToast(
        result.ok ? tr("settings.push.testSent") : tr("settings.push.testFailed"),
        result.ok ? "info" : "error",
      );
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("settings.push.testFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-3">
      <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
        {tr("settings.push.heading")}
      </h2>
      <p className="text-body leading-4 text-kin-muted">{tr("settings.push.desc")}</p>
      <div className="flex flex-wrap items-center gap-3">
        {state === "unsupported" && (
          <span className="text-body leading-4 text-kin-muted">
            {tr("settings.push.unsupported")}
          </span>
        )}
        {state === "blocked" && (
          <span className="text-body leading-4 text-kin-muted">
            {tr("settings.push.blocked")}
          </span>
        )}
        {state === "off" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void enable()}
            className="kin-btn-primary min-h-11 disabled:opacity-50"
          >
            {tr("settings.push.enable")}
          </button>
        )}
        {state === "on" && (
          <>
            <span className="text-body leading-4 text-kin-green-ink">
              {tr("settings.push.on")}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendTest()}
              className="kin-btn-secondary min-h-11 disabled:opacity-50"
            >
              {tr("settings.push.sendTest")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void disable()}
              className="kin-btn-secondary min-h-11 disabled:opacity-50"
            >
              {tr("settings.push.disable")}
            </button>
          </>
        )}
      </div>
      <p className="text-body leading-4 text-kin-muted">{tr("settings.push.hint")}</p>
    </section>
  );
}
