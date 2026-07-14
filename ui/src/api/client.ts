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
  model?: string | null;
  session_ref?: string | null;
  status: string;
  exit_code?: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd?: number | null;
  created_at: number;
  started_at?: number | null;
  finished_at?: number | null;
};

export type TaskEvent = {
  task_id: string;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
};

export type Approval = {
  id: string;
  task_id: string;
  kind: string;
  payload: unknown;
  decision: string;
  decided_via?: string | null;
  created_at: number;
  decided_at?: number | null;
  task_title?: string;
  task_agent?: string;
};

export type CreateTaskBody = {
  agent: string;
  cwd: string;
  prompt: string;
  model?: string;
  title?: string;
};

export type WSMessage =
  | { kind: "task_update"; data: Task }
  | { kind: "event"; data: TaskEvent }
  | { kind: "approval_update"; data: Approval };

export function listTasks(params?: {
  status?: string;
  limit?: number;
  before?: string;
}): Promise<Task[]> {
  const q = new URLSearchParams();
  if (params?.status) q.set("status", params.status);
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.before) q.set("before", params.before);
  const qs = q.toString();
  return apiFetch<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
}

export function getTask(id: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}`);
}

export function createTask(body: CreateTaskBody): Promise<Task> {
  return apiFetch<Task>("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function cancelTask(id: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
}

export function followUpPrompt(id: string, prompt: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

export function listEvents(id: string, sinceSeq = 0): Promise<TaskEvent[]> {
  const q = sinceSeq > 0 ? `?since_seq=${sinceSeq}` : "";
  return apiFetch<TaskEvent[]>(`/api/tasks/${encodeURIComponent(id)}/events${q}`);
}

export function listApprovals(status?: string): Promise<Approval[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetch<Approval[]>(`/api/approvals${q}`);
}

export function decideApproval(
  id: string,
  decision: "approved" | "denied",
): Promise<Approval> {
  return apiFetch<Approval>(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
}

export function recentCwds(): Promise<string[]> {
  return apiFetch<string[]>("/api/recent-cwds");
}

export type Settings = {
  "notify.bark_url": string;
  "notify.ntfy_topic": string;
  "ui.base_url": string;
  price_table: string;
  network_mode: string;
  connect_url: string;
  token: string;
};

export function getSettings(): Promise<Settings> {
  return apiFetch<Settings>("/api/settings");
}

export function updateSettings(
  body: Partial<
    Pick<
      Settings,
      "notify.bark_url" | "notify.ntfy_topic" | "ui.base_url" | "price_table"
    >
  >,
): Promise<Settings> {
  return apiFetch<Settings>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type UsageRow = {
  date: string;
  agent: string;
  tasks: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd?: number | null;
};

export function getUsageSummary(days = 30): Promise<UsageRow[]> {
  return apiFetch<UsageRow[]>(`/api/usage/summary?days=${days}`);
}

/** Open the global WS bus. Uses ?token= (browser WS cannot set Authorization easily). */
export function connectWS(onMessage: (msg: WSMessage) => void): () => void {
  const token = getToken();
  if (!token) return () => undefined;

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WSMessage;
        onMessage(msg);
      } catch {
        // ignore malformed
      }
    };
    ws.onclose = () => {
      if (closed) return;
      retry = setTimeout(connect, 1500);
    };
    ws.onerror = () => {
      ws?.close();
    };
  };
  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

export function formatCost(cost?: number | null): string {
  if (cost == null) return "—";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

export function formatElapsed(task: Task, now = Date.now()): string {
  const start = task.started_at ?? task.created_at;
  const end = task.finished_at ?? now;
  const ms = Math.max(0, end - start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

/** Extract tool name + input from an approval payload (Claude permission shape). */
export function parseApprovalPayload(payload: unknown): {
  toolName: string;
  input: Record<string, unknown>;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const toolName = String(
    p.tool_name ?? p.toolName ?? p.name ?? p.tool ?? "tool",
  );
  let input: Record<string, unknown> = {};
  if (p.input && typeof p.input === "object" && !Array.isArray(p.input)) {
    input = p.input as Record<string, unknown>;
  } else {
    // Whole payload is the input (minus known meta keys).
    const { tool_name: _a, toolName: _b, name: _c, tool: _d, tool_use_id: _e, ...rest } = p;
    input = rest;
  }
  return { toolName, input };
}
