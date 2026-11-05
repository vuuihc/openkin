/**
 * The native shell's Hub URL and system-browser sign-in contract.
 *
 * The console is a web app that also runs inside the Capacitor shell, and the
 * shell owns two facts the page cannot reach on its own: which Hub origin the
 * webview is on (it persists the URL and points the webview at it), and the
 * ASWebAuthenticationSession that carries OAuth out to the system browser and
 * back (G8/G9). This module is the small contract between them, mirroring
 * `nativePush.ts`.
 *
 * Both directions matter for cookies. A session cookie only becomes
 * first-party when the page is loaded from the origin that set it, so the
 * shell navigating to the Hub URL *is* the sign-in path — and a cookie the
 * system browser receives can never reach this webview, which is why an app
 * sign-in ends in a one-time code on `kin://auth-callback` rather than in a
 * session.
 */

/** The Capacitor plugin implemented by the iOS app target. */
export type HubConfigPlugin = {
  getHubUrl(): Promise<{ url?: string }>;
  setHubUrl(input: { url: string; confirm?: boolean }): Promise<{ url: string; insecure?: boolean }>;
  clearHubUrl(): Promise<void>;
  openSystemBrowser(input: { url: string }): Promise<void>;
  takeAuthCallback(): Promise<{ url?: string }>;
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
export function hubConfigPlugin(scope: unknown = globalThis): HubConfigPlugin | null {
  const capacitor = capacitorOf(scope);
  if (!capacitor) return null;
  if (typeof capacitor.isNativePlatform === "function" && !capacitor.isNativePlatform()) {
    return null;
  }
  if (typeof capacitor.getPlatform === "function" && capacitor.getPlatform() !== "ios") {
    return null;
  }
  const plugin = capacitor.Plugins?.KinHubConfig;
  if (!plugin || typeof plugin !== "object") return null;
  const candidate = plugin as Partial<HubConfigPlugin>;
  if (
    typeof candidate.getHubUrl !== "function" ||
    typeof candidate.setHubUrl !== "function" ||
    typeof candidate.openSystemBrowser !== "function" ||
    typeof candidate.takeAuthCallback !== "function"
  ) {
    return null;
  }
  return candidate as HubConfigPlugin;
}

/** Whether this console runs inside the shell that owns the Hub URL. */
export function isHubShell(scope: unknown = globalThis): boolean {
  return hubConfigPlugin(scope) !== null;
}

/**
 * The stored Hub origin, or "" when the shell has none yet.
 *
 * A first-run app answers with an empty string; a browser answers with null.
 * The connect screen distinguishes the two: only a shell without a URL needs
 * the entry form.
 */
export async function currentHubUrl(plugin: HubConfigPlugin): Promise<string> {
  const answer = await plugin.getHubUrl();
  return typeof answer?.url === "string" ? answer.url : "";
}

/**
 * The pending `kin://auth-callback?…` URL, or "".
 *
 * The shell records the callback the moment iOS delivers it — including the
 * cold-start case where the app was launched *by* the callback — and clears it
 * on read, so each callback is consumed exactly once by whoever polls first.
 */
export async function takeAuthCallback(plugin: HubConfigPlugin): Promise<string> {
  const answer = await plugin.takeAuthCallback();
  return typeof answer?.url === "string" ? answer.url : "";
}

/**
 * What a callback URL carries.
 *
 * The shape is the server's choice (internal/api/auth.go): success carries only
 * a 64-hex code — the device key never travels back through the browser hop,
 * the app still holds the one it generated; failure carries the stable code the
 * console's error table translates, plus the device key so an app juggling
 * several pending flows can tell which one died. Anything else — a foreign
 * scheme, a mangled URL — reads as a failure the reader must show, never as a
 * silent success.
 */
export type AuthCallback =
  | { kind: "code"; code: string }
  | { kind: "error"; code: string; deviceKey: string };

export function parseAuthCallback(raw: string): AuthCallback | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "kin:" || url.host !== "auth-callback") return null;
  const errorCode = url.searchParams.get("error");
  if (errorCode) {
    return {
      kind: "error",
      code: errorCode.slice(0, 64),
      deviceKey: (url.searchParams.get("device_key") ?? "").slice(0, 128),
    };
  }
  const code = url.searchParams.get("code") ?? "";
  // The code is auth.NewToken's shape. A missing or malformed one is a flow
  // that died somewhere else; the exchange would refuse it anyway — checking
  // here just spares a round trip.
  if (!/^[0-9a-f]{64}$/.test(code)) return null;
  return { kind: "code", code };
}

/**
 * The random device key that binds a sign-in flow to this install.
 *
 * It is generated fresh for each flow and lives only in memory across the
 * browser hop: the app sends it on the start URL, the server records it in the
 * pending flow, the callback hands back only the code, and the exchange
 * presents the key from memory. A code without its key is worthless (T6),
 * which is the whole of the device binding.
 */
export function newDeviceKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
