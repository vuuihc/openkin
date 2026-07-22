import { useAppStore } from "../store/appStore";

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

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
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
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function notifyUnauthorized(): void {
  // Funnel every API-layer 401 into the global connect screen.
  useAppStore.getState().requireToken("unauthorized");
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
    if (res.status === 401) {
      notifyUnauthorized();
    }
    const text = await res.text().catch(() => "");
    let body: unknown = undefined;
    let message = text || res.statusText;
    if (text) {
      try {
        body = JSON.parse(text);
        if (
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof (body as { error: unknown }).error === "string"
        ) {
          message = (body as { error: string }).error;
        }
      } catch {
        /* plain text */
      }
    }
    throw new ApiError(res.status, message, body);
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
  /** Session default for all agents: default | accept_edits | yolo */
  permission_mode?: string | null;
  status: string;
  exit_code?: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd?: number | null;
  created_at: number;
  started_at?: number | null;
  finished_at?: number | null;
  project_id?: string | null;
  /** Resolved isolation mode: shared | worktree */
  workspace_mode?: string | null;
  workspace_root?: string | null;
  execution_cwd?: string | null;
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
  /** Immutable adapter-run id when the approval came from a delegated worker. */
  execution_id?: string | null;
  execution_agent?: string | null;
  execution_step?: number | null;
  execution_model?: string | null;
  task_title?: string;
  task_agent?: string;
};

export type CreateTaskBody = {
  /** Optional — daemon picks default available agent when omitted. */
  agent?: string;
  cwd: string;
  prompt: string;
  model?: string;
  title?: string;
  /** Session permission mode applied to every agent (default | accept_edits | yolo). */
  permission_mode?: string;
  /** Optional project association (ADR 0008). */
  project_id?: string;
};

export type AgentModelOption = {
  id: string;
  label?: string;
  tier?: string;
};

export type AgentInfo = {
  id: string;
  name: string;
  kind?: string;
  capabilities?: string[];
  binary?: string;
  installed: boolean;
  available: boolean;
  default: boolean;
  reason?: string;
  /** Locally configured/discovered choices or stable CLI aliases. */
  models?: AgentModelOption[];
  model_list_source: "configured" | "discovered" | "recommended" | "none";
  model_list_status: "available" | "default_only" | "unavailable";
};

export function listAgents(): Promise<AgentInfo[]> {
  return apiFetch<AgentInfo[]>("/api/agents");
}

export type WSMessage =
  | { kind: "task_update"; data: Task }
  | { kind: "task_deleted"; data: { id: string } }
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

export type TaskWorkspaceEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
};

export type TaskWorkspaceListResponse = {
  root: string;
  path: string;
  entries: TaskWorkspaceEntry[];
  truncated?: boolean;
};

export type TaskWorkspaceFileResponse = {
  root: string;
  path: string;
  size: number;
  truncated: boolean;
  content: string;
};

export function listTaskWorkspace(
  taskId: string,
  path?: string,
): Promise<TaskWorkspaceListResponse> {
  const q = new URLSearchParams();
  if (path && path !== ".") q.set("path", path);
  const qs = q.toString();
  return apiFetch<TaskWorkspaceListResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/workspace/list${qs ? `?${qs}` : ""}`,
  );
}

export function readTaskWorkspaceFile(
  taskId: string,
  path: string,
): Promise<TaskWorkspaceFileResponse> {
  const q = new URLSearchParams({ path });
  return apiFetch<TaskWorkspaceFileResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/workspace/file?${q.toString()}`,
  );
}

/** Restore isolated task files to a checkpoint (event_seq 0 = initial). */
export function restoreTaskWorkspace(
  taskId: string,
  eventSeq = 0,
): Promise<Task> {
  return apiFetch<Task>(
    `/api/tasks/${encodeURIComponent(taskId)}/workspace/restore`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_seq: eventSeq }),
    },
  );
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

export function deleteTask(id: string): Promise<void> {
  return apiFetch<void>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function followUpPrompt(
  id: string,
  prompt: string,
  opts?: { agent?: string; model?: string },
): Promise<Task> {
  const body: { prompt: string; agent?: string; model?: string } = { prompt };
  if (opts?.agent) body.agent = opts.agent;
  // Include model when the caller opts in (empty string clears task model).
  if (opts && "model" in opts && opts.model !== undefined) {
    body.model = (opts.model || "").trim();
  }
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Rewind a terminal task to a user turn and re-run (same task id). */
export function retryTask(
  id: string,
  opts?: { from_seq?: number },
): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(opts?.from_seq != null ? { from_seq: opts.from_seq } : {}),
    }),
  });
}

/** Branch a new task from a transcript prefix (optionally continue with prompt). */
export function forkTask(
  id: string,
  opts?: { from_seq?: number; prompt?: string; agent?: string },
): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(opts?.from_seq != null ? { from_seq: opts.from_seq } : {}),
      ...(opts?.prompt ? { prompt: opts.prompt } : {}),
      ...(opts?.agent ? { agent: opts.agent } : {}),
    }),
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

export type Artifact = {
  id: string;
  title: string;
  kind: "markdown" | "html" | "text";
  size: number;
  status: "proposed" | "saved" | "archived";
  source_task_id?: string;
  source_task_title?: string;
  created_at: number;
  updated_at: number;
};

export function listArtifacts(status?: string): Promise<Artifact[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetch<Artifact[]>(`/api/artifacts${q}`);
}

export function getArtifact(id: string): Promise<Artifact> {
  return apiFetch<Artifact>(`/api/artifacts/${encodeURIComponent(id)}`);
}

/** Fetch artifact body as plain text (never JSON). */
export async function getArtifactContent(id: string): Promise<string> {
  const headers = new Headers({ Accept: "text/plain" });
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}/content`, {
    headers,
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  return res.text();
}

export function createArtifact(body: {
  title: string;
  kind: string;
  content: string;
  source_task_id?: string;
  status?: string;
}): Promise<Artifact> {
  return apiFetch<Artifact>("/api/artifacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function setArtifactStatus(
  id: string,
  status: string,
): Promise<Artifact> {
  return apiFetch<Artifact>(`/api/artifacts/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

/** Infer artifact kind from content (P0: trivial heuristic). */
export function detectArtifactKind(
  content: string,
): "markdown" | "html" | "text" {
  const head = content.slice(0, 512).toLowerCase();
  if (head.includes("<!doctype html") || head.includes("<html")) return "html";
  return "markdown";
}

/** Derive a short title from content or fall back. */
export function deriveArtifactTitle(content: string, fallback: string): string {
  const md = content.match(/^\s*#\s+(.+)$/m);
  if (md?.[1]) return md[1].trim().slice(0, 120);
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line) return line.replace(/^#+\s*/, "").slice(0, 120);
  return fallback || "Untitled";
}


export type ProjectMode = "ship" | "learn" | "explore" | "maintain";

export type Project = {
  id: string;
  name: string;
  mode: ProjectMode | string;
  status: string;
  soft_progress?: string;
  created_at: number;
  updated_at: number;
  last_active_at: number;
  roots?: string[];
  one_pager_path?: string;
};

export type OnePagerSummary = {
  name?: string;
  mode?: string;
  north_star?: string;
  focus?: string;
  next?: string[];
  empty?: boolean;
};

export type OnePager = {
  project_id: string;
  markdown: string;
  updated_at: number;
  one_pager_summary?: OnePagerSummary;
};

export type ProjectByRoot = Project & {
  project?: Project;
  one_pager_summary?: OnePagerSummary;
  one_pager_updated_at?: number;
};

export type RecycleEvidence = {
  kind: "task" | "artifact" | "file" | string;
  id?: string;
  label?: string;
  path?: string;
};

export type RecycleSuggestion = {
  target: "conclusions" | "open_questions" | "next" | "focus" | string;
  text: string;
  reason?: string;
  evidence?: RecycleEvidence[];
  confidence?: "low" | "medium" | "high" | string;
  status: "pending" | "accepted" | "accepted_edited" | "ignored" | string;
  final_text?: string;
  accepted_at?: number | null;
  ignored_at?: number | null;
};

export type ProjectRecycle = {
  id: string;
  project_id: string;
  task_id: string;
  base_one_pager_updated_at: number;
  summary: string;
  suggestions: RecycleSuggestion[];
  status: "pending" | "resolved" | string;
  created_at: number;
  resolved_at?: number | null;
};

export function listProjects(status: string = "active"): Promise<Project[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetch<Project[]>(`/api/projects${q}`);
}

export function getProject(id: string): Promise<Project> {
  return apiFetch<Project>(`/api/projects/${encodeURIComponent(id)}`);
}


export type PulseDay = { date: string; count: number };
export type ProjectPulse = {
  project_id: string;
  generated_at: number;
  window_days: number;
  session_total: number;
  session_window: number;
  sessions_running: number;
  sessions_waiting: number;
  last_session_at?: number;
  session_heat: PulseDay[];
  git_available: boolean;
  git_root?: string;
  commit_window: number;
  commit_heat?: PulseDay[];
  top_paths?: { path: string; count: number }[];
  auto_markdown: string;
};

export function getProjectPulse(
  id: string,
  windowDays = 90,
): Promise<ProjectPulse> {
  return apiFetch<ProjectPulse>(
    `/api/projects/${encodeURIComponent(id)}/pulse?window_days=${windowDays}`,
  );
}


export function summarizeProject(
  id: string,
  body: { apply?: boolean; window_days?: number } = {},
): Promise<{
  proposal: string;
  markdown: string;
  pulse: ProjectPulse;
  applied: boolean;
  updated_at: number;
}> {
  return apiFetch(`/api/projects/${encodeURIComponent(id)}/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function refreshProjectPulse(
  id: string,
  body: { window_days?: number; write?: boolean } = {},
): Promise<{
  pulse: ProjectPulse;
  markdown: string;
  updated_at: number;
  written: boolean;
}> {
  return apiFetch(`/api/projects/${encodeURIComponent(id)}/pulse/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function ensureProject(body: {
  path: string;
  name?: string;
  mode?: ProjectMode | string;
}): Promise<Project> {
  return apiFetch<Project>("/api/projects/ensure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function createProject(body: {
  name?: string;
  mode?: ProjectMode | string;
  roots?: string[];
}): Promise<Project> {
  return apiFetch<Project>("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function patchProject(
  id: string,
  body: {
    name?: string;
    mode?: ProjectMode | string;
    status?: string;
    soft_progress?: string;
    roots?: string[];
  },
): Promise<Project> {
  return apiFetch<Project>(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getOnePager(id: string): Promise<OnePager> {
  return apiFetch<OnePager>(
    `/api/projects/${encodeURIComponent(id)}/one-pager`,
  );
}

export function putOnePager(
  id: string,
  markdown: string,
  updatedAt?: number,
): Promise<OnePager> {
  return apiFetch<OnePager>(
    `/api/projects/${encodeURIComponent(id)}/one-pager`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        markdown,
        updated_at: updatedAt,
      }),
    },
  );
}

export function listProjectTasks(id: string, limit = 50): Promise<Task[]> {
  return apiFetch<Task[]>(
    `/api/projects/${encodeURIComponent(id)}/tasks?limit=${limit}`,
  );
}

export function listProjectArtifacts(
  id: string,
  limit = 30,
): Promise<Artifact[]> {
  return apiFetch<Artifact[]>(
    `/api/projects/${encodeURIComponent(id)}/artifacts?limit=${limit}`,
  );
}

export function findProjectByRoot(path: string): Promise<ProjectByRoot> {
  return apiFetch<ProjectByRoot>(
    `/api/projects/by-root?path=${encodeURIComponent(path)}`,
  );
}

export function createTaskRecycle(taskId: string): Promise<ProjectRecycle> {
  return apiFetch<ProjectRecycle>(
    `/api/tasks/${encodeURIComponent(taskId)}/recycle`,
    { method: "POST" },
  );
}

export function getTaskRecycle(taskId: string): Promise<ProjectRecycle> {
  return apiFetch<ProjectRecycle>(
    `/api/tasks/${encodeURIComponent(taskId)}/recycle`,
  );
}

export function listProjectRecycles(
  projectId: string,
  opts?: { status?: string; limit?: number },
): Promise<ProjectRecycle[]> {
  const q = new URLSearchParams();
  if (opts?.status) q.set("status", opts.status);
  if (opts?.limit) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return apiFetch<ProjectRecycle[]>(
    `/api/projects/${encodeURIComponent(projectId)}/recycles${qs ? `?${qs}` : ""}`,
  );
}

export function acceptRecycleSuggestion(
  recycleId: string,
  index: number,
  body: { final_text?: string; one_pager_updated_at?: number },
): Promise<{
  recycle: ProjectRecycle;
  markdown?: string;
  updated_at?: number;
  idempotent?: boolean;
}> {
  return apiFetch(
    `/api/recycles/${encodeURIComponent(recycleId)}/suggestions/${index}/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export function ignoreRecycleSuggestion(
  recycleId: string,
  index: number,
): Promise<{ recycle: ProjectRecycle; idempotent?: boolean }> {
  return apiFetch(
    `/api/recycles/${encodeURIComponent(recycleId)}/suggestions/${index}/ignore`,
    { method: "POST" },
  );
}

export function continueProject(
  id: string,
  body: {
    prompt?: string;
    agent?: string;
    model?: string;
    title?: string;
    permission_mode?: string;
    workspace_mode?: string;
    cwd?: string;
  } = {},
): Promise<Task> {
  return apiFetch<Task>(
    `/api/projects/${encodeURIComponent(id)}/continue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
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

export type GitBranch = {
  name: string;
  current: boolean;
};

export type GitBranchStatus = {
  cwd: string;
  is_git: boolean;
  current?: string;
  detached?: boolean;
  dirty?: boolean;
  branches: GitBranch[];
  reason?: string;
};

export function listGitBranches(cwd: string): Promise<GitBranchStatus> {
  const q = new URLSearchParams({ cwd });
  return apiFetch<GitBranchStatus>(`/api/git/branches?${q.toString()}`);
}

export function checkoutGitBranch(
  cwd: string,
  branch: string,
): Promise<{ cwd: string; current: string }> {
  return apiFetch<{ cwd: string; current: string }>("/api/git/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, branch }),
  });
}

/** Max single attachment size (must match server maxUploadBytes). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MiB

export type Upload = {
  /** Stored filename (used in the URL). */
  id: string;
  /** Original client filename. */
  name: string;
  mime: string;
  size: number;
  /** GET path to preview/download the file. */
  url: string;
  /** Absolute on-disk path — agents read files by path. */
  path: string;
};

/** Attach Bearer token as ?token= so <img src> / <a href> can load private uploads. */
export function authenticatedURL(path: string): string {
  if (!path) return path;
  if (/^https?:\/\//i.test(path) || path.startsWith("blob:") || path.startsWith("data:")) {
    return path;
  }
  const token = getToken();
  if (!token) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}token=${encodeURIComponent(token)}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function isImageMime(mime: string | undefined | null): boolean {
  return !!mime && mime.startsWith("image/");
}

/** POST /api/uploads — upload a single attachment (multipart). */
export async function uploadFile(file: File): Promise<Upload> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      `File too large (max ${MAX_UPLOAD_BYTES >> 20} MiB)`,
    );
  }
  const form = new FormData();
  form.append("file", file);
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch("/api/uploads", { method: "POST", body: form, headers });
  if (!res.ok) {
    if (res.status === 401) useAppStore.getState().requireToken("unauthorized");
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  return (await res.json()) as Upload;
}

/** @deprecated use uploadFile */
export const uploadImage = uploadFile;

export type Settings = {
  "notify.bark_url": string;
  "notify.ntfy_topic": string;
  "ui.base_url": string;
  price_table: string;
  agent_limits: string;
  "provider.kind": string;
  "provider.base_url": string;
  "provider.api_key": string;
  "provider.model": string;
  "provider.stream"?: string;
  "provider.active_id": string;
  "agent.default": string;
  network_mode: string;
  connect_url: string;
  token: string;
};

export type SettingsUpdate = Partial<
  Pick<
    Settings,
    | "notify.bark_url"
    | "notify.ntfy_topic"
    | "ui.base_url"
    | "price_table"
    | "agent_limits"
    | "provider.kind"
    | "provider.base_url"
    | "provider.api_key"
    | "provider.model"
    | "agent.default"
  >
> & {
  "provider.clear_api_key"?: string;
};

/** Per-agent daily limit status from GET /api/usage/limits. */
export type AgentLimitStatus = {
  agent: string;
  limit_spend_usd?: number | null;
  used_spend_usd: number;
  limit_tokens?: number | null;
  used_tokens: number;
  status: "ok" | "warn" | "over";
  period_start: string;
};

export function getUsageLimits(): Promise<AgentLimitStatus[]> {
  return apiFetch<AgentLimitStatus[]>("/api/usage/limits");
}

export type UsageWindow = {
  kind: "5h" | "weekly";
  used_percent: number;
  status: "ok" | "warn" | "over";
  reset_at: number;
};

export type UsageWindowProvider = {
  provider: string;
  plan?: string;
  windows: UsageWindow[];
  error?: string;
  updated_at: number;
};

/** GET /api/usage/windows — provider subscription 5h/weekly rate-limit windows. */
export function getUsageWindows(): Promise<UsageWindowProvider[]> {
  return apiFetch<UsageWindowProvider[]>("/api/usage/windows");
}

export function getSettings(): Promise<Settings> {
  return apiFetch<Settings>("/api/settings");
}

export function updateSettings(body: SettingsUpdate): Promise<Settings> {
  return apiFetch<Settings>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** One registered cognition provider (API key masked on read). */
export type ProviderEntry = {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  api_key?: string;
  model: string;
  stream?: boolean;
  active: boolean;
};

export type ProvidersResponse = {
  active_id: string;
  providers: ProviderEntry[];
};

export type ProviderWrite = {
  id?: string;
  name?: string;
  kind?: string;
  base_url: string;
  api_key?: string;
  model: string;
  stream?: boolean;
  active?: boolean;
  clear_api_key?: boolean;
};

export function listProviders(): Promise<ProvidersResponse> {
  return apiFetch<ProvidersResponse>("/api/providers");
}

export function createProvider(body: ProviderWrite): Promise<ProvidersResponse> {
  return apiFetch<ProvidersResponse>("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateProvider(
  id: string,
  body: ProviderWrite,
): Promise<ProvidersResponse> {
  return apiFetch<ProvidersResponse>(`/api/providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteProvider(id: string): Promise<ProvidersResponse> {
  return apiFetch<ProvidersResponse>(`/api/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function activateProvider(id: string): Promise<ProvidersResponse> {
  return apiFetch<ProvidersResponse>(
    `/api/providers/${encodeURIComponent(id)}/activate`,
    { method: "POST" },
  );
}

export type NotifyChannelResult = {
  channel: string;
  ok: boolean;
  status?: string;
  error?: string;
};

export type NotifyTestResponse = {
  ok: boolean;
  results: NotifyChannelResult[];
};

/** POST /api/notify/test — send a test push via all configured channels. */
export function testNotify(): Promise<NotifyTestResponse> {
  return apiFetch<NotifyTestResponse>("/api/notify/test", {
    method: "POST",
  });
}

export type UsageRow = {
  date: string;
  agent: string;
  tasks: number;
} & UsageTotals;

export type UsageTotals = {
  tokens_in: number;
  tokens_out: number;
  cost_usd?: number | null;
  request_count: number;
  reasoning_output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_eligible_input_tokens: number;
  cache_hit_rate?: number | null;
  cache_coverage?: number | null;
  cache_status: "reported" | "unknown" | "unsupported" | "mixed";
};

export type UsageModelSubtotal = {
  model: string;
} & UsageTotals;

export type UsageCostSourceSubtotal = {
  cost_source: string;
} & UsageTotals;

export type TaskUsage = {
  task_id: string;
  model_subtotals: UsageModelSubtotal[];
  cost_source_subtotals: UsageCostSourceSubtotal[];
} & UsageTotals;

export function getTaskUsage(id: string): Promise<TaskUsage> {
  return apiFetch<TaskUsage>(`/api/tasks/${encodeURIComponent(id)}/usage`);
}

export function getUsageSummary(days = 30): Promise<UsageRow[]> {
  return apiFetch<UsageRow[]>(`/api/usage/summary?days=${days}`);
}

export type ConnectWSOptions = {
  onMessage: (msg: WSMessage) => void;
  /** Fired after a successful (re)open — pages re-fetch lists / since_seq. */
  onOpen?: () => void;
  onStatus?: (status: "connecting" | "connected" | "disconnected") => void;
};

/**
 * Open the global WS bus. Uses ?token= (browser WS cannot set Authorization easily).
 * Automatic retry with exponential backoff (capped). Surfaces connection status.
 */
export function connectWS(
  onMessageOrOpts: ((msg: WSMessage) => void) | ConnectWSOptions,
): () => void {
  const opts: ConnectWSOptions =
    typeof onMessageOrOpts === "function"
      ? { onMessage: onMessageOrOpts }
      : onMessageOrOpts;

  const token = getToken();
  if (!token) {
    opts.onStatus?.("disconnected");
    return () => undefined;
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let everOpened = false;

  const setStatus = (s: "connecting" | "connected" | "disconnected") => {
    opts.onStatus?.(s);
    useAppStore.getState().setWSStatus(s);
  };

  const connect = () => {
    if (closed) return;
    setStatus("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      setStatus("connected");
      if (everOpened) {
        // Reconnect: bump gen so list pages self-heal without manual refresh.
        useAppStore.getState().noteReconnect();
      }
      everOpened = true;
      opts.onOpen?.();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WSMessage;
        opts.onMessage(msg);
      } catch {
        // ignore malformed
      }
    };
    ws.onclose = () => {
      if (closed) return;
      setStatus("disconnected");
      // Exponential backoff: 1s, 2s, 4s … cap 15s (high-latency Funnel).
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4));
      attempt += 1;
      retry = setTimeout(connect, delay);
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

export type TerminalProfile = {
  id: string;
  name: string;
  executable: string;
  default: boolean;
};

export type TerminalSession = {
  id: string;
  profile_id: string;
  name: string;
  cwd: string;
  status: "running" | "exited" | "closing";
  exit_code?: number | null;
  created_at: number;
};

export type CreateTerminalSessionBody = {
  profile_id: string;
  cwd: string;
  cols: number;
  rows: number;
};

export function listTerminalProfiles(): Promise<{
  profiles: TerminalProfile[];
  default_profile_id: string;
}> {
  return apiFetch<{
    profiles: TerminalProfile[];
    default_profile_id: string;
  }>("/api/terminal/profiles");
}

export function listTerminalSessions(): Promise<TerminalSession[]> {
  return apiFetch<TerminalSession[]>("/api/terminal/sessions");
}

export function createTerminalSession(body: CreateTerminalSessionBody): Promise<TerminalSession> {
  return apiFetch<TerminalSession>("/api/terminal/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteTerminalSession(id: string): Promise<void> {
  return apiFetch<void>(`/api/terminal/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
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

/** Build a temporary optimistic task row for New Task UX. */
export function optimisticTask(partial: {
  id: string;
  agent?: string;
  cwd: string;
  prompt: string;
  title?: string;
}): Task {
  const now = Date.now();
  const title =
    partial.title ||
    (partial.prompt.length > 80 ? partial.prompt.slice(0, 80) : partial.prompt) ||
    "New task";
  return {
    id: partial.id,
    title,
    agent: partial.agent || "auto",
    cwd: partial.cwd,
    prompt: partial.prompt,
    status: "queued",
    tokens_in: 0,
    tokens_out: 0,
    created_at: now,
  };
}
