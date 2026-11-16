import { describe, expect, it } from "vitest";
import type { AgentSession, Task } from "../api/client";
import {
  archivedCwdFor,
  filterProjectBuckets,
  groupProjectBucketsByDevice,
  IMPORTED_BUCKET_PREFIX,
  isBucketCollapsed,
  isImportedBucket,
  PINNED_BUCKET,
  pinnedRowDeviceName,
  withPinnedBucket,
  phoneProjectBuckets,
  type PhoneBucketScope,
  UNASSIGNED_PROJECT,
} from "./phoneSessionBuckets";
import type { Machine } from "./devices";

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

const COPY = { untitled: "Untitled", noProject: "No project", imported: "Imported sessions" };

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
  it("groups tasks by project and keeps imports in one trailing group", () => {
    const rows = buckets(
      [
        task({ id: "a", cwd: "/work/alpha", created_at: 10 }),
        task({ id: "b", cwd: "/work/alpha/", created_at: 20 }),
        task({ id: "c", cwd: "/work/beta", created_at: 30 }),
      ],
      [session({ id: "s1", cwd: "/work/alpha", updated_at: 40 })],
    );
    // The import shares alpha's cwd but is not a project: it is the machine's
    // trailing shelf, even though it is the newest row on the page.
    expect(rows.map((bucket) => bucket.label)).toEqual(["beta", "alpha", "Imported sessions"]);
    const alpha = rows.find((bucket) => bucket.key === "/work/alpha")!;
    // The trailing slash is the same project.
    expect(alpha.rows.map((row) => row.key)).toEqual(["b", "a"]);
    const imported = rows.find((bucket) => isImportedBucket(bucket.key))!;
    expect(imported.key).toBe(IMPORTED_BUCKET_PREFIX + "self");
    expect(imported.rows.map((row) => row.key)).toEqual(["s1"]);
  });

  it("gives each machine its own imported group", () => {
    const rows = buckets(
      [],
      [
        session({ id: "s-here", cwd: "/work/a", updated_at: 1 }),
        session({ id: "s-here-2", cwd: "/work/b", updated_at: 2 }),
        session({ id: "s-there", cwd: "/work/c", updated_at: 3, device_id: "other" }),
      ],
    );
    const byKey = new Map(
      rows.filter((bucket) => isImportedBucket(bucket.key)).map((bucket) => [bucket.key, bucket]),
    );
    expect(byKey.get(IMPORTED_BUCKET_PREFIX + "self")!.rows.map((row) => row.key)).toEqual([
      "s-here-2",
      "s-here",
    ]);
    expect(byKey.get(IMPORTED_BUCKET_PREFIX + "other")!.rows.map((row) => row.key)).toEqual([
      "s-there",
    ]);
  });

  it("orders by newest activity and puts the no-project bucket last", () => {
    const rows = buckets([
      task({ id: "old", cwd: "/work/old", created_at: 10 }),
      task({ id: "new", cwd: "/work/new", created_at: 90 }),
      task({ id: "loose", cwd: "", created_at: 100 }),
    ]);
    expect(rows.map((bucket) => bucket.key)).toEqual([
      "/work/new",
      "/work/old",
      UNASSIGNED_PROJECT,
    ]);
    expect(rows[2]!.label).toBe("No project");
  });

  // The question a project group answers first is "what needs me?", not "what
  // did I last touch?". A row that stops work outranks a row that merely
  // finished later; inside each rank the list stays newest-first.
  it("puts a conversation that needs you above a newer finished one in the same project", () => {
    const rows = buckets([
      task({ id: "needs", cwd: "/work/alpha", created_at: 10, status: "waiting_approval" }),
      task({ id: "done", cwd: "/work/alpha", created_at: 50, status: "succeeded" }),
    ]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["needs", "done"]);
  });

  it("orders needs-you first, then running, then the rest, newest first within a rank", () => {
    const rows = buckets([
      task({ id: "done", cwd: "/work/alpha", created_at: 90, status: "succeeded" }),
      task({ id: "run-60", cwd: "/work/alpha", created_at: 60, status: "running" }),
      task({ id: "run-80", cwd: "/work/alpha", created_at: 80, status: "running" }),
      task({ id: "wait", cwd: "/work/alpha", created_at: 20, status: "waiting_input" }),
    ]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["wait", "run-80", "run-60", "done"]);
  });

  it("treats waiting_approval and waiting_input as the same rank", () => {
    const rows = buckets([
      task({ id: "approve", cwd: "/work/alpha", created_at: 10, status: "waiting_approval" }),
      task({ id: "input", cwd: "/work/alpha", created_at: 40, status: "waiting_input" }),
      task({ id: "busy", cwd: "/work/alpha", created_at: 90, status: "running" }),
    ]);
    // Both waiting rows sit above a newer running one, newest-first among them.
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["input", "approve", "busy"]);
  });

  it("treats queued and retrying as running", () => {
    const rows = buckets([
      task({ id: "queued", cwd: "/work/alpha", created_at: 10, status: "queued" }),
      task({ id: "retrying", cwd: "/work/alpha", created_at: 30, status: "retrying" }),
      task({ id: "wait", cwd: "/work/alpha", created_at: 5, status: "waiting_approval" }),
      task({ id: "done", cwd: "/work/alpha", created_at: 90, status: "succeeded" }),
    ]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["wait", "retrying", "queued", "done"]);
  });

  it("keeps newest-first order inside a project when nothing is running or waiting", () => {
    const rows = buckets([
      task({ id: "old", cwd: "/work/alpha", created_at: 10, status: "succeeded" }),
      task({ id: "new", cwd: "/work/alpha", created_at: 30, status: "failed" }),
      task({ id: "middle", cwd: "/work/alpha", created_at: 20, status: "canceled" }),
    ]);
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["new", "middle", "old"]);
  });

  it("lifts pinned rows in the same attention order", () => {
    // A pin is not a place, but the attention rule still applies: the pinned
    // section inherits the group's order on purpose.
    const out = withPinnedBucket(
      buckets([
        task({ id: "finished", cwd: "/work/alpha", created_at: 90, status: "succeeded" }),
        task({ id: "waiting", cwd: "/work/alpha", created_at: 10, status: "waiting_input" }),
      ]),
      new Set(["finished", "waiting"]),
      "Pinned",
    );
    expect(out[0]!.key).toBe(PINNED_BUCKET);
    expect(out[0]!.rows.map((row) => row.key)).toEqual(["waiting", "finished"]);
  });

  it("applies the same rule in the archived scope", () => {
    const rows = buckets(
      [
        task({ id: "waiting", cwd: "/work/alpha", created_at: 10, status: "waiting_input" }),
        task({ id: "finished", cwd: "/work/alpha", created_at: 90, status: "succeeded" }),
      ],
      [],
      "self",
      ["/work/alpha"],
      "archived",
    );
    expect(rows[0]!.rows.map((row) => row.key)).toEqual(["waiting", "finished"]);
  });

  // The task feed and the imported feed describe the same provider sessions
  // from two sides: a task that ran on a machine and the catalog row that
  // machine imported for it. Matching them here is what keeps one real
  // conversation from taking two rows on the phone.
  describe("one conversation named by both feeds", () => {
    // An import that is not the same conversation still appears — in its own
    // trailing group, never under the project heading it shares a cwd with.
    const importedKeys = (rows: ReturnType<typeof buckets>) =>
      rows
        .filter((bucket) => isImportedBucket(bucket.key))
        .flatMap((bucket) => bucket.rows.map((row) => row.key));
    const projectKeys = (rows: ReturnType<typeof buckets>, key = "/work/alpha") =>
      rows.find((bucket) => bucket.key === key)?.rows.map((row) => row.key) ?? [];

    const phoneTask = task({
      id: "task-1",
      cwd: "/work/alpha",
      created_at: 10,
      title: "Plan the trip",
      session_ref: "sess-1",
      session_ref_device_id: "node-a",
    });

    it("keeps the task row and drops the imported copy", () => {
      const rows = buckets(
        [phoneTask],
        [
          session({
            id: "imported-1",
            cwd: "/work/alpha",
            updated_at: 99,
            // The imported title drifts; identity is the ref, not the title.
            title: "A different title",
            external_ref: "sess-1",
            device_id: "node-a",
          }),
        ],
      );
      expect(projectKeys(rows)).toEqual(["task-1"]);
      expect(importedKeys(rows)).toEqual([]);
    });

    it("keeps the imported row when no task names its conversation", () => {
      const rows = buckets(
        [phoneTask],
        [
          session({
            id: "imported-1",
            cwd: "/work/alpha",
            updated_at: 20,
            external_ref: "sess-2",
            device_id: "node-a",
          }),
        ],
      );
      expect(projectKeys(rows)).toEqual(["task-1"]);
      expect(importedKeys(rows)).toEqual(["imported-1"]);
    });

    it("does not merge the same ref from another machine", () => {
      // ADR 0022 D7: a ref is only meaningful on the machine that made it.
      const rows = buckets(
        [phoneTask],
        [
          session({
            id: "imported-1",
            cwd: "/work/alpha",
            updated_at: 20,
            external_ref: "sess-1",
            device_id: "node-b",
          }),
        ],
      );
      expect(projectKeys(rows)).toEqual(["task-1"]);
      expect(importedKeys(rows)).toEqual(["imported-1"]);
    });

    it("does not merge a different ref on the same machine", () => {
      const rows = buckets(
        [phoneTask],
        [
          session({
            id: "imported-1",
            cwd: "/work/alpha",
            updated_at: 20,
            external_ref: "sess-2",
            device_id: "node-a",
          }),
        ],
      );
      expect(projectKeys(rows)).toEqual(["task-1"]);
      expect(importedKeys(rows)).toEqual(["imported-1"]);
    });

    it("never merges on a shared title alone", () => {
      const rows = buckets(
        [phoneTask],
        [
          session({
            id: "imported-1",
            cwd: "/work/alpha",
            updated_at: 20,
            title: "Plan the trip",
            external_ref: "sess-2",
            device_id: "node-a",
          }),
        ],
      );
      expect(projectKeys(rows)).toEqual(["task-1"]);
      expect(importedKeys(rows)).toEqual(["imported-1"]);
    });

    it("reads an empty device as this machine on both sides", () => {
      const legacyTask = task({
        id: "task-1",
        cwd: "/work/alpha",
        created_at: 10,
        session_ref: " sess-1 ",
      });
      const rows = buckets(
        [legacyTask],
        [
          session({
            id: "imported-1",
            cwd: "/work/alpha",
            updated_at: 20,
            external_ref: "sess-1",
            device_id: "self",
          }),
        ],
      );
      expect(rows.flatMap((bucket) => bucket.rows.map((row) => row.key))).toEqual(["task-1"]);
    });

    it("does not let a blank ref claim every imported row", () => {
      const rows = buckets(
        [task({ id: "task-1", cwd: "/work/alpha", created_at: 10, session_ref: "   " })],
        [session({ id: "imported-1", cwd: "/work/alpha", updated_at: 20, external_ref: "" })],
      );
      expect(projectKeys(rows)).toEqual(["task-1"]);
      expect(importedKeys(rows)).toEqual(["imported-1"]);
    });
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

describe("isBucketCollapsed", () => {
  const none = new Set<string>();

  it("folds an imported group until the reader opens it", () => {
    const base = {
      imported: true,
      stateKey: "imported\u0000mac",
      searching: false,
      collapsed: none,
    };
    expect(isBucketCollapsed({ ...base, openImported: none })).toBe(true);
    expect(isBucketCollapsed({ ...base, openImported: new Set([base.stateKey]) })).toBe(false);
  });

  it("reads a project's fold from the stored set, not the open set", () => {
    const base = { imported: false, stateKey: "/work/alpha", searching: false, openImported: none };
    expect(isBucketCollapsed({ ...base, collapsed: none })).toBe(false);
    expect(isBucketCollapsed({ ...base, collapsed: new Set([base.stateKey]) })).toBe(true);
    // The two sets mean opposite things; an imported key in the open set must
    // not make a project with the same key look folded or open.
    expect(
      isBucketCollapsed({ ...base, collapsed: none, openImported: new Set([base.stateKey]) }),
    ).toBe(false);
  });

  it("opens every bucket while searching", () => {
    expect(
      isBucketCollapsed({
        imported: true,
        stateKey: "imported\u0000mac",
        searching: true,
        collapsed: none,
        openImported: none,
      }),
    ).toBe(false);
    expect(
      isBucketCollapsed({
        imported: false,
        stateKey: "/work/alpha",
        searching: true,
        collapsed: new Set(["/work/alpha"]),
        openImported: none,
      }),
    ).toBe(false);
  });
});

describe("archive state belongs to the machine that owns the path", () => {
  const shared = [
    task({ id: "local", cwd: "/work/shared", created_at: 10 }),
    task({ id: "remote", cwd: "/work/shared", created_at: 20, executing_device_id: "nas" }),
  ];

  it("archives only this machine's copy of a path two machines share", () => {
    // The stored archive list has no device column: it is this machine's
    // preference. The NAS's /work/shared is a different project on a different
    // filesystem, so archiving here must leave it on screen.
    const active = buckets(shared, [], "self", ["/work/shared"], "active");
    const sharedActive = active.find((bucket) => bucket.key === "/work/shared")!;
    expect(sharedActive.rows.map((row) => row.key)).toEqual(["remote"]);

    const archived = buckets(shared, [], "self", ["/work/shared"], "archived");
    const sharedArchived = archived.find((bucket) => bucket.key === "/work/shared")!;
    expect(sharedArchived.rows.map((row) => row.key)).toEqual(["local"]);
  });

  it("keeps a remote imported session out of the local archive", () => {
    const sessions = [
      session({ id: "local-s", cwd: "/work/shared", updated_at: 1 }),
      session({ id: "remote-s", cwd: "/work/shared", updated_at: 2, device_id: "nas" }),
    ];
    const active = buckets([], sessions, "self", ["/work/shared"], "active");
    const imported = active.find((bucket) => isImportedBucket(bucket.key))!;
    expect(imported.rows.map((row) => row.key)).toEqual(["remote-s"]);

    const archived = buckets([], sessions, "self", ["/work/shared"], "archived");
    const importedArchived = archived.find((bucket) => isImportedBucket(bucket.key))!;
    expect(importedArchived.rows.map((row) => row.key)).toEqual(["local-s"]);
  });

  it("still splits the surviving rows by machine after a local archive", () => {
    const active = groupProjectBucketsByDevice(
      buckets(shared, [], "self", ["/work/shared"], "active"),
      [
        { id: "self", label: "Here", isSelf: true, online: true },
        { id: "nas", label: "NAS", isSelf: false, online: true },
      ] as Machine[],
      "self",
    );
    const nas = active.find((group) => group.id === "nas")!;
    expect(nas.buckets.map((bucket) => bucket.key)).toEqual(["/work/shared"]);
    // This machine's heading is gone: its only conversation was archived.
    expect(active.find((group) => group.id === "self")).toBeUndefined();
  });

  it("keeps a remote archived conversation out of the local project's heading", () => {
    // The NAS archived one of its own conversations. The archive list is this
    // machine's, so the path it shares with a local project is not one fact:
    // the remote row must get its own bucket, and that bucket must never
    // answer for the local archive entry (which is what Restore removes).
    const remotePutAway = task({
      id: "remote-put-away",
      cwd: "/work/shared",
      created_at: 30,
      archived_at: 99,
      executing_device_id: "nas",
    });
    const rows = buckets([remotePutAway], [], "self", ["/work/shared"], "archived");
    const local = rows.find((bucket) => bucket.key === "/work/shared")!;
    const remote = rows.find((bucket) => bucket.key !== "/work/shared")!;
    expect(local.rows).toEqual([]);
    expect(archivedCwdFor(local.key, ["/work/shared"])).toBe("/work/shared");
    expect(remote.rows.map((row) => row.key)).toEqual(["remote-put-away"]);
    expect(archivedCwdFor(remote.key, ["/work/shared"])).toBeUndefined();
  });

  it("reads a named machine as remote when this machine cannot be identified", () => {
    // listMachines or serverVersion failed, so there is no self id. An explicit
    // device is then not proven local: the safe reading is remote, because the
    // archive entry is a local write and applying it to another filesystem is
    // the mistake that cannot be undone from this screen.
    const named = task({
      id: "named",
      cwd: "/work/shared",
      created_at: 10,
      executing_device_id: "nas",
    });
    const unnamed = task({ id: "unnamed", cwd: "/work/shared", created_at: 20 });
    const active = buckets([named, unnamed], [], "", ["/work/shared"], "active");
    expect(active.flatMap((bucket) => bucket.rows.map((row) => row.key))).toEqual(["named"]);
    const archived = buckets([named, unnamed], [], "", ["/work/shared"], "archived");
    expect(archived.flatMap((bucket) => bucket.rows.map((row) => row.key))).toEqual(["unnamed"]);
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
    expect(rows.map((bucket) => bucket.key)).toEqual([IMPORTED_BUCKET_PREFIX + "self"]);
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
        cwd: "/b",
        createdAt: 0,
        hasActiveTask: false,
        lastActivityAt: 0,
        rows: [
          { key: "t1", at: 3, title: "Pinned one", agentId: "kin", remote: false, task: pinned },
          { key: "t2", at: 3, title: "Loose one", agentId: "kin", remote: false, task: loose },
        ],
      },
      {
        key: "b1",
        label: "B1",
        cwd: "/b",
        createdAt: 0,
        hasActiveTask: false,
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
        cwd: "/b",
        createdAt: 0,
        hasActiveTask: false,
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

  it("keeps a project heading whose loaded page holds no rows", () => {
    // A project seeded from its record has no row in the loaded page. Dropping
    // it here would make the heading vanish the moment anything was pinned.
    const empty = {
      key: "/work/empty",
      label: "empty",
      cwd: "/work/empty",
      rows: [],
      lastActivityAt: 0,
      createdAt: 1,
      hasActiveTask: false,
    };
    const out = withPinnedBucket([empty], new Set(), "置顶");
    expect(out.map((b) => b.key)).toEqual(["/work/empty"]);
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
      [
        {
          key: "b0",
          label: "B0",
          cwd: "/b",
          createdAt: 0,
          hasActiveTask: false,
          lastActivityAt: 0,
          rows: [sessionRow],
        },
      ],
      new Set(["s1"]),
      "置顶",
    );
    expect(out.length).toBe(1);
    expect(out[0]!.rows.map((r) => r.key)).toEqual(["s1"]);
  });
});

// KIN-CONTINUE-001, step 1: pinning lifts a row out of its machine's heading,
// so the row itself has to say where it runs. Without this a pinned
// conversation worked on another machine reads as a local one.
describe("pinnedRowDeviceName", () => {
  const machines: Machine[] = [
    { id: "mac", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    { id: "nas", label: "Studio", isSelf: false, online: true, roots: [], agents: [] },
  ];
  const row = (remote: boolean, deviceId?: string) => ({
    key: "t1",
    at: 1,
    title: "Pinned one",
    agentId: "kin",
    remote,
    deviceId,
  });

  it("names the machine a pinned remote row runs on", () => {
    expect(pinnedRowDeviceName(PINNED_BUCKET, row(true, "nas"), machines)).toBe("Studio");
  });

  it("says nothing for a row still under its machine's heading", () => {
    expect(pinnedRowDeviceName("/work/alpha", row(true, "nas"), machines)).toBe("");
  });

  it("says nothing for a pinned row that runs here", () => {
    expect(pinnedRowDeviceName(PINNED_BUCKET, row(false, "mac"), machines)).toBe("");
    expect(pinnedRowDeviceName(PINNED_BUCKET, row(false), machines)).toBe("");
  });

  it("falls back to the id when the machine list does not know it", () => {
    // A machine that just went offline still names itself on its tasks; its
    // label is missing until the list answers again.
    expect(pinnedRowDeviceName(PINNED_BUCKET, row(true, "nas-2"), machines)).toBe("nas-2");
  });
});

// KIN-CONTINUE-001: the phone list is three levels — machine → project →
// conversation. Two machines with work each get their own heading, and the same
// project path on both is two histories, not one merged fold.
describe("groupProjectBucketsByDevice", () => {
  const machine = (id: string, label: string, isSelf = false): Machine => ({
    id,
    label,
    isSelf,
    online: true,
    roots: [],
    agents: [],
  });
  const machines = [machine("mac", "MacBook", true), machine("nas", "Studio")];

  it("puts each machine's projects under its own heading, this machine first", () => {
    const groups = groupProjectBucketsByDevice(
      buckets([
        task({ id: "here", cwd: "/work/alpha", created_at: 2 }),
        task({ id: "there", cwd: "/srv/beta", created_at: 3, executing_device_id: "nas" }),
      ]),
      machines,
      "mac",
    );

    expect(groups.map((group) => group.id)).toEqual(["mac", "nas"]);
    expect(groups[0]!.isSelf).toBe(true);
    expect(groups[0]!.buckets.map((bucket) => bucket.label)).toEqual(["alpha"]);
    expect(groups[0]!.buckets[0]!.rows.map((row) => row.key)).toEqual(["here"]);
    expect(groups[1]!.buckets.map((bucket) => bucket.label)).toEqual(["beta"]);
    expect(groups[1]!.buckets[0]!.rows.map((row) => row.key)).toEqual(["there"]);
  });

  it("keeps the same project on two machines as two histories", () => {
    const groups = groupProjectBucketsByDevice(
      buckets([
        task({ id: "local", cwd: "/work/shared", created_at: 1 }),
        task({ id: "remote", cwd: "/work/shared", created_at: 2, executing_device_id: "nas" }),
      ]),
      machines,
      "mac",
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]!.buckets[0]!.rows.map((row) => row.key)).toEqual(["local"]);
    expect(groups[1]!.buckets[0]!.rows.map((row) => row.key)).toEqual(["remote"]);
  });

  it("re-sorts each machine's projects after the split", () => {
    // The project with the remote row sorts first globally, but this machine's
    // copy of it is the oldest thing here. Its local bucket must fall below the
    // project this machine actually touched more recently.
    const groups = groupProjectBucketsByDevice(
      buckets([
        task({ id: "remote-new", cwd: "/srv/beta", created_at: 100, executing_device_id: "nas" }),
        task({ id: "local-old", cwd: "/srv/beta", created_at: 10 }),
        task({ id: "local-newer", cwd: "/work/gamma", created_at: 70 }),
      ]),
      machines,
      "mac",
    );

    expect(groups[0]!.buckets.map((bucket) => bucket.label)).toEqual(["gamma", "beta"]);
  });

  it("keeps a machine's imported group after its projects, whatever the recency", () => {
    const groups = groupProjectBucketsByDevice(
      buckets(
        [task({ id: "t", cwd: "/work/alpha", created_at: 100 })],
        [session({ id: "s", cwd: "/work/alpha", updated_at: 200, device_id: "mac" })],
      ),
      machines,
      "mac",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.buckets.map((bucket) => bucket.key)).toEqual([
      "/work/alpha",
      IMPORTED_BUCKET_PREFIX + "mac",
    ]);
  });

  it("leaves pinned rows to the page's own leading section", () => {
    const out = withPinnedBucket(
      buckets([
        task({ id: "pinned", cwd: "/work/alpha", created_at: 1 }),
        task({ id: "loose", cwd: "/work/alpha", created_at: 2 }),
      ]),
      new Set(["pinned"]),
      "Pinned",
    );
    const groups = groupProjectBucketsByDevice(out, machines, "mac");
    expect(groups.flatMap((group) => group.buckets.map((bucket) => bucket.key))).not.toContain(
      PINNED_BUCKET,
    );
  });
});
