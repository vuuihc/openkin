import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import { groupByProject, taskActivityAt, type ProjectSortMode } from "./projectSidebar";

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

  it("sorts by last interaction desc by default (recent)", () => {
    const groups = groupByProject(tasks, {
      sortMode: "recent",
      pinned: [],
      archived: [],
      lastInteracted: {},
    });
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
      sortMode: "recent" as ProjectSortMode,
      pinned: ["/alpha", "/gamma"],
      archived: [],
      lastInteracted: {},
    });
    expect(groups.map((g) => g.cwd)).toEqual(["/alpha", "/gamma", "/beta"]);
    expect(groups[0].pinned).toBe(true);
    expect(groups[1].pinned).toBe(true);
    expect(groups[2].pinned).toBe(false);
  });

  it("merges local lastInteracted into recent ranking", () => {
    const groups = groupByProject(tasks, {
      sortMode: "recent",
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
        sortMode: "recent",
        pinned: ["/users/me/proj"],
        archived: [],
        lastInteracted: {},
      },
    );
    expect(groups[0].pinned).toBe(true);
  });

  it("hides archived projects from the main list", () => {
    const groups = groupByProject(tasks, {
      sortMode: "recent",
      pinned: [],
      archived: ["/gamma"],
      lastInteracted: {},
    });
    expect(groups.map((g) => g.cwd)).toEqual(["/beta", "/alpha"]);
  });

  it("returns only archived projects when onlyArchived is set", () => {
    const groups = groupByProject(tasks, {
      sortMode: "recent",
      pinned: [],
      archived: ["/alpha", "/beta"],
      lastInteracted: {},
      onlyArchived: true,
    });
    expect(groups.map((g) => g.cwd).sort()).toEqual(["/alpha", "/beta"]);
    expect(groups.every((g) => g.archived)).toBe(true);
  });

  it("archived pin is still marked but hidden from main list", () => {
    const groups = groupByProject(tasks, {
      sortMode: "recent",
      pinned: ["/alpha"],
      archived: ["/alpha"],
      lastInteracted: {},
    });
    expect(groups.map((g) => g.cwd)).toEqual(["/beta", "/gamma"]);
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
      sortMode: "recent",
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
});
