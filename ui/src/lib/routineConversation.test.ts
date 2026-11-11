import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import {
  conversationModeOf,
  DEFAULT_CONVERSATION_MODE,
  nextRunConversation,
  previousConversation,
} from "./routineConversation";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "run-2",
    title: "run",
    agent: "claude-code",
    cwd: "/work/alpha",
    prompt: "go",
    status: "succeeded",
    created_at: 2,
    ...over,
  } as Task;
}

describe("routine conversation mode (KIN-ROUTINE-001)", () => {
  it("defaults to continuing one session", () => {
    expect(DEFAULT_CONVERSATION_MODE).toBe("continue");
    expect(conversationModeOf(undefined)).toBe("continue");
    expect(conversationModeOf({})).toBe("continue");
    expect(conversationModeOf({ conversation_mode: "" })).toBe("continue");
    expect(conversationModeOf({ conversation_mode: "something-new" })).toBe("continue");
    expect(conversationModeOf({ conversation_mode: "fresh" })).toBe("fresh");
  });

  it("continues the previous run's session id on the second run", () => {
    const previous = task({ id: "run-1", routine_id: "r1", session_ref: " sess-1 " });
    const next = nextRunConversation(
      "continue",
      previousConversation([previous], { id: "r1", agent: "claude-code" }),
      "/work/alpha",
    );
    expect(next).toEqual({ sessionRef: "sess-1", cwd: "/work/alpha" });
  });

  it("starts a new session id in the project directory when the mode is fresh", () => {
    const previous = task({ id: "run-1", routine_id: "r1", session_ref: "sess-1" });
    const next = nextRunConversation(
      "fresh",
      previousConversation([previous], { id: "r1", agent: "claude-code" }),
      "/work/alpha",
    );
    expect(next).toEqual({ sessionRef: null, cwd: "/work/alpha" });
  });

  it("has nothing to resume on the first run", () => {
    expect(
      nextRunConversation(
        "continue",
        previousConversation([], { id: "r1", agent: "claude-code" }),
        "/work/alpha",
      ),
    ).toEqual({ sessionRef: null, cwd: "/work/alpha" });
    expect(nextRunConversation("continue", task({ session_ref: "   " }), "/work/alpha")).toEqual({
      sessionRef: null,
      cwd: "/work/alpha",
    });
  });

  it("lets only the newest run of this routine decide", () => {
    const runs = [
      task({ id: "other-routine", routine_id: "r2", session_ref: "sess-other-routine" }),
      task({ id: "newest", routine_id: "r1", session_ref: "sess-newest" }),
      task({ id: "older", routine_id: "r1", session_ref: "sess-older" }),
    ];
    const picked = previousConversation(runs, {
      id: "r1",
      agent: "claude-code",
      cwd: "/work/alpha",
      model: "",
    });
    expect(picked?.id).toBe("newest");
    expect(nextRunConversation("continue", picked, "/work/alpha").sessionRef).toBe("sess-newest");
  });

  it("does not reach past a newest run the daemon would refuse", () => {
    // The daemon asks its task list for exactly one row. An older resumable
    // session must not be promised when the newest row is not resumable: the
    // form would claim continuity the next dispatch does not carry.
    const older = task({ id: "older", routine_id: "r1", session_ref: "sess-older" });
    const routine = { id: "r1", agent: "claude-code", cwd: "/work/alpha", model: "m1" };
    const refused = [
      task({ id: "foreign", routine_id: "r1", session_ref: "sess-foreign", session_ref_device_id: "node-a", model: "m1" }),
      task({ id: "wrong-agent", routine_id: "r1", agent: "codex", session_ref: "sess-codex", model: "m1" }),
      task({ id: "no-session", routine_id: "r1", model: "m1" }),
      task({ id: "elsewhere", routine_id: "r1", cwd: "/work/beta", session_ref: "sess-beta", model: "m1" }),
      task({ id: "other-model", routine_id: "r1", session_ref: "sess-m2", model: "m2" }),
      task({ id: "running", routine_id: "r1", session_ref: "sess-live", model: "m1", status: "running" }),
    ];
    for (const newest of refused) {
      expect(previousConversation([newest, older], routine), newest.id).toBeUndefined();
    }
  });

  it("continues a failed or canceled run, not just a successful one", () => {
    // A failed run's ref is still the session the agent was working in; that
    // is how the next run can see why it failed without retelling the story.
    const routine = { id: "r1", agent: "claude-code", cwd: "/work/alpha", model: "" };
    for (const status of ["failed", "canceled"] as const) {
      const picked = previousConversation(
        [task({ id: status, routine_id: "r1", session_ref: "sess-1", status })],
        routine,
      );
      expect(picked?.id, status).toBe(status);
    }
  });

  it("does not pick a run when the routine is not known yet", () => {
    expect(previousConversation([task({ routine_id: "r1", session_ref: "s" })], undefined)).toBeUndefined();
    expect(
      previousConversation([task({ routine_id: "r1", session_ref: "s" })], {
        id: "",
        agent: "claude-code",
      }),
    ).toBeUndefined();
  });
});
