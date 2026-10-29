import { describe, expect, it, vi } from "vitest";
import type { AgentSession, Task } from "../api/client";
import { loadProjectChats, normalizeProjectTab, projectChatRows, projectRoots } from "./projectChats";

function task(partial: Partial<Task> & Pick<Task, "id" | "created_at">): Task {
  return {
    title: partial.title ?? partial.id,
    agent: "kin",
    cwd: "/work/alpha",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    ...partial,
  };
}

function session(partial: Partial<AgentSession> & Pick<AgentSession, "id">): AgentSession {
  return {
    agent_id: "claude-code",
    external_ref: partial.id,
    title: partial.title ?? partial.id,
    cwd: "/work/alpha",
    status: "idle",
    first_seen_at: 0,
    last_seen_at: 0,
    updated_at: 0,
    linked: false,
    ...partial,
  };
}

const COPY = { untitled: "Untitled chat" };

describe("projectChatRows", () => {
  it("merges Kin tasks and imported sessions newest first", () => {
    const rows = projectChatRows(
      [task({ id: "a", created_at: 10 }), task({ id: "b", created_at: 30, finished_at: 40 })],
      [session({ id: "s1", updated_at: 20 })],
      COPY,
      "self",
    );
    // The task's clock is when it last did something, not when it opened.
    expect(rows.map((row) => row.key)).toEqual(["b", "s1", "a"]);
    expect(rows.map((row) => row.at)).toEqual([40, 20, 10]);
  });

  it("opens a task as a task and an imported session as a session", () => {
    const rows = projectChatRows(
      [task({ id: "t1", created_at: 10 })],
      [session({ id: "s1", updated_at: 20 })],
      COPY,
      "self",
    );
    expect(rows[0]?.session?.id).toBe("s1");
    expect(rows[0]?.task).toBeUndefined();
    expect(rows[1]?.task?.id).toBe("t1");
    expect(rows[1]?.session).toBeUndefined();
  });

  it("keeps a task and a session that share an id as two rows", () => {
    // Task ids and imported-session ids are different namespaces; a merged
    // list that keyed only by the raw id would lose one of them.
    const rows = projectChatRows(
      [task({ id: "same", created_at: 10 })],
      [session({ id: "same", updated_at: 20 })],
      COPY,
      "self",
    );
    expect(rows).toHaveLength(2);
  });

  it("collapses the same imported session returned for two roots", () => {
    const rows = projectChatRows(
      [],
      [session({ id: "s1", updated_at: 20 }), session({ id: "s1", updated_at: 20 })],
      COPY,
      "self",
    );
    expect(rows).toHaveLength(1);
  });

  it("falls back to the prompt, then the untitled copy", () => {
    const rows = projectChatRows(
      [
        task({ id: "prompt", created_at: 10, title: "  ", prompt: "fix the build" }),
        task({ id: "blank", created_at: 20, title: "", prompt: "" }),
      ],
      [],
      COPY,
      "self",
    );
    expect(rows[0]?.title).toBe("Untitled chat");
    expect(rows[1]?.title).toBe("fix the build");
  });

  it("uses the agent's display title for an opaque imported title", () => {
    const rows = projectChatRows(
      [],
      [
        session({
          id: "s1",
          title: "0123456789abcdef0123456789abcdef",
          external_ref: "0123456789abcdef0123456789abcdef",
          project_label: "alpha",
          updated_at: 1,
        }),
      ],
      COPY,
      "self",
    );
    expect(rows[0]?.title).toContain("Claude Code");
    expect(rows[0]?.title).toContain("alpha");
  });

  it("marks a row that runs on another machine, and not this one", () => {
    const rows = projectChatRows(
      [task({ id: "here", created_at: 10, executing_device_id: "self" })],
      [session({ id: "there", updated_at: 20, device_id: "other" })],
      COPY,
      "self",
    );
    expect(rows[0]).toMatchObject({ key: "there", remote: true });
    expect(rows[1]).toMatchObject({ key: "here", remote: false });
  });

  it("applies the limit after the merge, keeping the newest", () => {
    const rows = projectChatRows(
      [task({ id: "t1", created_at: 10 }), task({ id: "t2", created_at: 30 })],
      [session({ id: "s1", updated_at: 20 })],
      COPY,
      "self",
      2,
    );
    expect(rows.map((row) => row.key)).toEqual(["t2", "s1"]);
  });

  it("caps the merged list at 100 rows by default", () => {
    // The screen never passes a limit, so the default is the one users get:
    // a busy project must not render an unbounded list.
    const tasks = Array.from({ length: 101 }, (_, i) =>
      task({ id: `t${String(i).padStart(3, "0")}`, created_at: i }),
    );
    expect(projectChatRows(tasks, [], COPY, "self")).toHaveLength(100);
  });
});

describe("projectRoots", () => {
  it("trims roots and drops blanks, in order", () => {
    expect(projectRoots({ roots: [" /work/a ", "", "  ", "/work/b"] })).toEqual([
      "/work/a",
      "/work/b",
    ]);
  });

  it("answers an empty list for a project with no roots", () => {
    expect(projectRoots({ roots: [] })).toEqual([]);
    expect(projectRoots({})).toEqual([]);
    expect(projectRoots(null)).toEqual([]);
  });
});

describe("loadProjectChats", () => {
  const copy = { untitled: "Untitled chat", loadFailed: "Could not load" };

  it("merges both feeds when everything answers", async () => {
    const outcome = await loadProjectChats({
      projectId: "p1",
      roots: ["/work/a", "/work/b"],
      feed: {
        tasks: async () => [task({ id: "t1", created_at: 10 })],
        sessions: async (root) => [
          session({ id: `s-${root}`, cwd: root, updated_at: 20 }),
        ],
      },
      copy,
      selfDeviceId: "self",
    });
    expect(outcome?.projectId).toBe("p1");
    expect(outcome?.rows.map((row) => row.key)).toEqual(["s-/work/a", "s-/work/b", "t1"]);
    expect(outcome?.partial).toBe(false);
    expect(outcome?.error).toBeNull();
  });

  it("reports the task read failing as an error, with no list", async () => {
    const outcome = await loadProjectChats({
      projectId: "p1",
      roots: ["/work/a"],
      feed: {
        tasks: async () => {
          throw new Error("task feed down");
        },
        sessions: async () => [session({ id: "s1", updated_at: 20 })],
      },
      copy,
      selfDeviceId: "self",
    });
    expect(outcome).toMatchObject({ error: "task feed down", rows: [], partial: false });
  });

  it("falls back to the localized message for a non-Error rejection", async () => {
    const outcome = await loadProjectChats({
      projectId: "p1",
      roots: [],
      feed: {
        tasks: async () => {
          throw "nope";
        },
        sessions: async () => [],
      },
      copy,
      selfDeviceId: "self",
    });
    expect(outcome?.error).toBe("Could not load");
  });

  it("reports a row it cannot shape as a load error instead of throwing", async () => {
    // The API's types are a promise, not a runtime guarantee. A row that
    // cannot be shaped must reach the retry box, not reject a promise the page
    // never awaits -- which would leave the tab loading forever.
    const malformed = { ...task({ id: "t1", created_at: 10 }), title: 42 } as unknown as Task;
    const outcome = await loadProjectChats({
      projectId: "p1",
      roots: [],
      feed: { tasks: async () => [malformed], sessions: async () => [] },
      copy,
      selfDeviceId: "self",
    });
    expect(outcome).toMatchObject({ error: "Could not load", rows: [], partial: false });
  });

  it("keeps the roots that answered and marks the list partial", async () => {
    const outcome = await loadProjectChats({
      projectId: "p1",
      roots: ["/work/a", "/work/b"],
      feed: {
        tasks: async () => [task({ id: "t1", created_at: 10 })],
        sessions: async (root) => {
          if (root === "/work/b") throw new Error("unreachable");
          return [session({ id: "s-a", cwd: root, updated_at: 20 })];
        },
      },
      copy,
      selfDeviceId: "self",
    });
    expect(outcome?.rows.map((row) => row.key)).toEqual(["s-a", "t1"]);
    expect(outcome?.partial).toBe(true);
    expect(outcome?.error).toBeNull();
  });

  it("writes nothing once a newer read has taken over", async () => {
    // The page moves to another project while this read is in flight. Its
    // answer must not land -- and it must not report an error either.
    let current = true;
    const outcome = await loadProjectChats({
      projectId: "p1",
      roots: ["/work/a"],
      feed: {
        tasks: async () => {
          current = false; // the switch happens during the first await
          return [task({ id: "t1", created_at: 10 })];
        },
        sessions: async () => [session({ id: "s1", updated_at: 20 })],
      },
      copy,
      selfDeviceId: "self",
      isCurrent: () => current,
    });
    expect(outcome).toBeNull();
  });

  it("drops a root that answers after the read was superseded", async () => {
    // The task read is still current when it returns; the switch happens while
    // the session reads are outstanding, so the merge must not happen.
    let current = true;
    const outcome = await loadProjectChats({
      projectId: "p1",
      roots: ["/work/a"],
      feed: {
        tasks: async () => [task({ id: "t1", created_at: 10 })],
        sessions: async () => {
          current = false;
          return [session({ id: "s1", updated_at: 20 })];
        },
      },
      copy,
      selfDeviceId: "self",
      isCurrent: () => current,
    });
    expect(outcome).toBeNull();
  });

  it("does not consult isCurrent after the last await", async () => {
    const isCurrent = vi.fn(() => true);
    const outcome = await loadProjectChats({
      projectId: "p1",
      roots: ["/work/a"],
      feed: {
        tasks: async () => [],
        sessions: async () => [],
      },
      copy,
      selfDeviceId: "self",
      isCurrent,
    });
    expect(outcome).not.toBeNull();
    // One check after tasks, one after the roots -- not a third, redundant one.
    expect(isCurrent).toHaveBeenCalledTimes(2);
  });
});

describe("normalizeProjectTab", () => {
  it("takes only the chats value, and treats anything else as the overview", () => {
    expect(normalizeProjectTab("chats")).toBe("chats");
    expect(normalizeProjectTab("overview")).toBe("overview");
    expect(normalizeProjectTab("files")).toBe("overview");
    expect(normalizeProjectTab(null)).toBe("overview");
  });
});
