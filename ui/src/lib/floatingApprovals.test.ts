import { describe, expect, it } from "vitest";
import type { Approval } from "../api/client";
import { floatingApprovals } from "./floatingApprovals";

function approval(id: string, taskId: string): Approval {
  return {
    id,
    task_id: taskId,
    kind: "tool",
    payload: {},
    decision: "pending",
    created_at: 1,
  };
}

const waiting = [approval("a1", "task-1"), approval("a2", "task-2"), approval("a3", "task-1")];

describe("floatingApprovals", () => {
  it("floats every waiting approval when no conversation owns the screen", () => {
    expect(floatingApprovals(waiting, { visibleTaskId: null }).map((a) => a.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
  });

  it("drops the task on screen, whose transcript renders its own card", () => {
    expect(floatingApprovals(waiting, { visibleTaskId: "task-1" }).map((a) => a.id)).toEqual([
      "a2",
    ]);
  });

  it("keeps the other tasks' approvals while one conversation is open", () => {
    // The point of the feature: reading task-1 must not hide task-2's request.
    const floating = floatingApprovals(waiting, { visibleTaskId: "task-9" });
    expect(floating).toHaveLength(3);
  });

  it("floats nothing over the inbox, which already lists the queue", () => {
    expect(floatingApprovals(waiting, { visibleTaskId: null, onInbox: true })).toEqual([]);
    expect(floatingApprovals(waiting, { visibleTaskId: "task-9", onInbox: true })).toEqual([]);
  });

  it("does not mutate the list it was given", () => {
    const input = [...waiting];
    floatingApprovals(input, { visibleTaskId: "task-1" });
    expect(input).toHaveLength(3);
  });
});
