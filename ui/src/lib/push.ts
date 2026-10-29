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

/** Thrown when the browser refused to drop a subscription. */
export class PushUnsubscribeError extends Error {
  constructor() {
    super("the browser kept the push subscription");
    this.name = "PushUnsubscribeError";
  }
}

/**
 * Ask for the notification permission.
 *
 * Exported separately from `enablePush` so the settings button can call it as
 * the first statement of its click handler. WebKit — which on iOS is every
 * browser — drops the user activation at the first `await`, and a prompt
 * requested after a network round trip is ignored or auto-denied, permanently.
 * Everything the daemon needs can wait until after the prompt.
 */
export function requestPushPermission(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}

/**
 * Whether an existing subscription was created with this key.
 *
 * A browser keeps its subscription across a daemon that minted a new key pair —
 * a restored database, a re-keyed node — and the push service then answers 403
 * to every message while the settings page still says "on". Re-subscribing is
 * how enabling repairs that instead of leaving a dead registration behind.
 */
function matchesKey(subscription: PushSubscription, key: Uint8Array<ArrayBuffer>): boolean {
  // The lib types say ArrayBuffer; browsers that predate the spec settled on
  // handing back a typed array, so both are accepted here rather than assumed.
  const current = subscription.options?.applicationServerKey as
    | ArrayBuffer
    | ArrayBufferView
    | null
    | undefined;
  if (!current) return false;
  const bytes = ArrayBuffer.isView(current)
    ? new Uint8Array(current.buffer, current.byteOffset, current.byteLength)
    : new Uint8Array(current);
  if (bytes.length !== key.length) return false;
  return bytes.every((byte, i) => byte === key[i]);
}

/**
 * Ask for permission, register the worker, and subscribe.
 *
 * Must be called from a user gesture: browsers refuse both the permission
 * prompt and, on some platforms, the subscription otherwise.
 */
export async function enablePush(publicKey: string): Promise<PushSubscription> {
  const permission = await requestPushPermission();
  if (permission !== "granted") throw new PushPermissionError(permission);
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const key = applicationServerKey(publicKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing && matchesKey(existing, key)) return existing;
  // A subscription is bound to the key it was created with; reusing one made
  // for another key would register an endpoint the push service refuses.
  if (existing) await existing.unsubscribe();
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
}

/** Drop the browser's subscription. Returns its endpoint, for the daemon. */
export async function disablePush(): Promise<string | null> {
  const subscription = await currentPushSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  // A browser that keeps its subscription keeps ringing. Forgetting the daemon
  // row anyway would make the settings page say "off" while the device still
  // receives messages, with no way back except enabling again.
  if (!(await subscription.unsubscribe())) throw new PushUnsubscribeError();
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
