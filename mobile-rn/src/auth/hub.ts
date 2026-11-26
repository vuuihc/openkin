import { apiFetch, type TransportReason } from "../api/transport";
import {
  clearSession,
  isLoopbackHost,
  secureStoreBackend,
  writeSession,
  type SecureBackend,
} from "./tokenStore";

/**
 * R-rn-hub-signin — signing in to a Hub instead of pairing with one node.
 *
 * The Hub is the same `kin` binary in Hub mode: `/api/auth/*` is its account
 * surface, and a successful sign-in leaves a `kin_session` cookie in the
 * native cookie jar. Nothing about the cookie is stored here — the Keychain
 * only records which Hub this phone is signed in to, so every later read knows
 * its origin.
 *
 * This slice is password sign-in: one POST and one proof, and the session is
 * written only after `/api/auth/me` answers 200. Provider sign-in (the
 * system-browser `kin://auth-callback` flow) follows in its own slice; the
 * status read already lists those providers so the screen can say so.
 *
 * Pure about the platform: the network and the Keychain are injected. Reason
 * codes only; the pair screen maps them to the shared catalogue.
 */

export type HubProvider = {
  id: string;
  label: string;
  kind: "password" | "oidc" | string;
  startUrl?: string;
};

export type HubStatus = {
  origin: string;
  needsBootstrap: boolean;
  claimable: boolean;
  authenticated: boolean;
  providers: HubProvider[];
  email?: string;
};

/** A refusal the pair screen can name. Transport reasons keep their names. */
export type HubReason = TransportReason | "insecure" | "no-accounts";

export type HubProbe =
  | { ok: true; origin: string; status: HubStatus }
  | { ok: false; reason: HubReason; origin: string | null };

export type HubAttempt =
  | { ok: true; origin: string }
  | {
      ok: false;
      reason: HubReason;
      origin: string | null;
      /** The server's stable error code, e.g. `invalid_credentials`. */
      errorCode?: string;
    };

export type HubSignInOptions = {
  /** Tests inject an in-memory Keychain stand-in. */
  store?: SecureBackend;
  /** Tests inject a recording fetch. */
  fetchImpl?: typeof fetch;
  /** Bound for every request; the transport default applies when omitted. */
  timeoutMs?: number;
};

export type HubSignIn = {
  probe(rawUrl: string): Promise<HubProbe>;
  signInWithPassword(
    rawUrl: string,
    email: string,
    password: string,
  ): Promise<HubAttempt>;
  /** Best-effort logout, then the Keychain entry goes (expiry path). */
  signOut(origin: string): Promise<void>;
};

/**
 * A typed Hub address normalized to its origin, or null when it is not one.
 *
 * https is required off loopback: the session cookie is the credential, and a
 * plaintext origin would hand it to the network. A bare host gets https.
 */
export function normalizeHubOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) return null;
  if (parsed.hostname === "") return null;
  return parsed.origin;
}

/**
 * The Hub a `kin://connect?hub=…` link names, or null.
 *
 * `url=` is also accepted: the Capacitor shell's G8 link used that name, and
 * the two clients should open the same links. The link carries an address, not
 * a credential, so it only pre-fills the screen.
 */
export function parseHubConnectLink(raw: string): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "kin:" || parsed.host !== "connect") return null;
  const value = parsed.searchParams.get("hub") ?? parsed.searchParams.get("url");
  return value ? normalizeHubOrigin(value) : null;
}

type StatusBody = {
  needs_bootstrap?: boolean;
  claimable?: boolean;
  authenticated?: boolean;
  providers?: Array<{
    id?: unknown;
    label?: unknown;
    kind?: unknown;
    start_url?: unknown;
  }>;
  user?: { email?: unknown };
};

function toStatus(body: StatusBody, origin: string): HubStatus {
  const providers = Array.isArray(body.providers) ? body.providers : [];
  return {
    origin,
    needsBootstrap: body.needs_bootstrap === true,
    claimable: body.claimable === true,
    authenticated: body.authenticated === true,
    email: typeof body.user?.email === "string" ? body.user.email : undefined,
    providers: providers.flatMap((provider) => {
      if (typeof provider?.id !== "string" || typeof provider.label !== "string") {
        return [];
      }
      return [
        {
          id: provider.id,
          label: provider.label,
          kind: typeof provider.kind === "string" ? provider.kind : "oidc",
          startUrl:
            typeof provider.start_url === "string"
              ? provider.start_url
              : undefined,
        },
      ];
    }),
  };
}

const AUTH_HEADERS = { "Content-Type": "application/json" };

/** The server's stable refusal code, when the body carries one. */
function refusalCode(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

export function createHubSignIn(options: HubSignInOptions = {}): HubSignIn {
  async function backend(): Promise<SecureBackend> {
    return options.store ?? (await secureStoreBackend());
  }

  const signInFailure = (reason: TransportReason): HubReason =>
    reason === "expired" ? "rejected" : reason;

  async function probe(rawUrl: string): Promise<HubProbe> {
    const origin = normalizeHubOrigin(rawUrl);
    if (origin === null) return { ok: false, reason: "insecure", origin: null };

    const result = await apiFetch<StatusBody>(origin, "/api/auth/status", {
      credentials: "include",
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    if (!result.ok) {
      return { ok: false, reason: result.reason, origin };
    }
    return { ok: true, origin, status: toStatus(result.data, origin) };
  }

  async function signInWithPassword(
    rawUrl: string,
    email: string,
    password: string,
  ): Promise<HubAttempt> {
    const origin = normalizeHubOrigin(rawUrl);
    if (origin === null) return { ok: false, reason: "insecure", origin: null };

    const login = await apiFetch<unknown>(origin, "/api/auth/login", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ email, password }),
      credentials: "include",
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    if (!login.ok) {
      // `/api/auth/login` names its refusal (`invalid_credentials`, …) in the
      // body; the screen translates that code instead of guessing from 401.
      const errorCode = refusalCode(login.data);
      return {
        ok: false,
        reason: signInFailure(login.reason),
        origin,
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    }

    // The cookie is present after login, but "present" is not "accepted": only
    // `/api/auth/me` proves the session before anything reaches the Keychain.
    const me = await apiFetch<unknown>(origin, "/api/auth/me", {
      credentials: "include",
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    if (!me.ok) {
      return { ok: false, reason: signInFailure(me.reason), origin };
    }

    const store = await backend();
    await writeSession({ kind: "hub", origin }, store);
    return { ok: true, origin };
  }

  async function signOut(origin: string): Promise<void> {
    const target = normalizeHubOrigin(origin);
    if (target !== null) {
      // Best effort: the Keychain entry goes even when the Hub cannot be
      // reached, which is exactly when someone signs out.
      await apiFetch<unknown>(target, "/api/auth/logout", {
        method: "POST",
        credentials: "include",
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
    }
    const store = await backend();
    await clearSession(store);
  }

  return { probe, signInWithPassword, signOut };
}
