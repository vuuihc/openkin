import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import { groupByProject, taskActivityAt } from "./projectSidebar";

function task(partial: Partial<Task> & Pick<Task, "id" | "cwd" | "created_at">): Task {
  return {
    title: partial.title ?? partial.id,
    agent: "kin",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    ...partial,
  };
}

describe("taskActivityAt", () => {
  it("uses the latest of created/started/finished", () => {
    expect(
      taskActivityAt(
        task({ id: "a", cwd: "/p", created_at: 10, started_at: 20, finished_at: 15 }),
      ),
    ).toBe(20);
    expect(taskActivityAt(task({ id: "b", cwd: "/p", created_at: 5 }))).toBe(5);
  });
});

describe("groupByProject", () => {
  const tasks = [
    task({ id: "old", cwd: "/alpha", created_at: 100, finished_at: 100 }),
    task({ id: "new", cwd: "/beta", created_at: 200, finished_at: 300 }),
    task({ id: "mid", cwd: "/gamma", created_at: 150, finished_at: 250 }),
  ];

  it("active mode puts projects with active tasks first, then by recency", () => {
    const groups = groupByProject(tasks, {
      sortMode: "active",
      pinned: [],
      archived: [],
      lastInteracted: {},
    });
    // All succeeded so all idle; falls back to recency
    expect(groups.map((g) => g.cwd)).toEqual(["/beta", "/gamma", "/alpha"]);
  });

  it("sorts by project created time desc when mode is created", () => {
    const groups = groupByProject(tasks, {
      sortMode: "created",
      pinned: [],
      archived: [],
      lastInteracted: {},
    });
    expect(groups.map((g) => g.cwd)).toEqual(["/beta", "/gamma", "/alpha"]);
  });

  it("puts pinned projects first in pin order", () => {
    const groups = groupByProject(tasks, {
      sortMode: "active",
      pinned: ["/alpha", "/gamma"],
      archived: [],
      lastInteracted: {},
    });
    expect(groups.map((g) => g.cwd)).toEqual(["/alpha", "/gamma", "/beta"]);
    expect(groups[0].pinned).toBe(true);
    expect(groups[1].pinned).toBe(true);
    expect(groups[2].pinned).toBe(false);
  });

  it("merges local lastInteracted into active ranking", () => {
    const groups = groupByProject(tasks, {
      sortMode: "active",
      pinned: [],
      archived: [],
      lastInteracted: { "/alpha": 999 },
    });
    expect(groups.map((g) => g.cwd)).toEqual(["/alpha", "/beta", "/gamma"]);
  });

  it("normalizes path casing for pin match", () => {
    const groups = groupByProject(
      [task({ id: "1", cwd: "/Users/Me/Proj", created_at: 1 })],
      {
        sortMode: "active",
        pinned: ["/users/me/proj"],
        archived: [],
        lastInteracted: {},
      },
    );
    expect(groups[0].pinned).toBe(true);
  });

  it("hides archived projects from the main list", () => {
    const groups = groupByProject(tasks, {
      sortMode: "active",
      pinned: [],
      archived: ["/gamma"],
      lastInteracted: {},
    });
    expect(groups.map((g) => g.cwd)).toEqual(["/beta", "/alpha"]);
  });

  it("includes only archived projects when onlyArchived is true", () => {
    const groups = groupByProject(
      tasks,
      {
        sortMode: "active",
        pinned: [],
        archived: ["/gamma"],
        lastInteracted: {},
      },
      true /* includeArchived */,
      true /* onlyArchived */,
    );
    expect(groups.map((g) => g.cwd)).toEqual(["/gamma"]);
  });

  it("sorts sessions within a project by activity desc with active tasks first", () => {
    const sameProject = [
      task({ id: "newer-run", cwd: "/p", created_at: 10, finished_at: 200 }),
      task({ id: "older-open", cwd: "/p", created_at: 5, finished_at: 5 }),
      task({ id: "mid", cwd: "/p", created_at: 15, finished_at: 100 }),
    ];
    const groups = groupByProject(sameProject, {
      sortMode: "active",
      pinned: [],
      archived: [],
      lastInteracted: {},
    });
    expect(groups).toHaveLength(1);
    // All succeeded, so sorted by activity desc (finished_at)
    expect(groups[0].items.map((x) => x.id)).toEqual(["newer-run", "mid", "older-open"]);

    // Opening older-open should float it above server activity.
    const afterOpen = groupByProject(sameProject, {
      sortMode: "active",
      pinned: [],
      archived: [],
      lastInteracted: {},
      sessionLastInteracted: { "older-open": 999 },
    });
    expect(afterOpen[0].items.map((x) => x.id)).toEqual(["older-open", "newer-run", "mid"]);
  });

  it("taskActivityAt prefers local session last-interact over server timestamps", () => {
    const t = task({ id: "s1", cwd: "/p", created_at: 10, started_at: 20, finished_at: 30 });
    expect(taskActivityAt(t, {})).toBe(30);
    expect(taskActivityAt(t, { s1: 50 })).toBe(50);
    expect(taskActivityAt(t, { s1: 15 })).toBe(30);
  });

  it("keeps more than 8 sessions per project (sidebar collapses, not data)", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      task({
        id: String(i + 1),
        cwd: "/alpha",
        created_at: i + 1,
        started_at: i + 1,
      }),
    );
    const groups = groupByProject(many, {
      sortMode: "active",
      pinned: [],
      archived: [],
      lastInteracted: {},
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(12);
    // still sorted by activity desc
    expect(groups[0].items[0].id).toBe("12");
    expect(groups[0].items[11].id).toBe("1");
  });

  it("active mode puts projects with running/pending tasks first", () => {
    const mixed = [
      task({ id: "a1", cwd: "/active", created_at: 100, status: "running" }),
      task({ id: "a2", cwd: "/active", created_at: 50, status: "running" }),
      task({ id: "b1", cwd: "/idle", created_at: 200, finished_at: 300 }),
      task({ id: "c1", cwd: "/pending", created_at: 150, status: "waiting_approval" }),
    ];
    const groups = groupByProject(mixed, {
      sortMode: "active",
      pinned: [],
      archived: [],
      lastInteracted: {},
    });
    // Active projects first (/active, /pending), then idle (/idle)
    expect(groups.map((g) => g.cwd)).toEqual(["/active", "/pending", "/idle"]);
  });

  it("active mode falls back to recency when no active tasks", () => {
    const allIdle = [
      task({ id: "x", cwd: "/zeta", created_at: 300, finished_at: 300 }),
      task({ id: "y", cwd: "/alpha", created_at: 100, finished_at: 200 }),
    ];
    const groups = groupByProject(allIdle, {
      sortMode: "active",
      pinned: [],
      archived: [],
      lastInteracted: {},
    });
    // All idle: fall back to recency (lastInteractedAt = finished_at)
    expect(groups.map((g) => g.cwd)).toEqual(["/zeta", "/alpha"]);
  });

  it("active mode correctly identifies hasActiveTask", () => {
    const mixed = [
      task({ id: "r", cwd: "/running", created_at: 100, status: "running" }),
      task({ id: "s", cwd: "/done", created_at: 200, finished_at: 300 }),
    ];
    const groups = groupByProject(mixed, {
      sortMode: "active",
      pinned: [],
      archived: [],
      lastInteracted: {},
    });
    expect(groups[0].hasActiveTask).toBe(true);
    expect(groups[1].hasActiveTask).toBe(false);
  });
});
