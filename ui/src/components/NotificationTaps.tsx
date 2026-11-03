import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { usePendingResources } from "../api/useLiveResources";
import { liveResources } from "../api/liveResources";
import {
  consumeNativeNotificationRoute,
  installForegroundNotifications,
  installNotificationRouting,
  type NotificationRoute,
  type NotificationTapSource,
} from "../lib/notificationRoute";
import { clearDeliveredNotification, deliveredNotificationTargets, nativePushPlugin } from "../lib/nativePush";
import { useAppStore } from "../store/appStore";

/**
 * Bring a notification tap into the console.
 *
 * The node writes the link, both shells deliver it, and this is the one place
 * that turns it into a route. A tap while the console is running arrives as an
 * event; a tap that launched the app is held by the iPhone shell and drained
 * once here, after the router exists. Validation lives in
 * `notificationRoute.ts` — a link is only ever a known path, never a URL this
 * window opens.
 */
export function NotificationTaps({
  source = nativePushPlugin(),
}: {
  source?: NotificationTapSource | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  // Router versions do not promise this function's identity, and a new one
  // would re-run the effect on every route change — re-installing the listener
  // and asking the shell for a pending tap again. The ref keeps the effect
  // tied to the source alone.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const pushToast = useAppStore((s) => s.pushToast);
  // This component also mounts above the sign-in gate, so a tap that arrives
  // before the reader is through it still changes the route. Asking the node
  // for pending items there would 401 on every first launch and flip the gate
  // from "connect" to "session no longer authorized".
  const authed = useAppStore((s) => s.auth.status === "ok");
  // Where a tap has already taken the reader. Kept in step with the route so
  // the same notification is silent while it is the current page, and becomes
  // a real tap again after the reader leaves. A cold-start tap can arrive twice
  // (an event from the shell and the held link it returns); one navigation.
  const here = location.pathname + location.search;
  const deliveredRef = useRef(here);
  deliveredRef.current = here;

  useEffect(() => {
    // A notification that arrives while the app is in front is shown here
    // instead of as a system banner. It announces, it does not navigate:
    // moving the reader away from what they were doing would answer "this
    // finished" with a jump to somewhere else.
    return installForegroundNotifications((notification) => {
      const text = [notification.title, notification.body].filter(Boolean).join(" — ");
      pushToast(text || "Kin", notification.kind === "approval" ? "error" : "info");
    });
  }, [pushToast]);

  useEffect(() => {
    const deliver = (route: NotificationRoute) => {
      // A warm tap is delivered as an event *and* kept by the shell until the
      // console acknowledges it. Acknowledge even when the reader is already
      // on the target, so the next launch does not replay it.
      void source?.takePendingURL?.().catch(() => {});
      if (route.path === deliveredRef.current) return;
      deliveredRef.current = route.path;
      navigateRef.current(route.path);
    };

    const uninstall = installNotificationRouting(deliver);
    void consumeNativeNotificationRoute(source).then((route) => {
      if (route) deliver(route);
    });
    return uninstall;
  }, [source]);

  // A delivered banner outlives the thing it announces. When an approval is
  // decided on another device, a question is answered, or the request expires,
  // the item leaves the pending list but its banner stays in Notification
  // Center — offering a tap that leads nowhere. The pending list is the source
  // of truth: an id that disappears from it takes its banner with it.
  const pending = usePendingResources(authed);
  const knownPending = useRef<{ approvals: Set<string>; questions: Set<string> } | null>(null);
  useEffect(() => {
    if (!pending.loaded) return;
    const approvals = new Set(pending.data.approvals.map((item) => item.id));
    const questions = new Set(pending.data.questions.map((item) => item.id));
    const previous = knownPending.current;
    knownPending.current = { approvals, questions };
    if (!previous) {
      // The first answer in this process is the baseline for changes that
      // happen while it runs — but a banner can outlive the process. Ask the
      // shell what is still in Notification Center and take away the approval
      // and question banners the node no longer lists. Task and routine
      // banners are not pending items and are left alone.
      void reconcileDelivered(approvals, questions);
      return;
    }
    for (const id of previous.approvals) {
      if (!approvals.has(id)) clearDeliveredNotification("approval", id);
    }
    for (const id of previous.questions) {
      if (!questions.has(id)) clearDeliveredNotification("question", id);
    }
  }, [pending.loaded, pending.data]);

  // While the phone was locked or the app was in the background, another
  // device may have handled the item. A live socket can be suspended there, so
  // ask once on return; the effect above then takes stale banners away.
  useEffect(() => {
    if (!source || !authed) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void liveResources.refreshPending();
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [source, authed]);

  return null;
}

async function reconcileDelivered(
  approvals: Set<string>,
  questions: Set<string>,
): Promise<void> {
  const delivered = await deliveredNotificationTargets();
  for (const target of delivered) {
    if (target.kind === "approval" && !approvals.has(target.id)) {
      clearDeliveredNotification("approval", target.id);
    } else if (target.kind === "question" && !questions.has(target.id)) {
      clearDeliveredNotification("question", target.id);
    }
  }
}

export default NotificationTaps;
