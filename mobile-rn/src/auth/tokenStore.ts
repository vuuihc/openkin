/**
 * KIN-MOBILE-001 R2 — the phone's session store.
 *
 * One entry in the platform Keychain (`expo-secure-store`), never AsyncStorage
 * and never the URL: the node origin and its device token travel together as
 * JSON under `SESSION_KEY`. ADR 0036 §2 names expo-secure-store as the RN
 * replacement for the web client's localStorage token seam.
 */

/** The one Keychain entry. Changing this name logs every installed phone out. */
export const SESSION_KEY = "kin.session";

/**
 * What is stored: either a node this phone is paired with (origin + device
 * token), or a Hub this phone signed in to. A Hub session carries no secret:
 * its credential is the `kin_session` cookie in the platform cookie jar, which
 * `fetch` sends when the caller asks for `credentials: "include"`.
 */
export type NodeSession = { kind: "node"; origin: string; token: string };
/**
 * `insecure: true` is the device-local confirmation that this plaintext
 * origin was accepted after the pair screen named the credential (ADR 0037
 * §2). It is written by the sign-in that showed the warning and nowhere else.
 */
export type HubSession = { kind: "hub"; origin: string; insecure?: true };
export type Session = NodeSession | HubSession;

/** The three calls the auth core needs; tests inject an in-memory stand-in. */
export type SecureBackend = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

/**
 * The real backend. Loaded lazily so the auth core can be exercised with an
 * injected backend without a native module present, and so Metro keeps the
 * import inside this one module.
 */
let cached: SecureBackend | null = null;

export async function secureStoreBackend(): Promise<SecureBackend> {
  if (cached) return cached;
  const SecureStore = await import("expo-secure-store");
  cached = {
    getItemAsync: (key) => SecureStore.getItemAsync(key),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
  };
  return cached;
}

/** A stored node origin must be a plain http(s) origin. */
export function isNodeOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.origin === value.replace(/\/+$/, "")
  );
}

/** A loopback host may use http; every other Hub must be https. */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

/**
 * A Hub origin: https, or http only on loopback. A Hub cookie is a credential,
 * so a plaintext origin off this machine is refused before any request.
 */
export function isHubOrigin(value: unknown): value is string {
  if (!isNodeOrigin(value)) return false;
  const parsed = new URL(value);
  return parsed.protocol === "https:" || isLoopbackHost(parsed.hostname);
}

/** A plaintext Hub origin off this machine: the cookie travels unencrypted. */
function isPlaintextHubOrigin(value: unknown): value is string {
  if (!isNodeOrigin(value)) return false;
  const parsed = new URL(value);
  return parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname);
}

function tokenOf(record: Record<string, unknown>): string | null {
  return typeof record.token === "string" && record.token.trim() !== ""
    ? record.token
    : null;
}

/**
 * The stored shape, normalized. An entry written before the union has no
 * `kind`; it reads as a node session, which is what it was.
 */
export function isSession(value: unknown): value is Session {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "hub") {
    if (isHubOrigin(record.origin)) return true;
    // The one stored-record allowance: a plaintext origin is accepted only
    // when the record itself carries the confirmation. Without the flag an
    // old or hand-edited record still reads as no session (fail closed).
    return record.insecure === true && isPlaintextHubOrigin(record.origin);
  }
  if (record.kind !== undefined && record.kind !== "node") return false;
  return isNodeOrigin(record.origin) && tokenOf(record) !== null;
}

function normalizeSession(value: unknown): Session | null {
  if (!isSession(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "hub") {
    const origin = record.origin as string;
    // Carry the confirmation through, so the list header's marker survives a
    // relaunch. It is authority only for the plaintext origin it was given
    // for: an https record never acquires it, even if one is hand-edited in.
    return record.insecure === true && isPlaintextHubOrigin(origin)
      ? { kind: "hub", origin, insecure: true }
      : { kind: "hub", origin };
  }
  const token = tokenOf(record);
  return token === null
    ? null
    : { kind: "node", origin: record.origin as string, token };
}

/** Read the stored session, or null when there is none or it is malformed. */
export async function readSession(
  backend: SecureBackend,
): Promise<Session | null> {
  const raw = await backend.getItemAsync(SESSION_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeSession(parsed);
}

export async function writeSession(
  session: Session,
  backend: SecureBackend,
): Promise<void> {
  await backend.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

export async function clearSession(backend: SecureBackend): Promise<void> {
  await backend.deleteItemAsync(SESSION_KEY);
}
