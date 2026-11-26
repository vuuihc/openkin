import type { Task } from "@ui/api/contract";
import { apiFetch, listTasksPath, pairingExchangePath } from "../api/transport";
import { parsePairingLink, redactToken } from "./pairingLink";
import {
  clearSession,
  readSession,
  secureStoreBackend,
  writeSession,
  type SecureBackend,
  type Session,
} from "./tokenStore";

/**
 * KIN-MOBILE-001 R2 — pairing and the first list read.
 *
 * The headless half of the signed R2 row. It returns stable reason codes
 * (`none` / `expired` / `rejected` / `unreachable`) and never a sentence: R2b
 * maps them to the shared i18n catalogue. The token is written to the Keychain
 * only after the node has accepted it, and a 401 retires it for good until the
 * owner pairs again.
 */

export type PairingReason = "none" | "expired" | "rejected" | "unreachable";

export type AppRoute = "pairing" | "list";

export type AppState = {
  route: AppRoute;
  reason: PairingReason;
  /** The node this phone is paired with, for display and retry. */
  origin: string | null;
  /** The first list read's tasks; empty until a read succeeds. */
  tasks: Task[];
  /** Origin-only text of the typed link, kept so a retry needs no retyping. */
  display: string | null;
};

export type PairingOptions = {
  /** Tests inject an in-memory Keychain stand-in. */
  store?: SecureBackend;
  /** Tests inject a recording fetch. */
  fetchImpl?: typeof fetch;
};

export type Pairing = {
  pairWithLink(raw: string): Promise<AppState>;
  resume(): Promise<AppState>;
  /** The boot decision: where the next frame starts. */
  startRoute(): Promise<AppState>;
  /**
   * A successful Hub sign-in is a fresh credential; a node token retired
   * before it must not bounce the next boot back to `/pair?reason=expired`.
   */
  clearRetired(): void;
};

export function createPairing(options: PairingOptions = {}): Pairing {
  // A rejected token is dead until the owner pairs again: resume never retries
  // it on its own, even if a stale entry survives a crash.
  let retired = false;
  let lastDisplay: string | null = null;
  let lastOrigin: string | null = null;
  let tasks: Task[] = [];
  // Every call takes a generation before its first await. A call that lands
  // after a newer one started must not touch shared state or the Keychain:
  // a late 401 from an older pairing may not retire a newer valid session
  // (AGENTS.md §11).
  let flowId = 0;
  let current: AppState = {
    route: "pairing",
    reason: "none",
    origin: null,
    tasks: [],
    display: null,
  };

  async function backend(): Promise<SecureBackend> {
    return options.store ?? (await secureStoreBackend());
  }

  function state(
    route: AppRoute,
    reason: PairingReason,
    origin: string | null,
    read: Task[],
  ): AppState {
    current = { route, reason, origin, tasks: read, display: lastDisplay };
    return current;
  }

  /** One `POST /api/pairing/exchange`: the device token, or why there is none. */
  async function exchangeOnce(
    origin: string,
    secret: string,
    recovery: boolean,
  ): Promise<{ token: string | null; reason: PairingReason }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (recovery) headers["X-Kin-Pairing-Recovery"] = "1";
    const result = await apiFetch<unknown>(origin, pairingExchangePath, {
      method: "POST",
      headers,
      body: JSON.stringify({ secret }),
      fetchImpl: options.fetchImpl,
    });
    if (!result.ok) return { token: null, reason: result.reason };
    const body = result.data;
    const token =
      body !== null &&
      typeof body === "object" &&
      "token" in body &&
      typeof (body as { token: unknown }).token === "string" &&
      (body as { token: string }).token !== ""
        ? (body as { token: string }).token
        : null;
    // A 2xx without a usable token is a refusal, not a pairing.
    return { token, reason: "rejected" };
  }

  /**
   * A daemon QR link's token is a one-time secret, not a device token. Exchange
   * it once; retry once with the recovery header, because the node may have
   * committed the device and lost its response (the same fallback the web
   * client uses in `ui/src/api/client.ts`).
   */
  async function exchangeSecret(
    origin: string,
    secret: string,
  ): Promise<{ token: string } | { reason: PairingReason }> {
    const first = await exchangeOnce(origin, secret, false);
    if (first.token !== null) return { token: first.token };
    const recovered = await exchangeOnce(origin, secret, true);
    if (recovered.token !== null) return { token: recovered.token };
    return { reason: first.reason };
  }

  async function readList(
    session: Session,
    myFlow: number,
  ): Promise<AppState> {
    const result = await apiFetch<Task[]>(session.origin, listTasksPath(), {
      session,
      fetchImpl: options.fetchImpl,
    });
    if (myFlow !== flowId) return current;

    lastOrigin = session.origin;
    if (result.ok) {
      tasks = result.data;
      return state("list", "none", session.origin, result.data);
    }
    if (result.reason === "expired") {
      const store = await backend();
      if (myFlow !== flowId) return current;
      retired = true;
      tasks = [];
      await clearSession(store);
      if (myFlow !== flowId) return current;
      return state("pairing", "expired", session.origin, []);
    }
    if (result.reason === "unreachable") {
      // The token is still good; the node is not answering. Keep the cached
      // rows so the list surface can stay readable while disconnected.
      return state("list", "unreachable", session.origin, tasks);
    }
    return state("list", "rejected", session.origin, tasks);
  }

  async function pairWithLink(raw: string): Promise<AppState> {
    const myFlow = ++flowId;
    lastDisplay = redactToken(raw);
    const parsed = parsePairingLink(raw);
    if (!parsed.ok || parsed.link.origin === null) {
      lastOrigin = null;
      tasks = [];
      return state("pairing", "rejected", null, []);
    }

    const { origin, pairing: oneTime, display } = parsed.link;
    lastDisplay = display;
    lastOrigin = origin;
    retired = false;

    // A QR link carries a one-time secret; only the exchange yields the device
    // token the API accepts. A plain `?token=` link already carries one.
    let token = parsed.link.token;
    if (oneTime) {
      const exchanged = await exchangeSecret(origin, token);
      if (myFlow !== flowId) return current;
      if (!("token" in exchanged)) {
        tasks = [];
        return state("pairing", exchanged.reason, origin, []);
      }
      token = exchanged.token;
    }

    const result = await apiFetch<Task[]>(origin, listTasksPath(), {
      token,
      fetchImpl: options.fetchImpl,
    });
    if (myFlow !== flowId) return current;

    if (result.ok) {
      const store = await backend();
      if (myFlow !== flowId) return current;
      await writeSession({ kind: "node", origin, token }, store);
      if (myFlow !== flowId) return current;
      tasks = result.data;
      return state("list", "none", origin, result.data);
    }
    if (result.reason === "expired") {
      const store = await backend();
      if (myFlow !== flowId) return current;
      retired = true;
      tasks = [];
      await clearSession(store);
      if (myFlow !== flowId) return current;
      return state("pairing", "expired", origin, []);
    }
    // An unproven token is never persisted: the owner keeps the typed link and
    // can retry, and the app stays on the pairing entry.
    tasks = [];
    return state("pairing", result.reason, origin, []);
  }

  async function resume(): Promise<AppState> {
    const myFlow = ++flowId;
    const store = await backend();
    if (myFlow !== flowId) return current;
    if (retired) {
      await clearSession(store);
      if (myFlow !== flowId) return current;
      return state("pairing", "expired", lastOrigin, []);
    }
    const session = await readSession(store);
    if (myFlow !== flowId) return current;
    if (session === null) {
      return state("pairing", "none", lastOrigin, []);
    }
    return readList(session, myFlow);
  }

  /**
   * Forget a retired node token. A Hub sign-in writes a different session, and
   * the next `startRoute` must read it instead of replaying the old expiry.
   */
  function clearRetired(): void {
    retired = false;
  }

  return { pairWithLink, resume, startRoute: resume, clearRetired };
}

/** The app-wide instance. R2b's pairing screen and list route use this. */
export const pairing = createPairing();
