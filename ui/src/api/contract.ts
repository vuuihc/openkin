import type { components } from "./generated/openapi";

export type Task = components["schemas"]["Task"];
export type TaskEvent = components["schemas"]["TaskEvent"];
export type CreateTaskRequest = components["schemas"]["CreateTaskRequest"];
export type FollowUpRequest = components["schemas"]["FollowUpRequest"];
export type ApprovalDecisionRequest =
  components["schemas"]["ApprovalDecisionRequest"];
export type Approval = components["schemas"]["Approval"];
export type UserQuestionOption = components["schemas"]["UserQuestionOption"];
export type UserQuestionPayload = components["schemas"]["UserQuestionPayload"];
export type UserQuestionResponse = components["schemas"]["UserQuestionResponse"];
export type UserQuestion = components["schemas"]["UserQuestion"];
export type WSMessage = components["schemas"]["WSMessage"];

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: RecordValue, key: string): boolean {
  return typeof value[key] === "string";
}

function hasFiniteNumber(value: RecordValue, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function hasInteger(value: RecordValue, key: string): boolean {
  return hasFiniteNumber(value, key) && Number.isInteger(value[key]);
}

function optional(
  value: RecordValue,
  key: string,
  predicate: (candidate: unknown) => boolean,
  nullable = false,
): boolean {
  return (
    !(key in value) ||
    (nullable && value[key] === null) ||
    predicate(value[key])
  );
}

function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  return (
    hasString(value, "id") &&
    hasString(value, "title") &&
    hasString(value, "agent") &&
    hasString(value, "cwd") &&
    hasString(value, "prompt") &&
    hasString(value, "status") &&
    hasInteger(value, "tokens_in") &&
    hasInteger(value, "tokens_out") &&
    hasInteger(value, "created_at") &&
    hasInteger(value, "event_epoch") &&
    (value.event_epoch as number) >= 0 &&
    optional(value, "model", (v) => typeof v === "string", true) &&
    optional(value, "session_ref", (v) => typeof v === "string", true) &&
    optional(value, "permission_mode", (v) => typeof v === "string", true) &&
    optional(value, "exit_code", (v) => Number.isInteger(v), true) &&
    optional(
      value,
      "cost_usd",
      (v) => typeof v === "number" && Number.isFinite(v),
      true,
    ) &&
    optional(value, "started_at", (v) => Number.isInteger(v), true) &&
    optional(value, "finished_at", (v) => Number.isInteger(v), true) &&
    optional(value, "project_id", (v) => typeof v === "string", true) &&
    optional(value, "workspace_mode", (v) => typeof v === "string", true) &&
    optional(value, "workspace_source_root", (v) => typeof v === "string", true) &&
    optional(value, "workspace_root", (v) => typeof v === "string", true) &&
    optional(value, "execution_cwd", (v) => typeof v === "string", true) &&
    optional(value, "workspace_scope", (v) => typeof v === "string", true) &&
    optional(value, "workspace_base_oid", (v) => typeof v === "string", true) &&
    optional(value, "workspace_branch", (v) => typeof v === "string", true) &&
    optional(value, "workspace_policy", (v) => typeof v === "string", true) &&
    optional(value, "current_workspace_id", (v) => typeof v === "string", true) &&
    optional(value, "routine_id", (v) => typeof v === "string") &&
    optional(value, "routine_noteworthy", (v) => typeof v === "boolean") &&
    optional(value, "routine_tldr", (v) => typeof v === "string") &&
    optional(value, "routine_unread", (v) => typeof v === "boolean")
  );
}

function isTaskEvent(value: unknown): value is TaskEvent {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["task_id", "event_epoch", "seq", "ts", "type", "payload"]) &&
    hasString(value, "task_id") &&
    hasInteger(value, "event_epoch") &&
    (value.event_epoch as number) >= 0 &&
    hasInteger(value, "seq") &&
    (value.seq as number) > 0 &&
    hasInteger(value, "ts") &&
    hasString(value, "type") &&
    "payload" in value
  );
}

function isApproval(value: unknown): value is Approval {
  if (!isRecord(value)) return false;
  return (
    hasString(value, "id") &&
    hasString(value, "task_id") &&
    hasString(value, "kind") &&
    "payload" in value &&
    hasString(value, "decision") &&
    hasInteger(value, "created_at") &&
    optional(value, "decided_via", (v) => typeof v === "string", true) &&
    optional(value, "decided_at", (v) => Number.isInteger(v), true) &&
    optional(value, "execution_id", (v) => typeof v === "string", true) &&
    optional(value, "execution_agent", (v) => typeof v === "string", true) &&
    optional(value, "execution_step", (v) => Number.isInteger(v), true) &&
    optional(value, "execution_model", (v) => typeof v === "string", true) &&
    optional(value, "task_title", (v) => typeof v === "string") &&
    optional(value, "task_agent", (v) => typeof v === "string")
  );
}

function isUserQuestion(value: unknown): value is UserQuestion {
  if (!isRecord(value)) return false;
  const payload = value.payload;
  if (
    !isRecord(payload) ||
    !hasString(payload, "question") ||
    (payload.question as string).length === 0 ||
    !Array.isArray(payload.options) ||
    payload.options.length < 2 ||
    payload.options.length > 6 ||
    !payload.options.every(
      (option) =>
        isRecord(option) &&
        hasOnlyKeys(option, ["label", "description"]) &&
        hasString(option, "label") &&
        (option.label as string).length > 0 &&
        optional(option, "description", (v) => typeof v === "string"),
    ) ||
    !optional(payload, "header", (v) => typeof v === "string") ||
    !optional(payload, "multi_select", (v) => typeof v === "boolean")
  ) {
    return false;
  }
  const response = value.response;
  if (
    response !== undefined &&
    response !== null &&
    (!isRecord(response) ||
      !Array.isArray(response.selected) ||
      !response.selected.every((item) => typeof item === "string") ||
      !optional(response, "other_text", (v) => typeof v === "string"))
  ) {
    return false;
  }
  return (
    hasString(value, "id") &&
    hasString(value, "task_id") &&
    hasString(value, "status") &&
    hasInteger(value, "created_at") &&
    optional(value, "answered_via", (v) => typeof v === "string", true) &&
    optional(value, "answered_at", (v) => Number.isInteger(v), true) &&
    optional(value, "execution_id", (v) => typeof v === "string", true) &&
    optional(value, "execution_agent", (v) => typeof v === "string", true) &&
    optional(value, "execution_step", (v) => Number.isInteger(v), true) &&
    optional(value, "execution_model", (v) => typeof v === "string", true) &&
    optional(value, "task_title", (v) => typeof v === "string") &&
    optional(value, "task_agent", (v) => typeof v === "string")
  );
}

function decodeWSMessage(value: unknown): WSMessage | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "data"]) ||
    !hasString(value, "kind") ||
    !("data" in value)
  ) {
    return null;
  }
  switch (value.kind) {
    case "task_update":
      return isTask(value.data) ? { kind: value.kind, data: value.data } : null;
    case "task_deleted":
      return isRecord(value.data) &&
        hasOnlyKeys(value.data, ["id"]) &&
        hasString(value.data, "id")
        ? { kind: value.kind, data: { id: value.data.id as string } }
        : null;
    case "event":
      return isTaskEvent(value.data) ? { kind: value.kind, data: value.data } : null;
    case "approval_update":
      return isApproval(value.data) ? { kind: value.kind, data: value.data } : null;
    case "user_question_update":
      return isUserQuestion(value.data)
        ? { kind: value.kind, data: value.data }
        : null;
    default:
      return null;
  }
}

/** Parse and validate one untrusted WebSocket text frame. */
export function parseWSMessage(raw: unknown): WSMessage | null {
  if (typeof raw !== "string") return null;
  try {
    return decodeWSMessage(JSON.parse(raw));
  } catch {
    return null;
  }
}
