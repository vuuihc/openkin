/**
 * Browser push registration.
 *
 * The daemon sends; this side only has to answer three questions: can this
 * browser receive push at all, is it already subscribed, and how does a
 * subscription become the JSON the daemon stores. Everything here runs on an
 * explicit user action — registering the worker or asking for the notification
 * permission while a passive settings page loads is the kind of prompt people
 * deny out of reflex, and a denied permission is sticky.
 */

export type PushState = "unsupported" | "blocked" | "off" | "on";

/** Whether this browser can receive push from a console page. */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/** The permission state, without prompting. */
export function pushPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * Turn the daemon's base64url VAPID key into the bytes `subscribe` wants.
 *
 * `atob` needs standard base64 with padding, while the key travels URL-safe
 * and unpadded. Getting this wrong fails inside the browser with an unhelpful
 * "applicationServerKey is not valid".
 */
export function applicationServerKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const raw = atob(withPadding);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The subscription this browser already holds, if any. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/** Thrown when the reader declines the notification permission. */
export class PushPermissionError extends Error {
  constructor(readonly permission: NotificationPermission) {
    super(`notification permission is ${permission}`);
    this.name = "PushPermissionError";
  }
}

/**
 * Ask for permission, register the worker, and subscribe.
 *
 * Must be called from a user gesture: browsers refuse both the permission
 * prompt and, on some platforms, the subscription otherwise.
 */
export async function enablePush(publicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushPermissionError(permission);
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
}

/** Drop the browser's subscription. Returns its endpoint, for the daemon. */
export async function disablePush(): Promise<string | null> {
  const subscription = await currentPushSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}

/** The wire shape the daemon stores, from the browser's own JSON. */
export type SerializedSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export function serializeSubscription(
  subscription: PushSubscription,
): SerializedSubscription | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}
