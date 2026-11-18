/**
 * How many subagent calls a turn still has in flight.
 *
 * Read from the raw event stream, not from the transcript projection. The
 * projection nests each subagent's calls under the call that spawned them and
 * deliberately drops some of the task-only child tools (see
 * `transcriptProjection.test.ts`), so counting its steps would undercount a
 * fan-out — and the header's one job here is an honest number, not a faithful
 * drawing.
 *
 * The rule is one join on one id. A call is a `tool_use` the agent stamped
 * `sidechain: true`; it is running until a `tool_result` carrying the same
 * `tool_use_id` lands. The host's own calls travel on the same stream without
 * the mark, so they are not subagents. An adapter with no subagent concept
 * (ACP) sends neither the mark nor the nesting, so the count stays at 0 and
 * the header draws nothing — which is the correct answer, not a gap.
 */
import type { TaskEvent } from "../api/client";

export function runningSubagentCount(events: TaskEvent[]): number {
  // Two sets, not a per-call toggle: a call may be sighted more than once (a
  // status update repeats its `tool_use_id`) and a result may be replayed, and
  // neither may move the count twice.
  const running = new Set<string>();
  const done = new Set<string>();

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const id = typeof p.tool_use_id === "string" ? p.tool_use_id : "";
    // Without the id there is no join, and a call that cannot be closed is
    // worse than one that is not counted.
    if (!id) continue;
    if (ev.type === "tool_use" && p.sidechain === true) {
      running.add(id);
    } else if (ev.type === "tool_result") {
      done.add(id);
    }
  }

  let count = 0;
  for (const id of running) {
    if (!done.has(id)) count += 1;
  }
  return count;
}
