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

/** What is stored: the node this phone is paired with, and its token. */
export type Session = { origin: string; token: string };

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

export function isSession(value: unknown): value is Session {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isNodeOrigin(record.origin) &&
    typeof record.token === "string" &&
    record.token.trim() !== ""
  );
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
  return isSession(parsed) ? parsed : null;
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
