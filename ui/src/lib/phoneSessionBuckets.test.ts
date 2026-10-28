import { describe, expect, it } from "vitest";
import type { AgentSession, Task } from "../api/client";
import {
  filterProjectBuckets,
  phoneProjectBuckets,
  UNASSIGNED_PROJECT,
} from "./phoneSessionBuckets";

function task(partial: Partial<Task> & Pick<Task, "id" | "cwd" | "created_at">): Task {
  return {
    title: partial.title ?? partial.id,
    agent: "kin",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    ...partial,
  };
}

function session(partial: Partial<AgentSession> & Pick<AgentSession, "id" | "cwd">): AgentSession {
  return {
    agent_id: "claude-code",
    external_ref: partial.id,
    title: partial.id,
    status: "idle",
    first_seen_at: 0,
    last_seen_at: 0,
    updated_at: 0,
    linked: false,
    ...partial,
  };
}

const COPY = { untitled: "Untitled", noProject: "No project" };

function buckets(
  tasks: Task[],
  sessions: AgentSession[] = [],
  self = "self",
  archived: string[] = [],
) {
  return phoneProjectBuckets(tasks, sessions, self, COPY, archived);
}

describe("phoneProjectBuckets", () => {
  it("groups by project and merges imported sessions into the same heading", () => {
    const rows = buckets(
      [
        task({ id: "a", cwd: "/work/alpha", created_at: 10 }),
        task({ id: "b", cwd: "/work/alpha/", created_at: 20 }),
        task({ id: "c", cwd: "/work/beta", created_at: 30 }),
      ],
      [session({ id: "s1", cwd: "/work/alpha", updated_at: 40 })],
    );
    expect(rows.map((bucket) => bucket.label)).toEqual(["alpha", "beta"]);
    const alpha = rows.find((bucket) => bucket.key === "/work/alpha")!;
    // The trailing slash is the same project, and the imported session joins it.
    expect(alpha.rows.map((row) => row.key)).toEqual(["s1", "b", "a"]);
  });

  it("orders by newest activity and puts the no-project bucket last", () => {
    const rows = buckets([
      task({ id: "old", cwd: "/work/old", created_at: 10 }),
      task({ id: "new", cwd: "/work/new", created_at: 90 }),
      task({ id: "loose", cwd: "", created_at: 100 }),
    ]);
    expect(rows.map((bucket) => bucket.key)).toEqual(["/work/new", "/work/old", UNASSIGNED_PROJECT]);
    expect(rows[2]!.label).toBe("No project");
  });

  it("drops an archived project's rows, heading and all", () => {
    const rows = buckets(
      [
        task({ id: "a", cwd: "/work/alpha", created_at: 10 }),
        task({ id: "b", cwd: "/work/beta", created_at: 20 }),
      ],
      [session({ id: "s1", cwd: "/work/alpha", updated_at: 30 })],
      "self",
      // Stored as the sidebar stores it: a trailing slash and a different case
      // are the same project.
      ["/Work/Alpha/"],
    );
    expect(rows.map((bucket) => bucket.key)).toEqual(["/work/beta"]);
    expect(rows.flatMap((bucket) => bucket.rows.map((row) => row.key))).toEqual(["b"]);
  });

  it("drops the no-project bucket when the sidebar archived its own root group", () => {
    // The drawer files cwd-less tasks under `__root__`, this module under
    // `__unassigned__`; an archive entry for one has to hide the other.
    const rows = buckets(
      [
        task({ id: "loose", cwd: "", created_at: 10 }),
        task({ id: "b", cwd: "/work/beta", created_at: 20 }),
      ],
      [],
      "self",
      ["__root__"],
    );
    expect(rows.map((bucket) => bucket.key)).toEqual(["/work/beta"]);
  });

  it("sorts a finished task by when it finished, not when it was created", () => {
    const rows = buckets([
      task({ id: "started-early", cwd: "/work/a", created_at: 1, finished_at: 50 }),
      task({ id: "newer", cwd: "/work/a", created_at: 10, finished_at: 20 }),
    ]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["started-early", "newer"]);
  });

  it("marks only sessions on another machine as remote", () => {
    const rows = buckets(
      [
        task({ id: "here", cwd: "/work/a", created_at: 1, executing_device_id: "self" }),
        task({ id: "there", cwd: "/work/a", created_at: 2, executing_device_id: "desktop-other" }),
        task({ id: "legacy", cwd: "/work/a", created_at: 3 }),
      ],
      [],
      "self",
    );
    const byKey = new Map(rows[0]!.rows.map((row) => [row.key, row]));
    expect(byKey.get("here")!.remote).toBe(false);
    expect(byKey.get("there")!.remote).toBe(true);
    // An empty device is this machine: tasks predate the column.
    expect(byKey.get("legacy")!.remote).toBe(false);
  });

  it("falls back to the prompt, then to the untitled label", () => {
    const rows = buckets([
      task({ id: "a", cwd: "/work/a", created_at: 1, title: "", prompt: "do the thing" }),
      task({ id: "b", cwd: "/work/a", created_at: 2, title: "", prompt: "" }),
    ]);
    expect(rows[0]!.rows.map((row) => row.title)).toEqual(["Untitled", "do the thing"]);
  });

  it("keeps an opaque imported title readable", () => {
    const rows = buckets(
      [],
      [
        session({
          id: "s1",
          cwd: "/work/a",
          title: "0192f0c4-1111-4222-8333-444455556666",
          project_label: "alpha",
        }),
      ],
    );
    expect(rows[0]!.rows[0]!.title).toContain("alpha");
  });
});

describe("filterProjectBuckets", () => {
  const rows = buckets([
    task({ id: "a", cwd: "/work/alpha", created_at: 1, title: "Fix the parser", agent: "codex" }),
    task({ id: "b", cwd: "/work/beta", created_at: 2, title: "Write docs", agent: "kin" }),
  ]);

  it("matches a row title inside its project", () => {
    const filtered = filterProjectBuckets(rows, "parser");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.rows.map((row) => row.key)).toEqual(["a"]);
  });

  it("matches the agent id", () => {
    const filtered = filterProjectBuckets(rows, "codex");
    expect(filtered.flatMap((bucket) => bucket.rows.map((row) => row.key))).toEqual(["a"]);
  });

  it("keeps every row of a project whose heading matches", () => {
    const filtered = filterProjectBuckets(rows, "beta");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.rows.map((row) => row.key)).toEqual(["b"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(filterProjectBuckets(rows, "  PARSER ")).toHaveLength(1);
  });

  it("returns everything for an empty query", () => {
    expect(filterProjectBuckets(rows, "   ")).toHaveLength(2);
  });
});
