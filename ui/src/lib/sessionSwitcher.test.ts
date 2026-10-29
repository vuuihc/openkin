import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import { buildSwitcherRows, switcherStatus, waitingTaskIds } from "./sessionSwitcher";

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

const noIds = new Set<string>();

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

describe("buildSwitcherRows", () => {
  it("keeps open tabs first, in strip order, then the list's own order", () => {
    const rows = buildSwitcherRows({
      tabIds: ["b", "a"],
      tasks: [task("a"), task("c"), task("b"), task("d")],
      activeId: "a",
      viewedIds: noIds,
      pendingIds: noIds,
      untitled: "Untitled",
    });
    expect(rows.map((row) => [row.id, row.open, row.active])).toEqual([
      ["b", true, false],
      ["a", true, true],
      ["c", false, false],
      ["d", false, false],
    ]);
  });

  it("lists an open tab the loaded page does not know, instead of dropping it", () => {
    const rows = buildSwitcherRows({
      tabIds: ["gone"],
      tasks: [task("a")],
      activeId: "gone",
      viewedIds: noIds,
      pendingIds: new Set(["gone"]),
      untitled: "Untitled",
    });
    // The id is still enough to say it is blocked: the pending lists are keyed
    // by task id and do not need the row the page is missing.
    expect(rows[0]).toMatchObject({
      id: "gone",
      title: "Untitled",
      open: true,
      active: true,
      status: "waiting",
    });
  });

  it("offers twelve recent sessions when no other limit is asked for", () => {
    const recents = Array.from({ length: 20 }, (_, i) => task(`r${i}`));
    const rows = buildSwitcherRows({
      tabIds: [],
      tasks: recents,
      activeId: null,
      viewedIds: noIds,
      pendingIds: noIds,
      untitled: "Untitled",
    });
    expect(rows.length).toBe(12);
  });

  it("caps the recents behind the tabs without capping the tabs", () => {
    const rows = buildSwitcherRows({
      tabIds: ["t1", "t2", "t3"],
      tasks: [task("r1"), task("r2"), task("r3"), task("t1"), task("t2"), task("t3")],
      activeId: null,
      viewedIds: noIds,
      pendingIds: noIds,
      untitled: "Untitled",
      recentLimit: 2,
    });
    expect(rows.map((row) => row.id)).toEqual(["t1", "t2", "t3", "r1", "r2"]);
  });

  it("does not list the same session twice when a tab is also recent", () => {
    const rows = buildSwitcherRows({
      tabIds: ["a"],
      tasks: [task("a"), task("b")],
      activeId: "a",
      viewedIds: noIds,
      pendingIds: noIds,
      untitled: "Untitled",
    });
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("carries the status the sheet draws, including a mid-run block", () => {
    const rows = buildSwitcherRows({
      tabIds: [],
      tasks: [
        task("waiting", { status: "running" }),
        task("busy", { status: "running" }),
        task("done", { status: "succeeded" }),
        task("seen", { status: "succeeded" }),
      ],
      activeId: null,
      viewedIds: new Set(["seen"]),
      pendingIds: new Set(["waiting"]),
      untitled: "Untitled",
    });
    expect(rows.map((row) => row.status)).toEqual(["waiting", "running", "unread", "idle"]);
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
