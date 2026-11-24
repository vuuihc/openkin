/**
 * KIN-MOBILE-001 R2 — the RN transport adapter from ADR 0036 §2.
 *
 * Same job as `ui/src/api/client.ts`'s `apiFetch`, without the browser: the
 * origin comes from the stored session (not `window.location`), the token goes
 * in an `Authorization` header (never the query string), and failures come back
 * as reason codes instead of thrown browser errors. It adds no endpoint and
 * changes no payload shape.
 */

export type TransportReason = "expired" | "rejected" | "unreachable";

export type TransportResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number | null; reason: TransportReason };

export type ApiFetchOptions = {
  /** The stored device token; omitted means an unauthenticated read. */
  token?: string | null;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /** Tests inject their own; production uses the platform fetch. */
  fetchImpl?: typeof fetch;
};

/** `${origin}${path}` with exactly one slash at the seam. */
export function apiUrl(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The first list read: the same query the web client's `listTasks` builds. */
export function listTasksPath(limit = 20): string {
  return `/api/tasks?page=1&limit=${limit}`;
}

export async function apiFetch<T>(
  origin: string,
  path: string,
  options: ApiFetchOptions = {},
): Promise<TransportResult<T>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(apiUrl(origin, path), {
      method: options.method ?? "GET",
      headers,
      body: options.body,
    });
  } catch {
    // A rejected fetch (TypeError on RN) and an unreachable node look the same
    // without expo-network, which ADR 0036 does not pin.
    return { ok: false, status: null, reason: "unreachable" };
  }

  if (res.status === 401) {
    return { ok: false, status: 401, reason: "expired" };
  }
  if (res.status >= 500) {
    return { ok: false, status: res.status, reason: "unreachable" };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, reason: "rejected" };
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
