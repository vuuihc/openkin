import { describe, expect, it } from "vitest";
import type { TaskEvent, WorkerStep } from "../../api/client";
import { WORKER_STATUS_UNPLANNED, workerActivity } from "./workerActivity";

type Payload = Record<string, unknown>;

function toolUse(seq: number, payload: Payload): TaskEvent {
  return { task_id: "t1", event_epoch: 0, seq, ts: seq, type: "tool_use", payload };
}

function toolResult(seq: number, payload: Payload): TaskEvent {
  return { task_id: "t1", event_epoch: 0, seq, ts: seq, type: "tool_result", payload };
}

function other(seq: number, type: string, payload: Payload): TaskEvent {
  return { task_id: "t1", event_epoch: 0, seq, ts: seq, type, payload };
}

function step(index: number, patch: Partial<WorkerStep> = {}): WorkerStep {
  return {
    task_id: "t1",
    execution_id: "exec-1",
    step_index: index,
    role: "research",
    agent: "claude",
    access: "read",
    status: "running",
    attempt: 1,
    created_at: 1,
    updated_at: 1,
    ...patch,
  };
}

/**
 * A worker tool call, stamped the way the engine stamps it — `stampWorker` puts
 * `agent`/`speaker`/`model` and the `execution_*` set on every worker event.
 */
function workerTool(seq: number, stepNumber: number, payload: Payload): TaskEvent {
  return toolUse(seq, {
    execution_id: "exec-1",
    execution_step: stepNumber,
    execution_agent: "claude",
    execution_model: "sonnet",
    ...payload,
  });
}

function workerResult(seq: number, stepNumber: number, payload: Payload): TaskEvent {
  return toolResult(seq, {
    execution_id: "exec-1",
    execution_step: stepNumber,
    execution_agent: "claude",
    execution_model: "sonnet",
    ...payload,
  });
}

describe("workerActivity", () => {
  // The whole join in one assertion: `execution_step` is 1-based
  // (`orchestrate.go:261` stamps `si + 1`) and `step_index` is 0-based
  // (`:542` writes `si`). Equality here is the bug that reads as an empty panel.
  it("lands step 1's calls on index 0, and step 2's on index 1", () => {
    const events = [
      workerTool(1, 1, { tool_use_id: "a", name: "read_file", input: { path: "x" } }),
      workerTool(2, 2, { tool_use_id: "b", name: "bash", input: { command: "ls" } }),
    ];
    const rows = workerActivity(events, [step(0), step(1)]);
    expect(rows.map((row) => row.total)).toEqual([1, 1]);
    expect(rows[0].activity[0].name).toBe("read_file");
    expect(rows[1].activity[0].name).toBe("bash");
  });

  // The host's own run carries an execution id (engine.go:2279) and no step.
  // Joining on the id alone would put the host's commands on a worker's row.
  it("keeps the host's own tool calls out", () => {
    const events = [
      toolUse(1, { execution_id: "turn-1", name: "bash", input: { command: "ls" } }),
      workerTool(2, 1, { tool_use_id: "a", name: "read_file" }),
    ];
    const rows = workerActivity(events, [step(0)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(1);
    expect(rows[0].activity[0].name).toBe("read_file");
  });

  it("reads a call and its result as one line that ended", () => {
    const events = [
      workerTool(1, 1, { tool_use_id: "a", name: "read_file", input: { path: "x" } }),
      workerResult(2, 1, { tool_use_id: "a", name: "read_file", output: "contents" }),
    ];
    const rows = workerActivity(events, [step(0)]);
    expect(rows[0].total).toBe(1);
    expect(rows[0].activity[0]).toMatchObject({
      name: "read_file",
      status: "done",
      summary: "read",
      output: "contents",
      seq: 1,
    });
    expect(rows[0].activity[0].input).toEqual({ path: "x" });
  });

  it("keeps a failed call failed and shows the adapter's own summary", () => {
    const events = [
      workerTool(1, 1, { tool_use_id: "a", name: "bash", summary: "npm test" }),
      workerResult(2, 1, { tool_use_id: "a", name: "bash", ok: false, output: "1 failed" }),
    ];
    const rows = workerActivity(events, [step(0)]);
    expect(rows[0].activity[0]).toMatchObject({ status: "error", summary: "npm test" });
  });

  // The console joins the stream at a seq (`?since_seq=`), so the first thing it
  // can see of a call is sometimes its result.
  it("makes a line out of a result with no call in front of it", () => {
    const events = [
      workerResult(7, 1, { tool_use_id: "a", name: "bash", ok: false, output: "boom" }),
    ];
    const rows = workerActivity(events, [step(0)]);
    expect(rows[0].activity[0]).toMatchObject({ name: "bash", status: "error", seq: 7 });
  });

  it("ignores everything that is not a tool call", () => {
    const events = [
      other(1, "message", { execution_id: "exec-1", execution_step: 1, text: "thinking" }),
      other(2, "usage", { execution_id: "exec-1", execution_step: 1, input_tokens: 5 }),
    ];
    const rows = workerActivity(events, [step(0)]);
    expect(rows[0].total).toBe(0);
    expect(rows[0].activity).toEqual([]);
  });

  // The plan poll lands 250ms after the page, and a failed poll leaves the list
  // empty for the rest of the run. A step with activity and no row is a worker
  // doing something; it must not vanish.
  it("shows a step the plan table has no row for", () => {
    const events = [workerTool(1, 3, { tool_use_id: "a", name: "bash", input: { command: "ls" } })];
    const rows = workerActivity(events, [step(0)]);
    expect(rows).toHaveLength(2);
    const orphan = rows[1];
    expect(orphan).toMatchObject({
      executionId: "exec-1",
      stepIndex: 2,
      agent: "claude",
      status: WORKER_STATUS_UNPLANNED,
      unplanned: true,
      total: 1,
    });
    // Nothing the plan table would have said: no role, no access, no attempt.
    expect(orphan.role).toBeUndefined();
    expect(orphan.access).toBeUndefined();
    expect(orphan.attempt).toBeUndefined();
  });

  it("calls an unplanned step failed when its last call failed", () => {
    const events = [workerResult(1, 2, { tool_use_id: "a", name: "bash", ok: false })];
    expect(workerActivity(events, [])[0].status).toBe("failed");
  });

  it("keeps two executions' same-numbered steps apart", () => {
    const events = [
      workerTool(1, 1, { tool_use_id: "a", name: "read_file" }),
      toolUse(2, { execution_id: "exec-2", execution_step: 1, tool_use_id: "b", name: "bash" }),
    ];
    const rows = workerActivity(events, [
      step(0),
      step(0, { execution_id: "exec-2", agent: "codex", access: "write", status: "succeeded" }),
    ]);
    expect(rows.map((row) => [row.executionId, row.activity[0]?.name])).toEqual([
      ["exec-1", "read_file"],
      ["exec-2", "bash"],
    ]);
  });

  it("shows the tail of a long run and says how long it was", () => {
    const events = Array.from({ length: 9 }, (_, i) =>
      workerTool(i + 1, 1, { tool_use_id: `t${i}`, name: `tool_${i}` }),
    );
    const rows = workerActivity(events, [step(0)], { maxLines: 3 });
    expect(rows[0].activity.map((line) => line.name)).toEqual(["tool_6", "tool_7", "tool_8"]);
    expect(rows[0].total).toBe(9);
  });

  it("keeps a repeated call id on the seq where it first opened", () => {
    const events = [
      workerTool(1, 1, { tool_use_id: "a", name: "bash", summary: "first" }),
      workerTool(5, 1, { tool_use_id: "a", name: "bash", summary: "again" }),
    ];
    const rows = workerActivity(events, [step(0)]);
    expect(rows[0].total).toBe(1);
    expect(rows[0].activity[0]).toMatchObject({ seq: 1, summary: "again" });
  });

  it("leaves the plan's own order alone and appends what it has no place for", () => {
    const steps = [step(1, { role: "second" }), step(0, { role: "first" })];
    const events = [workerTool(1, 4, { tool_use_id: "a", name: "bash" })];
    const rows = workerActivity(events, steps);
    expect(rows.map((row) => row.role ?? "orphan")).toEqual(["second", "first", "orphan"]);
  });

  it("carries the plan row's end state through", () => {
    const rows = workerActivity(
      [],
      [step(0, { status: "succeeded", result_summary: "3 findings", attempt: 2 })],
    );
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      resultSummary: "3 findings",
      attempt: 2,
      total: 0,
      unplanned: false,
    });
  });
});
