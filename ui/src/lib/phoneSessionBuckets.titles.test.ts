import { describe, expect, it } from "vitest";
import type { AgentSession, Task } from "../api/client";
import { filterProjectBuckets, isImportedBucket, phoneProjectBuckets } from "./phoneSessionBuckets";

/**
 * KIN-MANAGE-001, step 5: a local rename is the row's name everywhere the row
 * is drawn or searched.
 *
 * `phoneProjectBuckets` stays pure: the caller supplies the map and the tests
 * pass it directly, which is why this is a second small suite rather than more
 * rows in `phoneSessionBuckets.test.ts`.
 */
const COPY = { untitled: "Untitled", noProject: "No project", imported: "Imported sessions" };

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

function buckets(
  localTitles: Readonly<Record<string, string>> = {},
  sessions: readonly AgentSession[] = [],
) {
  return phoneProjectBuckets(
    [task({ id: "t1", cwd: "/work/alpha", created_at: 10, title: "Fix the build", prompt: "" })],
    sessions,
    "self",
    COPY,
    [],
    "active",
    () => undefined,
    undefined,
    localTitles,
  );
}

describe("a locally renamed row", () => {
  it("shows the new title", () => {
    const [alpha] = buckets({ t1: "Ship the build" });
    expect(alpha.rows[0]?.title).toBe("Ship the build");

    // With no override the composed title is unchanged.
    const [plain] = buckets();
    expect(plain.rows[0]?.title).toBe("Fix the build");
  });

  it("search matches the local title and no longer the old one", () => {
    const [alpha] = buckets({ t1: "Ship the build" });

    const byNewName = filterProjectBuckets([alpha], "ship the build");
    expect(byNewName.flatMap((bucket) => bucket.rows.map((row) => row.key))).toEqual(["t1"]);

    // The stored task title is no longer what the row shows, so the old name
    // must not keep answering the search.
    expect(filterProjectBuckets([alpha], "fix the build")).toEqual([]);
  });

  it("imported sessions keep their own title", () => {
    const imported = session({
      id: "s1",
      cwd: "/work/beta",
      title: "Imported chat",
      updated_at: 5,
    });
    // A map keyed by a colliding id belongs to a task, not to an imported
    // session: imports have no task id and their names come from the index.
    const bucketsWithImports = buckets({ s1: "Renamed import" }, [imported]);
    const shelf = bucketsWithImports.find((bucket) => isImportedBucket(bucket.key));
    expect(shelf?.rows[0]?.title).toBe("Imported chat");
  });
});
