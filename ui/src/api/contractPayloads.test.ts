import { describe, expect, expectTypeOf, it } from "vitest";
import type { components } from "./generated/openapi";

/**
 * The generated types are the published client contract. These assertions pin
 * the parts a client cannot guess — the closed enums and the documented
 * TaskEvent payload vocabulary — so a spec edit that drops one fails here as
 * well as in review.
 *
 * `Record<Union, true>` is exhaustive: it fails to compile when the generated
 * union gains a member. The `IsWidened` guards fail when a union collapses to
 * plain `string`, which `Record` alone would accept.
 */

type Task = components["schemas"]["Task"];
type TaskEvent = components["schemas"]["TaskEvent"];
type TaskEventPayload = components["schemas"]["TaskEventPayload"];
type Approval = components["schemas"]["Approval"];
type CreateTaskRequest = components["schemas"]["CreateTaskRequest"];

type IsWidened<T> = string extends T ? true : false;
type IsUnknown<T> = unknown extends T ? true : false;

/**
 * Every non-opaque payload field the spec declares.
 *
 * The opaque fields (`input`, `error`, `result`, `raw`) are listed here too so
 * the union stays exhaustive, but they are excluded from the presence check
 * below: the spec types them as unconstrained, so indexed access cannot tell
 * them apart from a dropped field.
 */
type DocumentedPayloadKeys =
  | "agent"
  | "speaker"
  | "source"
  | "phase"
  | "model"
  | "role"
  | "visibility"
  | "execution_id"
  | "run_execution_id"
  | "execution_agent"
  | "execution_step"
  | "execution_model"
  | "provider_id"
  | "provider"
  | "team"
  | "fallback_from"
  | "workspace_id"
  | "workspace_access"
  | "workspace_generation"
  | "content"
  | "text"
  | "partial"
  | "message_id"
  | "index"
  | "sidechain"
  | "interrupted"
  | "tool_use_id"
  | "id"
  | "name"
  | "tool_name"
  | "input"
  | "summary"
  | "output"
  | "status"
  | "ok"
  | "parent_tool_use_id"
  | "item"
  | "approval_id"
  | "kind"
  | "payload"
  | "question_id"
  | "response"
  | "answered_via"
  | "decision"
  | "decided_via"
  | "decided_at"
  | "is_error"
  | "session_ref"
  | "usage"
  | "tokens_in"
  | "tokens_out"
  | "cost_usd"
  | "total_cost_usd"
  | "message"
  | "error"
  | "result"
  | "raw"
  | "title"
  | "severity"
  | "entries"
  | "event_seq"
  | "reason"
  | "from_seq"
  | "to_seq"
  | "base_tree"
  | "head_tree"
  | "total"
  | "files"
  | "forked_from"
  | "fork_from_seq"
  | "line"
  | "from_agent"
  | "to_agent"
  | "reset_at"
  | "window"
  | "replaces_seq";

/**
 * `additionalProperties: true` gives the generated payload an index signature,
 * so `keyof TaskEventPayload` is `string | number` and cannot prove a field
 * exists: a dropped field silently resolves to `unknown` through it. Indexed
 * access by a literal key can tell the difference, so presence is pinned that
 * way. Any field that resolves to `unknown` survives as its own name in the
 * union, and the guard below then fails to compile.
 */
type OpaquePayloadKeys = "input" | "error" | "result" | "raw";
type PresenceCheckedPayloadKeys = Exclude<DocumentedPayloadKeys, OpaquePayloadKeys>;
type MissingPayloadKeys = {
  [K in PresenceCheckedPayloadKeys]: IsUnknown<TaskEventPayload[K]> extends true ? K : never;
}[PresenceCheckedPayloadKeys];
type AllPayloadKeysDeclared = [MissingPayloadKeys] extends [never] ? true : false;

describe("published enums", () => {
  it("keeps every task status and treats the set as closed", () => {
    const coverage: Record<Task["status"], true> = {
      queued: true,
      running: true,
      waiting_approval: true,
      waiting_input: true,
      succeeded: true,
      failed: true,
      canceled: true,
      retrying: true,
    };
    const isClosed: IsWidened<Task["status"]> = false;

    expect(Object.keys(coverage).sort()).toEqual(
      [
        "canceled",
        "failed",
        "queued",
        "retrying",
        "running",
        "succeeded",
        "waiting_approval",
        "waiting_input",
      ].sort(),
    );
    expect(isClosed).toBe(false);
  });

  it("keeps the permission and workspace modes closed", () => {
    const permission: Record<NonNullable<Task["permission_mode"]>, true> = {
      default: true,
      accept_edits: true,
      yolo: true,
    };
    const workspace: Record<NonNullable<Task["workspace_mode"]>, true> = {
      shared: true,
      worktree: true,
    };
    const requested: Record<NonNullable<CreateTaskRequest["workspace_mode"]>, true> = {
      auto: true,
      shared: true,
      worktree: true,
    };
    const permissionIsClosed: IsWidened<NonNullable<Task["permission_mode"]>> = false;
    const workspaceIsClosed: IsWidened<NonNullable<Task["workspace_mode"]>> = false;

    expect(Object.keys(permission)).toHaveLength(3);
    expect(Object.keys(workspace)).toEqual(["shared", "worktree"]);
    expect(Object.keys(requested)).toEqual(["auto", "shared", "worktree"]);
    expect(permissionIsClosed).toBe(false);
    expect(workspaceIsClosed).toBe(false);
  });

  it("keeps the approval decision set closed", () => {
    const coverage: Record<Approval["decision"], true> = {
      pending: true,
      approved: true,
      denied: true,
      expired: true,
    };
    const isClosed: IsWidened<Approval["decision"]> = false;

    expect(Object.keys(coverage)).toHaveLength(4);
    expect(isClosed).toBe(false);
  });
});

describe("TaskEvent payload contract", () => {
  it("keeps the payload an object, not an empty schema", () => {
    const payloadIsDeclared: IsUnknown<TaskEvent["payload"]> = false;
    const contentIsDeclared: IsUnknown<TaskEventPayload["content"]> = false;

    expect(payloadIsDeclared).toBe(false);
    expect(contentIsDeclared).toBe(false);
  });

  it("documents every payload field the schema declares", () => {
    // Exhaustive over DocumentedPayloadKeys: a missing or extra member is a
    // compile error, so this list and the union cannot drift apart.
    const documented: Record<DocumentedPayloadKeys, true> = {
      agent: true,
      speaker: true,
      source: true,
      phase: true,
      model: true,
      role: true,
      visibility: true,
      execution_id: true,
      run_execution_id: true,
      execution_agent: true,
      execution_step: true,
      execution_model: true,
      provider_id: true,
      provider: true,
      team: true,
      fallback_from: true,
      workspace_id: true,
      workspace_access: true,
      workspace_generation: true,
      content: true,
      text: true,
      partial: true,
      message_id: true,
      index: true,
      sidechain: true,
      interrupted: true,
      tool_use_id: true,
      id: true,
      name: true,
      tool_name: true,
      input: true,
      summary: true,
      output: true,
      status: true,
      ok: true,
      parent_tool_use_id: true,
      item: true,
      approval_id: true,
      kind: true,
      payload: true,
      question_id: true,
      response: true,
      answered_via: true,
      decision: true,
      decided_via: true,
      decided_at: true,
      is_error: true,
      session_ref: true,
      usage: true,
      tokens_in: true,
      tokens_out: true,
      cost_usd: true,
      total_cost_usd: true,
      message: true,
      error: true,
      result: true,
      raw: true,
      title: true,
      severity: true,
      entries: true,
      event_seq: true,
      reason: true,
      from_seq: true,
      to_seq: true,
      base_tree: true,
      head_tree: true,
      total: true,
      files: true,
      forked_from: true,
      fork_from_seq: true,
      line: true,
      from_agent: true,
      to_agent: true,
      reset_at: true,
      window: true,
      replaces_seq: true,
    };
    const allDeclared: AllPayloadKeysDeclared = true;

    expect(Object.keys(documented)).toHaveLength(76);
    expect(allDeclared).toBe(true);
  });

  it("keeps the message delta, checkpoint, and route shapes", () => {
    expectTypeOf<TaskEventPayload["content"]>().not.toBeUnknown();
    expectTypeOf<TaskEventPayload["partial"]>().toEqualTypeOf<boolean | undefined>();
    // `reason` is shared with route events, which write free text.
    expectTypeOf<TaskEventPayload["reason"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TaskEventPayload["workspace_access"]>().toEqualTypeOf<
      "pending_isolation" | "source_read_only" | "writable" | "shared" | undefined
    >();
  });
});
