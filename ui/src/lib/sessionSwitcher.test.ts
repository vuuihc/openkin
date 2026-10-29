import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import {
  attentionMark,
  buildSwitcherRows,
  switcherStatus,
  switcherTriggerLabel,
  tabMark,
  waitingTaskIds,
} from "./sessionSwitcher";

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

describe("attentionMark", () => {
  const row = (status: "waiting" | "running" | "failed" | "unread" | "idle", active = false) =>
    ({ status, active }) as const;

  it("prefers the session that cannot move without the reader", () => {
    expect(attentionMark([row("unread"), row("waiting")])).toBe("waiting");
  });

  it("ignores the session in front: the reader is already looking at it", () => {
    expect(attentionMark([row("waiting", true), row("running")])).toBeNull();
    expect(attentionMark([row("unread", true), row("idle")])).toBeNull();
  });

  it("still lights for another session when the active one is waiting", () => {
    expect(attentionMark([row("waiting", true), row("unread")])).toBe("unread");
  });

  it("does not count a failure, which stays failed until the tab is retried or closed", () => {
    // A dot that only clears when the tab goes away teaches the reader to stop
    // seeing the dot. The strip still shows the failure itself.
    expect(attentionMark([row("failed"), row("idle")])).toBeNull();
  });

  it("says nothing when every session is busy or idle", () => {
    expect(attentionMark([])).toBeNull();
    expect(attentionMark([row("running"), row("idle")])).toBeNull();
  });
});

describe("switcherTriggerLabel", () => {
  it("leaves the plain title alone when there is no dot", () => {
    // No `stateKey`: the call site then passes no params, and `t()` returns the
    // plain title rather than a template with an empty hole in it.
    expect(switcherTriggerLabel(null)).toEqual({ key: "switcher.title" });
  });

  it("names the state in the title when a dot is drawn", () => {
    expect(switcherTriggerLabel("waiting")).toEqual({
      key: "switcher.titleMarked",
      stateKey: "switcher.waiting",
    });
    expect(switcherTriggerLabel("unread")).toEqual({
      key: "switcher.titleMarked",
      stateKey: "switcher.unread",
    });
  });
});
