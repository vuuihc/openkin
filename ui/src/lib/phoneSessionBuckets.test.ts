import { describe, expect, it } from "vitest";
import type { AgentSession, Task } from "../api/client";
import {
  archivedCwdFor,
  filterProjectBuckets,
  PINNED_BUCKET,
  withPinnedBucket,
  phoneProjectBuckets,
  type PhoneBucketScope,
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
  scope: PhoneBucketScope = "active",
) {
  return phoneProjectBuckets(tasks, sessions, self, COPY, archived, scope);
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

describe("the archived scope", () => {
  const tasks = [
    task({ id: "a", cwd: "/work/alpha", created_at: 10 }),
    task({ id: "b", cwd: "/work/beta", created_at: 20 }),
    task({ id: "loose", cwd: "", created_at: 30 }),
  ];

  it("shows the archived project and only it", () => {
    // The exact inverse of the active rule: the two scopes together have to
    // account for every project, or a project archived by mistake is reachable
    // from neither view.
    const rows = buckets(tasks, [], "self", ["/work/alpha"], "archived");
    expect(rows.map((bucket) => bucket.key)).toEqual(["/work/alpha"]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["a"]);
  });

  it("is empty when nothing is archived", () => {
    expect(buckets(tasks, [], "self", [], "archived")).toEqual([]);
  });

  it("finds the no-project bucket through the sidebar's own sentinel", () => {
    const rows = buckets(tasks, [], "self", ["__root__"], "archived");
    expect(rows.map((bucket) => bucket.key)).toEqual([UNASSIGNED_PROJECT]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["loose"]);
  });

  it("keeps an archived project whose chats are all older than the loaded page", () => {
    // Archiving is how a project you are done with is put away, so its newest
    // chat is usually older than the hundred rows the page holds — exactly the
    // case where it would otherwise vanish and be unrestorable from here.
    const rows = buckets(tasks, [], "self", ["/work/alpha", "/work/gamma"], "archived");
    expect(rows.map((bucket) => bucket.key)).toEqual(["/work/alpha", "/work/gamma"]);
    const gamma = rows.find((bucket) => bucket.key === "/work/gamma")!;
    expect(gamma.label).toBe("gamma");
    expect(gamma.rows).toEqual([]);
  });

  it("does not invent an empty heading for a project already shown", () => {
    const rows = buckets(tasks, [], "self", ["/Work/Alpha/"], "archived");
    expect(rows.map((bucket) => bucket.key)).toEqual(["/work/alpha"]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["a"]);
  });
});

describe("a conversation archived on its own", () => {
  const putAway = task({ id: "put-away", cwd: "/work/alpha", created_at: 10, archived_at: 99 });
  const neighbour = task({ id: "sibling", cwd: "/work/alpha", created_at: 20 });

  it("leaves the list without taking its project with it", () => {
    // Archiving a project hides every chat under a heading; archiving one
    // conversation hides that row only. The row's own flag answers first.
    const rows = buckets([putAway, neighbour]);
    expect(rows.map((bucket) => bucket.key)).toEqual(["/work/alpha"]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["sibling"]);
  });

  it("appears in the archive view even though its project is still filed", () => {
    const rows = buckets([putAway, neighbour], [], "self", [], "archived");
    expect(rows.map((bucket) => bucket.key)).toEqual(["/work/alpha"]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["put-away"]);
  });

  it("stays out of the list when its project is archived too, and shows under it in the archive", () => {
    const rows = buckets([putAway], [], "self", ["/work/alpha"], "active");
    expect(rows).toEqual([]);
    const archived = buckets([putAway], [], "self", ["/work/alpha"], "archived");
    expect(archived[0]!.rows.map((row) => row.key)).toEqual(["put-away"]);
  });

  it("never files an imported agent session under the archive", () => {
    // Only Kin's own tasks carry the flag; an imported session in the same
    // project stays on the live side while its neighbour is put away.
    const rows = buckets(
      [putAway],
      [session({ id: "s1", cwd: "/work/alpha", updated_at: 40 })],
      "self",
      [],
      "active",
    );
    expect(rows.map((bucket) => bucket.key)).toEqual(["/work/alpha"]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["s1"]);
  });
});

describe("archivedCwdFor", () => {
  it("returns the stored entry, not the bucket's normalized key", () => {
    // Restoring has to remove the entry as stored: `unarchiveProject` matches
    // on the string in the list, and the bucket key is lower-cased and stripped.
    expect(archivedCwdFor("/work/alpha", ["/Work/Alpha/"])).toBe("/Work/Alpha/");
  });

  it("maps the no-project bucket back to the sidebar's sentinel", () => {
    expect(archivedCwdFor(UNASSIGNED_PROJECT, ["/work/a", "__root__"])).toBe("__root__");
  });

  it("returns undefined for a bucket that is not archived", () => {
    expect(archivedCwdFor("/work/gamma", ["/work/alpha"])).toBeUndefined();
  });

  it("never returns an empty entry", () => {
    // An empty string would match the no-project bucket, but restoring it
    // would be a silent no-op: the button would appear to work and change
    // nothing.
    expect(archivedCwdFor(UNASSIGNED_PROJECT, ["", "__root__"])).toBe("__root__");
    expect(archivedCwdFor(UNASSIGNED_PROJECT, [""])).toBeUndefined();
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

  it("matches the task prompt when the title does not carry the word", () => {
    // The daemon searches the prompt too. If this filter cannot see it, a
    // server match disappears the moment the answer is narrowed again — the
    // row flashes in and then the page says nothing matched.
    const rows = buckets([
      task({
        id: "a",
        cwd: "/work/a",
        created_at: 1,
        title: "Refactor auth",
        prompt: "fix the login redirect",
      }),
      task({ id: "b", cwd: "/work/a", created_at: 2, title: "Write docs", prompt: "unrelated" }),
    ]);
    const filtered = filterProjectBuckets(rows, "login");
    expect(filtered.flatMap((bucket) => bucket.rows.map((row) => row.key))).toEqual(["a"]);
  });

  it("matches a session's own cwd even when the heading shows only its tail", () => {
    const rows = buckets(
      [],
      [session({ id: "s1", cwd: "/srv/zeta/alpha", title: "session", updated_at: 1 })],
    );
    const filtered = filterProjectBuckets(rows, "zeta");
    expect(filtered.flatMap((bucket) => bucket.rows.map((row) => row.key))).toEqual(["s1"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(filterProjectBuckets(rows, "  PARSER ")).toHaveLength(1);
  });

  it("returns everything for an empty query", () => {
    expect(filterProjectBuckets(rows, "   ")).toHaveLength(2);
  });
});

describe("withPinnedBucket", () => {
  it("lifts pinned task rows into a leading bucket and out of their projects", () => {
    const pinned = task({ id: "t1", cwd: "/a", created_at: 1 });
    const loose = task({ id: "t2", cwd: "/b", created_at: 1 });
    const buckets = [
      {
        key: "b0",
        label: "B0",
        lastActivityAt: 0,
        rows: [
          { key: "t1", at: 3, title: "Pinned one", agentId: "kin", remote: false, task: pinned },
          { key: "t2", at: 3, title: "Loose one", agentId: "kin", remote: false, task: loose },
        ],
      },
      {
        key: "b1",
        label: "B1",
        lastActivityAt: 0,
        rows: [
          {
            key: "t3",
            at: 3,
            title: "Another",
            agentId: "kin",
            remote: false,
            task: task({ id: "t3", cwd: "/c", created_at: 1 }),
          },
        ],
      },
    ];
    const out = withPinnedBucket(buckets, new Set(["t1"]), "置顶");
    expect(out.length).toBe(3);
    expect(out[0]!.key).toBe(PINNED_BUCKET);
    expect(out[0]!.rows.map((r) => r.key)).toEqual(["t1"]);
    // Both project buckets survive, each without the lifted row.
    expect(out[1]!.rows.map((r) => r.key)).toEqual(["t2"]);
    expect(out[2]!.rows.map((r) => r.key)).toEqual(["t3"]);
  });

  it("returns the buckets untouched when nothing is pinned", () => {
    const buckets = [
      {
        key: "b0",
        label: "B0",
        lastActivityAt: 0,
        rows: [
          {
            key: "t1",
            at: 3,
            title: "A",
            agentId: "kin",
            remote: false,
            task: task({ id: "t1", cwd: "/a", created_at: 1 }),
          },
        ],
      },
    ];
    const out = withPinnedBucket(buckets, new Set(), "置顶");
    expect(out.length).toBe(1);
    expect(out[0]!.key).toBe("b0");
    expect(out[0]!.rows.map((r) => r.key)).toEqual(["t1"]);
  });

  it("does not lift imported agent sessions (they have no task id)", () => {
    const sessionRow = {
      key: "s1",
      at: 1,
      title: "imported",
      agentId: "claude",
      remote: false,
      session: { id: "s1", cwd: "/x" } as AgentSession,
    };
    const out = withPinnedBucket(
      [{ key: "b0", label: "B0", lastActivityAt: 0, rows: [sessionRow] }],
      new Set(["s1"]),
      "置顶",
    );
    expect(out.length).toBe(1);
    expect(out[0]!.rows.map((r) => r.key)).toEqual(["s1"]);
  });
});
