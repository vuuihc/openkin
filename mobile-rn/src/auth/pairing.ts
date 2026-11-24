import type { Task } from "@ui/api/contract";
import { apiFetch, listTasksPath } from "../api/transport";
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
};

export function createPairing(options: PairingOptions = {}): Pairing {
  // A rejected token is dead until the owner pairs again: resume never retries
  // it on its own, even if a stale entry survives a crash.
  let retired = false;
  let lastDisplay: string | null = null;
  let lastOrigin: string | null = null;
  let tasks: Task[] = [];

  async function backend(): Promise<SecureBackend> {
    return options.store ?? (await secureStoreBackend());
  }

  function state(
    route: AppRoute,
    reason: PairingReason,
    origin: string | null,
    read: Task[],
  ): AppState {
    return { route, reason, origin, tasks: read, display: lastDisplay };
  }

  async function readList(session: Session): Promise<AppState> {
    lastOrigin = session.origin;
    const result = await apiFetch<Task[]>(session.origin, listTasksPath(), {
      token: session.token,
      fetchImpl: options.fetchImpl,
    });

    if (result.ok) {
      tasks = result.data;
      return state("list", "none", session.origin, result.data);
    }
    if (result.reason === "expired") {
      retired = true;
      tasks = [];
      await clearSession(await backend());
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
    lastDisplay = redactToken(raw);
    const parsed = parsePairingLink(raw);
    if (!parsed.ok || parsed.link.origin === null) {
      lastOrigin = null;
      tasks = [];
      return state("pairing", "rejected", null, []);
    }

    const { origin, token, display } = parsed.link;
    lastDisplay = display;
    lastOrigin = origin;
    retired = false;

    const result = await apiFetch<Task[]>(origin, listTasksPath(), {
      token,
      fetchImpl: options.fetchImpl,
    });

    if (result.ok) {
      await writeSession({ origin, token }, await backend());
      tasks = result.data;
      return state("list", "none", origin, result.data);
    }
    if (result.reason === "expired") {
      retired = true;
      tasks = [];
      await clearSession(await backend());
      return state("pairing", "expired", origin, []);
    }
    // An unproven token is never persisted: the owner keeps the typed link and
    // can retry, and the app stays on the pairing entry.
    tasks = [];
    return state("pairing", result.reason, origin, []);
  }

  async function resume(): Promise<AppState> {
    const store = await backend();
    if (retired) {
      await clearSession(store);
      return state("pairing", "expired", lastOrigin, []);
    }
    const session = await readSession(store);
    if (session === null) {
      return state("pairing", "none", lastOrigin, []);
    }
    return readList(session);
  }

  return { pairWithLink, resume, startRoute: resume };
}

/** The app-wide instance. R2b's pairing screen and list route use this. */
export const pairing = createPairing();
