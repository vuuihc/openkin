import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import { switcherStatus, tabMark, waitingTaskIds } from "./sessionSwitcher";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    agent: "kin",
    cwd: `/work/${id}`,
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 0,
    event_epoch: 0,
    ...overrides,
  } as Task;
}

describe("switcherStatus", () => {
  it("puts a session that is waiting for the reader above one that is busy", () => {
    expect(switcherStatus(task("a", { status: "running" }), false, true)).toBe("waiting");
    expect(switcherStatus(task("b", { status: "succeeded" }), false, true)).toBe("waiting");
  });

  it("reads the block from the task status too, not only the pending lists", () => {
    // The lists can lag a status update (first paint after load, a failed
    // refresh); the durable status is in the row already.
    expect(switcherStatus(task("a", { status: "waiting_approval" }), false, false)).toBe("waiting");
    expect(switcherStatus(task("b", { status: "waiting_input" }), false, false)).toBe("waiting");
    // Above a failure and above "unread": the reader's attention is the scarce
    // thing, and only this state cannot resolve itself.
    expect(switcherStatus(task("c", { status: "failed" }), false, true)).toBe("waiting");
  });

  it("calls anything not terminal running", () => {
    expect(switcherStatus(task("a", { status: "running" }), true, false)).toBe("running");
    expect(switcherStatus(task("b", { status: "queued" }), true, false)).toBe("running");
  });

  it("keeps a failure visible after the session has been opened", () => {
    expect(switcherStatus(task("a", { status: "failed" }), false, false)).toBe("failed");
    expect(switcherStatus(task("a", { status: "failed" }), true, false)).toBe("failed");
  });

  it("marks a finished session unread until it has been opened", () => {
    expect(switcherStatus(task("a", { status: "succeeded" }), false, false)).toBe("unread");
    expect(switcherStatus(task("a", { status: "succeeded" }), true, false)).toBe("idle");
    expect(switcherStatus(task("a", { status: "canceled" }), false, false)).toBe("idle");
  });
});

describe("waitingTaskIds", () => {
  it("unions approvals and questions, ignoring rows with no task", () => {
    const ids = waitingTaskIds(
      [{ task_id: "a" }, { task_id: "b" }],
      [{ task_id: "b" }, { task_id: "c" }],
    );
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("tabMark", () => {
  it("puts the block on the tab from either the lists or the status", () => {
    expect(tabMark(task("a", { status: "running" }), false, true)).toBe("waiting");
    expect(tabMark(task("a", { status: "waiting_approval" }), false, false)).toBe("waiting");
  });

  it("says a session is waiting even when its row is outside the loaded page", () => {
    // A tab outlives the page; the pending lists do not need the row.
    expect(tabMark(undefined, false, true)).toBe("waiting");
    expect(tabMark(undefined, false, false)).toBeNull();
  });

  it("keeps a failure visible after the session has been opened", () => {
    expect(tabMark(task("a", { status: "failed" }), false, false)).toBe("failed");
    expect(tabMark(task("a", { status: "failed" }), true, false)).toBe("failed");
  });

  it("marks a finished session unread until it has been opened", () => {
    expect(tabMark(task("a", { status: "succeeded" }), false, false)).toBe("unread");
    expect(tabMark(task("a", { status: "succeeded" }), true, false)).toBeNull();
  });

  it("draws nothing on a session that is merely busy", () => {
    // A spinner on every running tab is a strip of noise; the sheet has room
    // for the word, the strip does not.
    expect(tabMark(task("a", { status: "running" }), false, false)).toBeNull();
    expect(tabMark(task("a", { status: "queued" }), false, false)).toBeNull();
    expect(tabMark(task("a", { status: "canceled" }), false, false)).toBeNull();
  });
});
