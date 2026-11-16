/**
 * Where a tapped notification lands.
 *
 * A notification carries a URL written by the node. Treat it as untrusted: keep
 * only a path this console knows, and fall back to the inbox for anything else.
 * Opening an arbitrary URL — or honouring `javascript:` — from a message is not
 * a navigation, it is running someone else's code. The host is therefore
 * discarded rather than compared: the node may write its Hub URL while this
 * console is open on a LAN or localhost origin, and the path is the only part
 * that names a route here.
 *
 * The shell can hand the same tap over twice — a cold-start link and the event
 * that accompanies it. Whether that should move the reader is decided where the
 * router lives (`NotificationTaps`), because only there is the current route
 * known: the same link is a replay while its target is on screen, and a real
 * tap again after the reader leaves.
 */

export type NotificationRoute = {
  /** A same-origin console path, always known. */
  path: string;
  /** The inbox item named by `?focus=`, when there is one. */
  focus: string | null;
  /** True when the original link was rejected and the inbox was substituted. */
  fallback: boolean;
};

const FALLBACK_PATH = "/inbox";

const TASK_PATH = /^\/tasks\/[A-Za-z0-9_-]+$/;
// A routine run on a paired Node is opened through the machine that owns it, so
// a routine report links to /machines/<device>/tasks/<id>. The device segment
// is the Hub's own device id (URL-escaped), which is one path segment.
const MACHINE_TASK_PATH = /^\/machines\/[^/]+\/tasks\/[A-Za-z0-9_-]+$/;

function knownPath(path: string): boolean {
  return (
    path === "/" ||
    path === "/inbox" ||
    path === "/routines" ||
    path === "/settings" ||
    TASK_PATH.test(path) ||
    MACHINE_TASK_PATH.test(path)
  );
}

/**
 * Parse a notification link into a console route.
 *
 * `origin` is the console's own origin; a relative path is resolved against it.
 */
export function parseNotificationRoute(
  href: string,
  origin: string = typeof window === "undefined" ? "http://localhost" : window.location.origin,
): NotificationRoute {
  if (!href.trim()) {
    return { path: FALLBACK_PATH, focus: null, fallback: true };
  }
  let url: URL;
  let base: URL;
  try {
    base = new URL(origin);
    url = new URL(href, base);
  } catch {
    return { path: FALLBACK_PATH, focus: null, fallback: true };
  }
  // `javascript:` and `file:` parse fine as URLs; only http(s) is a console
  // link. The origin itself is not checked: a node writes links from its own
  // `ui.base_url`, which is the Hub URL even when this console was opened on a
  // LAN or localhost origin. Only the path below is ever navigated to, so an
  // absolute link from any host lands on a route this console already knows,
  // and nothing else is opened.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { path: FALLBACK_PATH, focus: null, fallback: true };
  }
  if (!knownPath(url.pathname)) {
    return { path: FALLBACK_PATH, focus: null, fallback: true };
  }
  const focus = url.pathname === "/inbox" ? url.searchParams.get("focus") : null;
  let query = "";
  if (focus) {
    query = `?focus=${encodeURIComponent(focus)}`;
  } else if (url.pathname === "/routines") {
    // A disabled-routine alert names which machine owns the routine, so the
    // Routines page opens on it. Any other query is dropped, exactly as an
    // unrecognized query on any other route is.
    const device = url.searchParams.get("device");
    if (device) query = `?device=${encodeURIComponent(device)}`;
  }
  return { path: url.pathname + query, focus, fallback: false };
}

let pending: string | null = null;

/** Hold a link until the console is ready to navigate. */
export function queueNotificationRoute(href: string): void {
  pending = href;
}

/** Take the held link, if any. The second call returns null. */
export function consumeNotificationRoute(origin?: string): NotificationRoute | null {
  if (pending === null) return null;
  const href = pending;
  pending = null;
  return parseNotificationRoute(href, origin);
}

/** Drop a held link without consuming it into a navigation. */
export function clearNotificationRoute(): void {
  pending = null;
}

export const NOTIFICATION_EVENT = "kin:notification";

/**
 * What the iPhone shell exposes for a tap that arrived before the console
 * mounted. Structural rather than importing the push plugin type, so routing
 * stays testable with a plain object and a browser needs no plugin at all.
 */
export type NotificationTapSource = {
  takePendingURL?: () => Promise<{ url?: unknown } | null | undefined>;
};

/**
 * Drain a tap the native shell held during launch. The shell clears the value
 * as it is read, so this is the one chance to land on it; a shell that has no
 * such method (the desktop, an old build, a browser) simply returns null.
 */
export async function consumeNativeNotificationRoute(
  source: NotificationTapSource | null,
  origin?: string,
): Promise<NotificationRoute | null> {
  if (!source?.takePendingURL) return null;
  try {
    const held = await source.takePendingURL();
    const url = held && typeof held.url === "string" ? held.url : "";
    if (!url.trim()) return null;
    return parseNotificationRoute(url, origin);
  } catch {
    return null;
  }
}

/**
 * Listen for taps forwarded by the native shell. The shell dispatches a
 * CustomEvent carrying `detail.url`; a cold-start link is read from the global
 * the shell sets before the console loads.
 *
 * This does not dedupe: whether a tap should move the reader depends on where
 * they are now, and only the component that owns the router knows that. The
 * same URL is a fresh invitation after the reader leaves the target; treating
 * it as a replay forever makes a later quota-resumed tap dead.
 *
 * Returns an unsubscribe function.
 */
export function installNotificationRouting(
  onRoute: (route: NotificationRoute) => void,
  scope: {
    addEventListener?: (type: string, listener: (event: Event) => void) => void;
    removeEventListener?: (type: string, listener: (event: Event) => void) => void;
    __kinPendingNotification?: string;
  } = typeof window === "undefined" ? {} : window,
): () => void {
  const deliver = (href: string) => {
    onRoute(parseNotificationRoute(href));
  };

  if (typeof scope.__kinPendingNotification === "string") {
    const pendingHref = scope.__kinPendingNotification;
    delete scope.__kinPendingNotification;
    deliver(pendingHref);
  }
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ url?: unknown }>).detail;
    if (detail && typeof detail.url === "string") deliver(detail.url);
  };
  scope.addEventListener?.(NOTIFICATION_EVENT, listener);
  return () => scope.removeEventListener?.(NOTIFICATION_EVENT, listener);
}

export const NOTIFICATION_RECEIVED_EVENT = "kin:notification-received";

/**
 * A notification that arrived while the app was in front. The iPhone shell
 * suppresses the system banner in that case and dispatches this event instead,
 * so the console can say the same thing inside the page the reader is already
 * looking at.
 */
export type ForegroundNotification = {
  title: string;
  body: string;
  kind: string;
  id: string;
  url: string | null;
};

const MAX_NOTIFICATION_TITLE = 200;
const MAX_NOTIFICATION_BODY = 600;

/** Parse the shell's foreground payload without trusting its shape. */
export function parseForegroundNotification(detail: unknown): ForegroundNotification | null {
  if (!detail || typeof detail !== "object") return null;
  const raw = detail as Record<string, unknown>;
  const title =
    typeof raw.title === "string" ? raw.title.slice(0, MAX_NOTIFICATION_TITLE).trim() : "";
  const body = typeof raw.body === "string" ? raw.body.slice(0, MAX_NOTIFICATION_BODY) : "";
  if (!title && !body) return null;
  return {
    title,
    body,
    kind: typeof raw.kind === "string" ? raw.kind.slice(0, 40) : "",
    id: typeof raw.id === "string" ? raw.id.slice(0, 120) : "",
    url: typeof raw.url === "string" && raw.url ? raw.url : null,
  };
}

/**
 * Listen for foreground notifications. Returns an unsubscribe function.
 *
 * This is display only: it never navigates. When the app is in front, a
 * notification is an announcement, not a tap, and moving the reader away from
 * what they were doing would be the wrong response to "this finished".
 */
export function installForegroundNotifications(
  onNotify: (notification: ForegroundNotification) => void,
  scope: {
    addEventListener?: (type: string, listener: (event: Event) => void) => void;
    removeEventListener?: (type: string, listener: (event: Event) => void) => void;
  } = typeof window === "undefined" ? {} : window,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    const parsed = parseForegroundNotification(detail);
    if (parsed) onNotify(parsed);
  };
  scope.addEventListener?.(NOTIFICATION_RECEIVED_EVENT, listener);
  return () => scope.removeEventListener?.(NOTIFICATION_RECEIVED_EVENT, listener);
}
