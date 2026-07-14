const TOKEN_KEY = "kin_token";

/** Read token from localStorage (set via ?token= capture). */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Spec §6: accept ?token= for QR links, move to localStorage, strip from URL.
 */
export function captureTokenFromURL(): void {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (!token) return;
  setToken(token);
  params.delete("token");
  const qs = params.toString();
  const next = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState({}, "", next);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export type Task = {
  id: string;
  title: string;
  agent: string;
  cwd: string;
  prompt: string;
  status: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd?: number | null;
  created_at: number;
};

export function listTasks(): Promise<Task[]> {
  return apiFetch<Task[]>("/api/tasks");
}
