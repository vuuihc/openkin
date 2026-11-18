import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../api/client";
import { runningSubagentCount } from "./subagents";

/**
 * The header's count, read straight off the raw event stream.
 *
 * A subagent call is a `tool_use` the agent stamped `sidechain: true`; it is
 * in flight until a `tool_result` for the same `tool_use_id` lands. These pin
 * that rule at its awkward edges — parallel calls, the host's own calls, an
 * agent that has no sidechain concept at all, and a result that arrives twice.
 */

let seq = 0;

/** One event with only the fields the count reads. */
function ev(type: string, payload: Record<string, unknown>): TaskEvent {
  seq += 1;
  return {
    task_id: "task-1",
    event_epoch: 0,
    seq,
    ts: 1_700_000_000_000 + seq,
    type,
    payload,
  } as TaskEvent;
}

function call(id: string, sidechain?: boolean): TaskEvent {
  return ev("tool_use", { tool_use_id: id, name: "task", ...(sidechain ? { sidechain } : {}) });
}

function result(id: string): TaskEvent {
  return ev("tool_result", { tool_use_id: id, name: "task", ok: true });
}

/** The host's run-start: user-facing, so a new turn begins here. */
function hostStarted(): TaskEvent {
  return ev("task_started", {
    session_id: "s1",
    visibility: { user: true, task: true },
  });
}

/** A worker's start mid-turn: stamped task-only by the engine. */
function workerStarted(agent: string): TaskEvent {
  return ev("task_started", {
    session_id: "w1",
    agent,
    speaker: agent,
    visibility: { user: false, task: true },
  });
}

describe("runningSubagentCount", () => {
  it("counts a sidechain call until its result lands", () => {
    const callEv = call("toolu_1", true);
    expect(runningSubagentCount([callEv])).toBe(1);
    expect(runningSubagentCount([callEv, result("toolu_1")])).toBe(0);
  });

  it("counts parallel subagents separately", () => {
    const events = [call("toolu_1", true), call("toolu_2", true), call("toolu_3", true)];
    expect(runningSubagentCount(events)).toBe(3);

    // One result closes only its own call, not the whole fan-out.
    expect(runningSubagentCount([...events, result("toolu_2")])).toBe(2);
  });

  it("ignores the host's own tool calls", () => {
    // The host runs tools of its own on the same stream; without the
    // sidechain mark they are the agent working, not subagents running.
    expect(runningSubagentCount([call("toolu_host")])).toBe(0);
    expect(runningSubagentCount([call("toolu_host"), result("toolu_host")])).toBe(0);
  });

  it("stays at zero for an agent that sends no sidechain mark", () => {
    // The native adapters (claude-code stream-json, codex, droid, kinagent)
    // send ordinary tool calls and no `sidechain` anywhere.
    const events = [
      ev("message", { text: "working", role: "assistant" }),
      call("toolu_1"),
      call("toolu_2"),
      result("toolu_1"),
    ];
    expect(runningSubagentCount(events)).toBe(0);
  });

  it("does not double-count duplicate results", () => {
    // The same result replayed must not close a second, still-running call.
    expect(
      runningSubagentCount([
        call("toolu_1", true),
        call("toolu_2", true),
        result("toolu_1"),
        result("toolu_1"),
      ]),
    ).toBe(1);
  });

  it("does not count a call with no id to join on", () => {
    // A malformed row cannot be closed by any result; counting it would show a
    // live subagent forever.
    expect(runningSubagentCount([ev("tool_use", { sidechain: true })])).toBe(0);
  });

  it("starts a fresh turn at zero when the host run begins", () => {
    // A stopped or crashed turn never closes its open calls — cancel writes no
    // `tool_result`, and a follow-up revives the task without resetting the
    // transcript — so those orphans must not leak into the next turn's count.
    const events = [call("toolu_stale", true), hostStarted()];
    expect(runningSubagentCount(events)).toBe(0);

    // The new turn's own calls still count.
    expect(runningSubagentCount([...events, call("toolu_fresh", true)])).toBe(1);
  });

  it("does not reset on an orchestrated worker's start", () => {
    // Workers start mid-turn; clearing here would wipe the host's live count
    // every time a fan-out launched a peer.
    const events = [hostStarted(), call("toolu_1", true), workerStarted("codex")];
    expect(runningSubagentCount(events)).toBe(1);
  });
});
