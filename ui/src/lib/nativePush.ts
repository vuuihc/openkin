/**
 * Native push on iPhone.
 *
 * The console is a web app that also runs inside the Capacitor shell. In that
 * shell there is no `PushManager`; APNs is the only way a phone can be woken
 * while the app is in the background. The native side owns the system
 * permission and the device token, the node owns the registration, and this
 * module is the small contract between them.
 *
 * Nothing here prompts on load: a permission prompt has to come from a tap, and
 * a denied prompt is sticky. Reading state asks the native plugin a question it
 * can answer without prompting.
 */

export type PushEnvironment = "sandbox" | "production";

export type NativePushPermission = "granted" | "denied" | "prompt";

export type NativeRegistration = {
  /** Stable per-install id; the node dedupes registrations by it. */
  installId: string;
  /** APNs device token, lowercase or uppercase hex. */
  token: string;
  environment: PushEnvironment;
  /** Human-readable phone name, when the shell can supply one. */
  name?: string;
};

/** The Capacitor plugin implemented by the iOS app target. */
export type NativePushPlugin = {
  permission(): Promise<{ status: NativePushPermission }>;
  requestPermission(): Promise<{ status: NativePushPermission }>;
  register(): Promise<NativeRegistration>;
  unregister(): Promise<void>;
  openSettings(): Promise<void>;
  /** A notification tap that arrived before the console mounted. */
  takePendingURL?(): Promise<{ url?: string } | null | undefined>;
  /** Remove the delivered banner for an item the person already handled. */
  clearDelivered?(target: { kind: string; id: string }): Promise<void>;
  /** What is still sitting in Notification Center, as `kin` targets. */
  deliveredTargets?(): Promise<{ targets?: unknown } | null | undefined>;
};

/** The node calls this module makes. Injectable so tests need no HTTP. */
export type NativePushApi = {
  registerPushDevice(input: {
    install_id: string;
    platform: "ios";
    token: string;
    environment: PushEnvironment;
    name?: string;
  }): Promise<{ id: string }>;
  deletePushDevice(id: string): Promise<void>;
};

/** The one node call signing out needs; the rest of NativePushApi is not used. */
export type NativePushRemovalApi = {
  deletePushDevice(id: string): Promise<void>;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
};

function capacitorOf(scope: unknown): CapacitorGlobal | null {
  if (!scope || typeof scope !== "object") return null;
  const value = (scope as { Capacitor?: unknown }).Capacitor;
  if (!value || typeof value !== "object") return null;
  return value as CapacitorGlobal;
}

/** The iOS plugin, or null in a browser, on macOS, or in an old shell build. */
export function nativePushPlugin(scope: unknown = globalThis): NativePushPlugin | null {
  const capacitor = capacitorOf(scope);
  if (!capacitor) return null;
  if (typeof capacitor.isNativePlatform === "function" && !capacitor.isNativePlatform()) {
    return null;
  }
  if (typeof capacitor.getPlatform === "function" && capacitor.getPlatform() !== "ios") {
    return null;
  }
  const plugin = capacitor.Plugins?.KinNativePush;
  if (!plugin || typeof plugin !== "object") return null;
  const candidate = plugin as Partial<NativePushPlugin>;
  if (
    typeof candidate.permission !== "function" ||
    typeof candidate.requestPermission !== "function" ||
    typeof candidate.register !== "function" ||
    typeof candidate.unregister !== "function" ||
    typeof candidate.openSettings !== "function"
  ) {
    return null;
  }
  return candidate as NativePushPlugin;
}

/**
 * What surface this console is running on. The settings section shows one
 * device block, so "browser" must be distinguishable from "this shell simply
 * has no push plugin".
 */
export function nativePushSurface(scope: unknown = globalThis): "ios" | "browser" {
  return nativePushPlugin(scope) ? "ios" : "browser";
}

/** Thrown when iOS will not grant the notification permission. */
export class NativePushPermissionError extends Error {
  constructor(readonly permission: NativePushPermission) {
    super(`notification permission is ${permission}`);
    this.name = "NativePushPermissionError";
  }
}

/**
 * The translation key for an APNs reason the reader can act on.
 *
 * Apple's reasons are short machine tokens; showing "BadDeviceToken" to a
 * person explains nothing. Unknown reasons keep their raw text, because that
 * is the honest thing to show when only the provider knows what happened.
 */
export function pushErrorKey(reason: string): string | null {
  switch (reason.trim()) {
    case "BadDeviceToken":
    case "DeviceTokenNotForTopic":
    case "Unregistered":
      return "settings.nativePush.apnsErrors.token";
    case "ExpiredProviderToken":
    case "InvalidProviderToken":
    case "MissingProviderToken":
      return "settings.nativePush.apnsErrors.credentials";
    case "TooManyRequests":
      return "settings.nativePush.apnsErrors.rateLimited";
    case "ServiceUnavailable":
    case "InternalServerError":
      return "settings.nativePush.apnsErrors.unavailable";
    default:
      return null;
  }
}

function statusOf(value: unknown): NativePushPermission {
  if (value === "granted" || value === "denied" || value === "prompt") return value;
  return "prompt";
}

/** Ask the system for the permission. Must be called from a user gesture. */
export async function requestNativePushPermission(
  plugin: NativePushPlugin,
): Promise<NativePushPermission> {
  const result = await plugin.permission();
  if (statusOf(result?.status) !== "prompt") return statusOf(result?.status);
  const asked = await plugin.requestPermission();
  return statusOf(asked?.status);
}

/**
 * Ask for permission, get a token, and register it with the node.
 *
 * Registration is an upsert keyed by install id, so enabling twice is safe and
 * repairs a token that rotated while the app was closed.
 */
export async function enableNativePush(
  plugin: NativePushPlugin,
  api: NativePushApi,
): Promise<{ id: string; registration: NativeRegistration }> {
  const permission = await requestNativePushPermission(plugin);
  if (permission !== "granted") throw new NativePushPermissionError(permission);
  const registration = await plugin.register();
  if (!registration?.installId || !registration?.token) {
    throw new Error("the native shell returned an incomplete registration");
  }
  const saved = await api.registerPushDevice({
    install_id: registration.installId,
    platform: "ios",
    token: registration.token,
    environment: registration.environment,
    name: registration.name,
  });
  return { id: saved.id, registration };
}

/**
 * Re-register without prompting, for a phone whose permission is already
 * granted. Returns null when the permission has since been revoked.
 */
export async function syncNativePush(
  plugin: NativePushPlugin,
  api: NativePushApi,
): Promise<{ id: string; registration: NativeRegistration } | null> {
  const permission = statusOf((await plugin.permission())?.status);
  if (permission !== "granted") return null;
  const registration = await plugin.register();
  if (!registration?.installId || !registration?.token) return null;
  const saved = await api.registerPushDevice({
    install_id: registration.installId,
    platform: "ios",
    token: registration.token,
    environment: registration.environment,
    name: registration.name,
  });
  return { id: saved.id, registration };
}

/**
 * Remove the node row first, then stop the shell from receiving. Doing it the
 * other way round hides a row that still rings the phone with no way to find it.
 *
 * A 404 means the row is already gone, and 401/403 mean this credential can
 * never delete it; all three are terminal, since retrying cannot change the
 * answer. Any other failure leaves the node row addressable: the id is
 * remembered so the next settings load can finish the deletion, and the shell
 * still stops receiving in the meantime. Returns whether that retry is
 * outstanding.
 */
export async function disableNativePush(
  plugin: NativePushPlugin,
  api: NativePushApi,
  deviceID: string,
): Promise<{ pending: boolean }> {
  let pending = false;
  try {
    await api.deletePushDevice(deviceID);
    forgetPendingNativeDelete();
  } catch (e) {
    if (isFinalRemovalError(e)) {
      forgetPendingNativeDelete();
    } else {
      rememberPendingNativeDelete(deviceID);
      pending = true;
    }
  }
  // Unregister even when the node call failed: the phone must stop receiving
  // either way, and the pending marker is what keeps the row from being lost.
  try {
    await plugin.unregister();
  } catch {
    // A shell that cannot unregister has no token to receive with anymore in
    // practice; the node row is the part that needs the retry.
  }
  return { pending };
}

/** True when the node says the row does not exist. */
export function isNotFoundError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { status?: unknown }).status === 404;
}

/**
 * True when retrying the deletion can never succeed: the row is gone, the
 * credential is gone, or the row belongs to someone else. Keeping one of these
 * on the pending list would retry it on every settings load forever.
 */
function isFinalRemovalError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 404 || status === 401 || status === 403;
}

/**
 * Take a handled item's banner out of Notification Center. The native side
 * matches the node's `kin` payload, so a different item's banner stays. This is
 * best-effort by design: a delivered notification is system state, and the
 * inbox — not the banner — is the source of truth.
 */
export function clearDeliveredNotification(kind: "approval" | "question", id: string): void {
  if (!id) return;
  const plugin = nativePushPlugin();
  void plugin?.clearDelivered?.({ kind, id }).catch(() => undefined);
}

/**
 * The `kin` targets still delivered in Notification Center.
 *
 * A banner can outlive the console process, so a cold start cannot learn about
 * it by diffing pending lists. The shell answers with what it has; anything
 * malformed is dropped here rather than trusted, because it is native state
 * crossing into the page.
 */
export async function deliveredNotificationTargets(): Promise<
  Array<{ kind: string; id: string }>
> {
  const plugin = nativePushPlugin();
  if (!plugin?.deliveredTargets) return [];
  let raw: unknown;
  try {
    const answer = await plugin.deliveredTargets();
    raw = answer && typeof answer === "object" ? answer.targets : undefined;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Array<{ kind: string; id: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const target = item as { kind?: unknown; id?: unknown };
    const id = typeof target.id === "string" ? target.id.slice(0, 120) : "";
    if (!id) continue;
    const kind = typeof target.kind === "string" ? target.kind.slice(0, 40) : "";
    out.push({ kind, id });
  }
  return out;
}

// The node row this installation registered is remembered locally so the
// settings page can say "this iPhone" without the API revealing install ids.
const DEVICE_KEY = "kin.nativePush.deviceID";

export function rememberNativeDevice(id: string): void {
  try {
    globalThis.localStorage?.setItem(DEVICE_KEY, id);
  } catch {
    // A private or storage-disabled shell still works; it just forgets which
    // row is this phone and offers enable again.
  }
}

export function rememberedNativeDevice(): string | null {
  try {
    return globalThis.localStorage?.getItem(DEVICE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function forgetNativeDevice(): void {
  try {
    globalThis.localStorage?.removeItem(DEVICE_KEY);
  } catch {
    // See above.
  }
}

// A deletion the node did not acknowledge. It is separate from DEVICE_KEY: the
// phone is already off locally, but the row still has to go.
const PENDING_DELETE_KEY = "kin.nativePush.pendingDelete";

export function rememberPendingNativeDelete(id: string): void {
  try {
    globalThis.localStorage?.setItem(PENDING_DELETE_KEY, id);
  } catch {
    // If storage is unavailable the retry is lost, but the local unregister
    // already stopped this phone from receiving.
  }
}

export function pendingNativeDelete(): string | null {
  try {
    return globalThis.localStorage?.getItem(PENDING_DELETE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function forgetPendingNativeDelete(): void {
  try {
    globalThis.localStorage?.removeItem(PENDING_DELETE_KEY);
  } catch {
    // See above.
  }
}

/**
 * Finish a deletion an earlier attempt could not confirm. Returns true while
 * the row is still unconfirmed (the node is unreachable). A 404 is success,
 * and 401/403 mean retrying can never succeed, so those end the retry too.
 */
export async function flushPendingNativeDelete(api: NativePushApi): Promise<boolean> {
  const id = pendingNativeDelete();
  if (!id) return false;
  try {
    await api.deletePushDevice(id);
  } catch (e) {
    if (isFinalRemovalError(e)) {
      forgetPendingNativeDelete();
      return false;
    }
    return true;
  }
  forgetPendingNativeDelete();
  return false;
}

/**
 * Stop this phone from receiving notifications for the account signing out.
 *
 * The node also deletes session-bound rows on logout, so this is the local
 * half of the same promise: run it while the cookie that authorizes the
 * deletion still exists, and stop the shell even when the node cannot be
 * reached. A row the request could not delete for a retryable reason is
 * remembered and retried the next time settings opens; 404/401/403 end the
 * retry, because no later attempt can change the answer. The phone stays quiet
 * in the meantime.
 */
export async function disableNativePushOnSignOut(api: NativePushRemovalApi): Promise<void> {
  const plugin = nativePushPlugin();
  if (!plugin) return;
  const ids = [rememberedNativeDevice(), pendingNativeDelete()].filter(
    (id, index, all): id is string => !!id && all.indexOf(id) === index,
  );
  let unconfirmed: string | null = null;
  for (const id of ids) {
    try {
      await api.deletePushDevice(id);
    } catch (e) {
      // A 404 is the outcome being asked for, and 401/403 can never succeed on
      // a retry. Only a transient failure leaves the row addressable, so only
      // that one is kept for the retry below.
      if (!isFinalRemovalError(e) && !unconfirmed) unconfirmed = id;
    }
  }
  forgetNativeDevice();
  if (unconfirmed) rememberPendingNativeDelete(unconfirmed);
  else forgetPendingNativeDelete();
  try {
    await plugin.unregister();
  } catch {
    // See disableNativePush: the node row is the part that needs the retry.
  }
}
