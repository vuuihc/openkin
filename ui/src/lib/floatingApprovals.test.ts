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
  it("floats every waiting approval away from the inbox", () => {
    expect(
      floatingApprovals(waiting, { onInbox: false, visibleTaskId: null }).map((a) => a.id),
    ).toEqual(["a1", "a2", "a3"]);
  });

  it("floats nothing over the inbox, which already lists them", () => {
    expect(floatingApprovals(waiting, { onInbox: true, visibleTaskId: null })).toEqual([]);
  });

  it("drops the task on screen, whose transcript renders its own card", () => {
    expect(
      floatingApprovals(waiting, { onInbox: false, visibleTaskId: "task-1" }).map((a) => a.id),
    ).toEqual(["a2"]);
  });

  it("keeps the other tasks' approvals while one conversation is open", () => {
    // The point of the feature: reading task-1 must not hide task-2's request.
    const floating = floatingApprovals(waiting, { onInbox: false, visibleTaskId: "task-9" });
    expect(floating).toHaveLength(3);
  });

  it("does not mutate the list it was given", () => {
    const input = [...waiting];
    floatingApprovals(input, { onInbox: false, visibleTaskId: "task-1" });
    expect(input).toHaveLength(3);
  });
});
