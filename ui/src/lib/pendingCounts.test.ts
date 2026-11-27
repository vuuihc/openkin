import { describe, expect, it } from "vitest";
import type { Approval, UserQuestion } from "../api/client";
import { pendingCountsByTask } from "./pendingCounts";

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

function question(id: string, taskId: string): UserQuestion {
  return {
    id,
    task_id: taskId,
    payload: {},
    status: "pending",
    created_at: 1,
  } as unknown as UserQuestion;
}

describe("pendingCountsByTask", () => {
  it("names the kind each conversation waits on", () => {
    const counts = pendingCountsByTask({
      approvals: [approval("a1", "task-1"), approval("a2", "task-2"), approval("a3", "task-1")],
      questions: [question("q1", "task-1")],
    });

    expect(counts.get("task-1")).toEqual({ approvals: 2, questions: 1, total: 3 });
    expect(counts.get("task-2")).toEqual({ approvals: 1, questions: 0, total: 1 });
    expect(counts.size).toBe(2);
  });

  it("names no row when nothing waits", () => {
    expect(pendingCountsByTask({ approvals: [], questions: [] }).size).toBe(0);
  });

  it("drops an item that names no conversation instead of counting it nowhere", () => {
    const counts = pendingCountsByTask({ approvals: [approval("a1", "")], questions: [] });
    expect(counts.size).toBe(0);
  });
});
