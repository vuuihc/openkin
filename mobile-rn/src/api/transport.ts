/**
 * KIN-MOBILE-001 R2 — the RN transport adapter from ADR 0036 §2.
 *
 * Same job as `ui/src/api/client.ts`'s `apiFetch`, without the browser: the
 * origin comes from the stored session (not `window.location`), the token goes
 * in an `Authorization` header (never the query string), and failures come back
 * as reason codes instead of thrown browser errors. It adds no endpoint and
 * changes no payload shape.
 */

import type { Session } from "../auth/tokenStore";

export type TransportReason = "expired" | "rejected" | "unreachable";

export type TransportResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number | null;
      reason: TransportReason;
      /**
       * The refusal body when it parsed. The transport never interprets it;
       * a caller that knows the endpoint reads its stable `code`.
       */
      data?: unknown;
    };

export type ApiFetchOptions = {
  /**
   * The stored session. A node session sends its device token as a bearer; a
   * Hub session sends no header and asks `fetch` for the native cookie jar
   * (`credentials: "include"`), where `kin_session` lives.
   */
  session?: Session | null;
  /**
   * A one-shot bearer for a call made before a session exists (the pairing
   * exchange). Prefer `session` everywhere a session is already known.
   */
  token?: string | null;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /**
   * Explicit cookie policy. Hub sessions imply `"include"`; the sign-in calls
   * set it themselves because the cookie is what they are here to obtain.
   */
  credentials?: RequestCredentials;
  /** Tests inject their own; production uses the platform fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Bound on the whole request. A dead node must not leave the caller waiting
   * forever (AGENTS.md §13), so every call has one.
   */
  timeoutMs?: number;
  /** An outer cancellation, e.g. the screen that asked is gone. */
  signal?: AbortSignal;
};

/** Every request is bounded; a dead host maps to `unreachable`, not a hang. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** `${origin}${path}` with exactly one slash at the seam. */
export function apiUrl(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The first list read: the same query the web client's `listTasks` builds. */
export function listTasksPath(limit = 20): string {
  return `/api/tasks?page=1&limit=${limit}`;
}

/** The project records that name the list's headings, as the console reads them. */
export const listProjectsPath = "/api/projects";

/** Turn a daemon QR link's one-time secret into a device token. */
export const pairingExchangePath = "/api/pairing/exchange";

export async function apiFetch<T>(
  origin: string,
  path: string,
  options: ApiFetchOptions = {},
): Promise<TransportResult<T>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };
  // A session decides the credential: a node has a bearer token, a Hub has
  // only the cookie the native jar sends. The legacy `token` covers the pairing
  // exchange, which runs before any session can exist.
  if (options.session?.kind === "node") {
    headers.Authorization = `Bearer ${options.session.token}`;
  } else if (options.session == null && options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const credentials =
    options.credentials ??
    (options.session?.kind === "hub" ? "include" : undefined);

  const doFetch = options.fetchImpl ?? fetch;
  // One controller carries both bounds: the timeout and the caller's signal.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const outer = options.signal;
  const forwardAbort = (): void => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", forwardAbort);
  }

  let res: Response;
  try {
    res = await doFetch(apiUrl(origin, path), {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      signal: controller.signal,
      ...(credentials === undefined ? {} : { credentials }),
    });
  } catch {
    // A rejected fetch (TypeError on RN), a timeout, and an unreachable node
    // look the same without expo-network, which ADR 0036 does not pin.
    return { ok: false, status: null, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forwardAbort);
  }

  if (!res.ok) {
    const status = res.status;
    const reason: TransportReason =
      status === 401 ? "expired" : status >= 500 ? "unreachable" : "rejected";
    // A refusal carries the server's stable `code`; read the body while it is
    // still available. A body that does not parse leaves the code absent.
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    return data === undefined
      ? { ok: false, status, reason }
      : { ok: false, status, reason, data };
  }
  if (res.status === 204) {
    return { ok: true, status: 204, data: undefined as T };
  }
  try {
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch {
    // A 2xx whose body cannot be read is not a usable answer.
    return { ok: false, status: res.status, reason: "unreachable" };
  }
}
