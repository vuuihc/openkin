/**
 * What each worker is doing, joined onto what it was asked to do.
 *
 * Two facts, two sources, and this is where they meet. The plan table says what
 * each worker was *asked* — its role, whether it may write, what it depends on,
 * and how it ended. The event stream says what it then *did*: the tool calls and
 * their results. Both are already on the client (the plan from the poll, the
 * calls from the same SSE stream the chat is built from), so the panel subscribes
 * to nothing new.
 *
 * The join is `execution_step` → `step_index`, and the two are not the same
 * number. The engine stamps `execution_step` as `si + 1` (`orchestrate.go:261`,
 * the number a human reads) and writes `step_index` as `si` (`orchestrate.go:542`,
 * an index into `plan.Steps`). The offset is a named constant below rather than a
 * bare `- 1` in the comparison: a lone `- 1` next to another `- 1` is how this
 * turns into a silently empty panel the next time somebody edits it.
 *
 * An event with an `execution_id` but no `execution_step` is the *host* run —
 * `engine.go:2279` builds the host's ref with no step — so requiring a step is
 * also what keeps the host's own tool calls out of the panel. Reading worker
 * activity out of the chat projection instead would mean flipping worker tools
 * to `visibility.user`, which would put a worker's commands in the host's column
 * as if the host had run them.
 */
import type { TaskEvent, WorkerStep } from "../../api/client";
import { prettyToolName, type ToolStep } from "../chat/transcriptProjection";
import { readExecution } from "../chat/eventMeta";

/** How many tool calls a row shows before it says how many more there were. */
export const WORKER_ACTIVITY_MAX_LINES = 4;

/**
 * `execution_step` minus `step_index` for the same step: the event field is
 * 1-based, the plan column is 0-based. See the file comment for the two sites.
 */
export const WORKER_STEP_OFFSET = 1;

/** A plan row with the tool calls that belong to it. */
export type WorkerRow = {
  executionId: string;
  stepIndex: number;
  /** From the plan row when there is one, otherwise from the events. */
  agent: string;
  model?: string;
  /** Absent on a row the plan table does not have — see `unplanned`. */
  role?: string;
  access?: string;
  /** The plan row's status, or one read off the events when unplanned. */
  status: string;
  attempt?: number;
  resultSummary?: string;
  error?: string;
  /** Oldest first. Capped — see `total`. */
  activity: ToolStep[];
  /** Every tool call seen for this step, so a capped list can say so. */
  total: number;
  /**
   * True when the events named a step the plan table has no row for.
   *
   * Real, and not only a race: the panel's first poll lands 250ms after the page
   * does, and a failing poll leaves the list empty for the rest of the run. A
   * step with activity and no row is still a worker that is doing something, and
   * dropping it would leave the panel blank during exactly the runs a reader
   * opens it for.
   */
  unplanned: boolean;
};

/** The status of an unplanned row, which no row has told us the end of yet. */
export const WORKER_STATUS_UNPLANNED = "unplanned";

type Group = {
  executionId: string;
  stepIndex: number;
  activity: ToolStep[];
  byKey: Map<string, ToolStep>;
  /** Who the events say is running this step, for a row the plan has no name in. */
  agent: string;
  model?: string;
};

function groupKey(executionId: string, stepIndex: number): string {
  return `${executionId}\u0000${stepIndex}`;
}

/**
 * The tool call an event opens or settles. The id the adapters use, with the
 * seq as the last resort — the same three-step fallback the chat projection
 * uses, so a call has one identity in both faces.
 */
function callKey(p: Record<string, unknown>, seq: number): string {
  return String(p.tool_use_id ?? p.id ?? `seq-${seq}`);
}

/** The one-line description of a call: the adapter's own summary when it sent one. */
function callSummary(p: Record<string, unknown>, name: string): string {
  const summary = typeof p.summary === "string" ? p.summary.trim() : "";
  return summary || prettyToolName(name);
}

function toolName(p: Record<string, unknown>): string {
  const content = p.content as Record<string, unknown> | undefined;
  return String(
    content?.name ??
      p.name ??
      p.tool_name ??
      (p.item as { type?: string } | undefined)?.type ??
      "tool",
  );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Every worker step the events and the plan table together describe.
 *
 * Planned rows keep the order the API returned them in: within one execution
 * that is step order, and a re-planned task lists its newest execution first,
 * which is the order the table has always been read in. Unplanned groups are
 * appended, because they have no row to take a position from.
 */
export function workerActivity(
  events: TaskEvent[],
  steps: WorkerStep[],
  options: { maxLines?: number } = {},
): WorkerRow[] {
  const maxLines = options.maxLines ?? WORKER_ACTIVITY_MAX_LINES;
  const groups = new Map<string, Group>();

  for (const event of events) {
    if (event.type !== "tool_use" && event.type !== "tool_result") continue;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const exec = readExecution(p);
    // No step means no worker: the host's own run carries an execution id too.
    if (!exec?.id || exec.step === undefined) continue;
    const stepIndex = exec.step - WORKER_STEP_OFFSET;
    if (stepIndex < 0) continue;

    const key = groupKey(exec.id, stepIndex);
    let group = groups.get(key);
    if (!group) {
      group = {
        executionId: exec.id,
        stepIndex,
        activity: [],
        byKey: new Map(),
        agent: exec.agent ?? "",
        model: exec.model,
      };
      groups.set(key, group);
    } else {
      // An adapter run's identity does not change mid-step, but a retry's does:
      // keep the newest non-empty answer rather than the first.
      if (exec.agent) group.agent = exec.agent;
      if (exec.model) group.model = exec.model;
    }

    const name = toolName(p);
    const id = callKey(p, event.seq);
    const existing = group.byKey.get(id);
    if (event.type === "tool_use") {
      // A repeated use of one id keeps the first seq, as the chat projection
      // does: the call belongs to where it opened, not to where a retry landed.
      if (existing) {
        Object.assign(existing, { name, summary: callSummary(p, name) });
        continue;
      }
      group.byKey.set(
        id,
        (() => {
          const line: ToolStep = {
            kind: "tool",
            key: `tool-${id}`,
            speaker: group.agent,
            model: group.model,
            name,
            summary: callSummary(p, name),
            status: "running",
            input: p.input ?? (p.content as { input?: unknown } | undefined)?.input ?? p.content,
            seq: event.seq,
          };
          group.activity.push(line);
          return line;
        })(),
      );
      continue;
    }

    // A result says how the call ended; it does not get to unsay what the call
    // was. An adapter that sends only an id and an output would otherwise
    // rename the line to "tool" and lose the description with it.
    const ok = p.ok !== false && p.status !== "error";
    const patch = {
      status: ok ? ("done" as const) : ("error" as const),
      output: typeof p.output === "string" ? p.output : undefined,
    };
    if (existing) {
      Object.assign(existing, patch);
      const patchName = firstString(p.name, p.tool_name);
      if (patchName) existing.name = patchName;
      if (typeof p.summary === "string" && p.summary.trim()) {
        existing.summary = p.summary.trim();
      }
      continue;
    }
    // A result with no call in front of it: the console joined the stream
    // mid-turn (`?since_seq=`), so the result is all there is of that call.
    const line: ToolStep = {
      kind: "tool",
      key: `tool-${id}`,
      speaker: group.agent,
      model: group.model,
      name,
      summary: callSummary(p, name),
      input: p.input,
      seq: event.seq,
      ...patch,
    };
    group.byKey.set(id, line);
    group.activity.push(line);
  }

  const rows: WorkerRow[] = [];
  const placed = new Set<string>();
  for (const step of steps) {
    const key = groupKey(step.execution_id, step.step_index);
    placed.add(key);
    const group = groups.get(key);
    rows.push({
      executionId: step.execution_id,
      stepIndex: step.step_index,
      agent: step.agent,
      model: step.model,
      role: step.role,
      access: step.access,
      status: step.status,
      attempt: step.attempt,
      resultSummary: step.result_summary,
      error: step.error,
      activity: capActivity(group?.activity ?? [], maxLines),
      total: group?.activity.length ?? 0,
      unplanned: false,
    });
  }

  const orphans = [...groups.values()]
    .filter((group) => !placed.has(groupKey(group.executionId, group.stepIndex)))
    .sort((a, b) =>
      a.executionId === b.executionId
        ? a.stepIndex - b.stepIndex
        : a.executionId.localeCompare(b.executionId),
    );
  for (const group of orphans) {
    // The newest call is the one that says how it is going, and a failed call is
    // a fact whatever the plan table thinks.
    const last = group.activity[group.activity.length - 1];
    rows.push({
      executionId: group.executionId,
      stepIndex: group.stepIndex,
      agent: group.agent,
      model: group.model,
      status: last?.status === "error" ? "failed" : WORKER_STATUS_UNPLANNED,
      activity: capActivity(group.activity, maxLines),
      total: group.activity.length,
      unplanned: true,
    });
  }
  return rows;
}

/**
 * The tail of a long run of calls: what a worker is doing now is at the end of
 * the list, and a row that scrolled its own present off the top would be
 * answering a question nobody asked.
 */
function capActivity(activity: ToolStep[], maxLines: number): ToolStep[] {
  if (activity.length <= maxLines) return activity;
  return activity.slice(activity.length - maxLines);
}
