import { DAEMON_BASE } from "./config";

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

export type Task = {
  id: string;
  title: string;
  agent: string;
  status: string;
};

export type WSMessage =
  | { kind: "task_update"; data: Task }
  | { kind: "event"; data: { task_id: string; type: string; payload: unknown } }
  | { kind: "approval_update"; data: Approval };

export function parseToolSummary(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const toolName = String(
    p.tool_name ?? p.toolName ?? p.name ?? p.tool ?? "tool",
  );
  let input: Record<string, unknown> = {};
  if (p.input && typeof p.input === "object" && !Array.isArray(p.input)) {
    input = p.input as Record<string, unknown>;
  } else {
    const {
      tool_name: _a,
      toolName: _b,
      name: _c,
      tool: _d,
      tool_use_id: _e,
      ...rest
    } = p;
    input = rest;
  }
  const highlightKeys = ["command", "file_path", "path", "file", "content"];
  for (const k of highlightKeys) {
    if (input[k] != null && input[k] !== "") {
      const v = String(input[k]);
      const short = v.length > 80 ? v.slice(0, 80) + "…" : v;
      return `${toolName}: ${k}=${short}`;
    }
  }
  return toolName;
}

async function authFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  return fetch(`${DAEMON_BASE}${path}`, { ...init, headers });
}

export async function listPendingApprovals(token: string): Promise<Approval[]> {
  const res = await authFetch("/api/approvals?status=pending", token);
  if (!res.ok) throw new Error(`list approvals: ${res.status}`);
  return (await res.json()) as Approval[];
}

export async function decideApproval(
  token: string,
  id: string,
  decision: "approved" | "denied",
): Promise<Approval> {
  const res = await authFetch(`/api/approvals/${encodeURIComponent(id)}/decision`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`decide: ${res.status} ${text}`);
  }
  return (await res.json()) as Approval;
}
