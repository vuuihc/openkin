import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, Task } from "../api/client";
import type { Machine } from "./devices";
import { groupByDevice, projectKey } from "./deviceSidebar";

const store = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
});

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

function machine(partial: Partial<Machine> & Pick<Machine, "id">): Machine {
  return {
    label: partial.id,
    isSelf: false,
    online: true,
    roots: [],
    agents: [],
    ...partial,
  };
}

const prefs = { sortMode: "active" as const, pinned: [], archived: [], lastInteracted: {} };

const self = machine({ id: "mac-1", label: "MacBook Pro", isSelf: true });
const nas = machine({ id: "nas-1", label: "nas" });
const sleeping = machine({ id: "air-1", label: "macbook-air", online: false });
const machines = [self, nas, sleeping];

beforeEach(() => {
  store.clear();
});

describe("projectKey", () => {
  it("folds case and trailing slashes so one project is one row", () => {
    expect(projectKey("/Users/me/App/")).toBe(projectKey("/users/me/app"));
    expect(projectKey("")).toBe("__unassigned__");
  });
});

describe("groupByDevice", () => {
  it("splits sessions by the machine that runs them, this machine first", () => {
    const tasks = [
      task({ id: "here", cwd: "/work/app", created_at: 100 }),
      task({ id: "there", cwd: "/srv/app", created_at: 100, executing_device_id: "nas-1" }),
    ];
    const groups = groupByDevice(tasks, [], machines, prefs);
    expect(groups.map((g) => g.id)).toEqual(["mac-1", "nas-1"]);
    expect(groups[0]!.isSelf).toBe(true);
    expect(groups[0]!.projects.map((p) => p.cwd)).toEqual(["/work/app"]);
    expect(groups[1]!.projects.map((p) => p.cwd)).toEqual(["/srv/app"]);
  });

  it("attributes a task with no device to this machine", () => {
    // A standalone daemon writes no executing_device_id; there was only ever
    // one machine, so it cannot mean "unknown".
    const groups = groupByDevice(
      [task({ id: "solo", cwd: "/work/app", created_at: 1 })],
      [],
      machines,
      prefs,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("mac-1");
  });

  it("puts imported sessions on their own machine, not this one", () => {
    const groups = groupByDevice(
      [],
      [session({ id: "s1", cwd: "/srv/other", device_id: "nas-1" })],
      machines,
      prefs,
    );
    expect(groups.map((g) => g.id)).toEqual(["nas-1"]);
    expect(groups[0]!.sessions).toHaveLength(1);
  });

  it("shows no machine at all when the console has nothing", () => {
    expect(groupByDevice([], [], machines, prefs)).toEqual([]);
  });

  it("leaves out machines that hold nothing", () => {
    const groups = groupByDevice(
      [task({ id: "here", cwd: "/work/app", created_at: 1 })],
      [],
      machines,
      prefs,
    );
    expect(groups.map((g) => g.id)).not.toContain("nas-1");
    expect(groups.map((g) => g.id)).not.toContain("air-1");
  });

  it("sorts online machines before offline ones, whatever the recency", () => {
    const tasks = [
      task({ id: "old", cwd: "/a", created_at: 10, executing_device_id: "nas-1" }),
      task({ id: "new", cwd: "/b", created_at: 500, executing_device_id: "air-1" }),
    ];
    const groups = groupByDevice(tasks, [], machines, prefs);
    // The reachable machine outranks the sleeping one: recency never promotes a
    // machine nobody can send work to.
    expect(groups.map((g) => g.id)).toEqual(["nas-1", "air-1"]);
  });

  it("marks a machine it cannot describe as offline and names it by id", () => {
    const groups = groupByDevice(
      [task({ id: "gone", cwd: "/a", created_at: 1, executing_device_id: "old-box" })],
      [],
      machines,
      prefs,
    );
    const group = groups.find((g) => g.id === "old-box")!;
    expect(group.online).toBe(false);
    expect(group.label).toBe("old-box");
  });

  it("keeps imported sessions out of the project tree", () => {
    // An import has no status, pin or archive of its own; giving it a project
    // heading would invent one. It is listed once, at the device's end — even
    // when it shares a cwd with a real project.
    const tasks = [task({ id: "t", cwd: "/work/app", created_at: 1, finished_at: 1 })];
    const sessions = [
      session({ id: "s1", cwd: "/work/app", updated_at: 1 }),
      session({ id: "s2", cwd: "/work/other", updated_at: 900 }),
    ];
    const groups = groupByDevice(tasks, sessions, machines, prefs);
    expect(groups[0]!.projects.map((p) => p.cwd)).toEqual(["/work/app"]);
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    // The device still reads as recently used: imports count for the machine's
    // own recency, which is what orders the machine list.
    expect(groups[0]!.lastActivityAt).toBe(900);
  });

  it("counts tasks and imported sessions for the group badge", () => {
    const groups = groupByDevice(
      [task({ id: "t", cwd: "/work/app", created_at: 1 })],
      [session({ id: "s", cwd: "/work/app" })],
      machines,
      prefs,
    );
    expect(groups[0]!.count).toBe(2);
  });

  it("moves archived projects and their sessions into the archived view only", () => {
    const tasks = [
      task({ id: "live", cwd: "/work/live", created_at: 1 }),
      task({ id: "old", cwd: "/work/old", created_at: 2 }),
    ];
    const sessions = [
      session({ id: "s-live", cwd: "/work/live" }),
      session({ id: "s-old", cwd: "/work/old" }),
    ];
    const archivedPrefs = { ...prefs, archived: ["/work/old"] };

    const live = groupByDevice(tasks, sessions, machines, archivedPrefs);
    expect(live[0]!.projects.map((p) => p.cwd)).toEqual(["/work/live"]);
    expect(live[0]!.sessions.map((s) => s.id)).toEqual(["s-live"]);

    const archived = groupByDevice(tasks, sessions, machines, archivedPrefs, true);
    expect(archived[0]!.projects.map((p) => p.cwd)).toEqual(["/work/old"]);
    expect(archived[0]!.sessions.map((s) => s.id)).toEqual(["s-old"]);
  });

  it("drops a machine whose only project is archived", () => {
    const tasks = [
      task({ id: "old", cwd: "/srv/old", created_at: 1, executing_device_id: "nas-1" }),
    ];
    const groups = groupByDevice(tasks, [], machines, { ...prefs, archived: ["/srv/old"] });
    expect(groups).toEqual([]);
  });

  it("folds ids it cannot describe into this machine while the list loads", () => {
    // Otherwise a reload draws a "nas-1" heading with a grey dot and renames it
    // to "nas" one render later.
    const only = [{ ...machine({ id: "", label: "", isSelf: true }), id: "" }];
    const tasks = [task({ id: "t", cwd: "/srv/app", created_at: 1, executing_device_id: "nas-1" })];
    const groups = groupByDevice(tasks, [], only, prefs, false, true);
    expect(groups.map((g) => g.id)).toEqual([""]);
    expect(groups[0]!.isSelf).toBe(true);
  });

  it("folds an imported session's unknown machine the same way", () => {
    // The tasks and the sessions take separate branches to the same bucket; the
    // session half is inert until cross-device session sync lands, which is
    // exactly why it needs a test rather than a reader.
    const only = [{ ...machine({ id: "", label: "", isSelf: true }), id: "" }];
    const groups = groupByDevice(
      [],
      [session({ id: "s", cwd: "/srv/app", device_id: "nas-1" })],
      only,
      prefs,
      false,
      true,
    );
    expect(groups.map((g) => g.id)).toEqual([""]);
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(["s"]);
  });

  it("keeps a raw id once the list is in, so a revoked machine is still named", () => {
    const tasks = [task({ id: "t", cwd: "/srv/app", created_at: 1, executing_device_id: "nas-1" })];
    const groups = groupByDevice(tasks, [], machines, prefs, false, false);
    expect(groups.map((g) => g.id)).toEqual(["nas-1"]);
    expect(groups[0]!.label).toBe("nas");
  });

  it("counts only the rows the section lists, in both passes", () => {
    // The archived pass sees every task on the machine; a badge counting them
    // all would sit over a one-row section.
    const tasks = [
      task({ id: "a", cwd: "/work/live", created_at: 1 }),
      task({ id: "b", cwd: "/work/live", created_at: 2 }),
      task({ id: "c", cwd: "/work/old", created_at: 3 }),
    ];
    const archivedPrefs = { ...prefs, archived: ["/work/old"] };
    expect(groupByDevice(tasks, [], machines, archivedPrefs)[0]!.count).toBe(2);
    expect(groupByDevice(tasks, [], machines, archivedPrefs, true)[0]!.count).toBe(1);
  });

  it("keeps an archived project's heading when only imports still name it", () => {
    // Its tasks fell outside the loaded page (or were deleted), so the task
    // feed has nothing to group. Restore lives on that heading: without it the
    // project would be archived with no way back from the Mac.
    const archivedPrefs = { ...prefs, archived: ["/work/gone"] };
    const groups = groupByDevice(
      [],
      [
        session({
          id: "s",
          cwd: "/work/gone",
          updated_at: 7,
          project_label: "Gone Project",
        }),
      ],
      machines,
      archivedPrefs,
      true,
    );
    expect(groups.map((group) => group.id)).toEqual(["mac-1"]);
    expect(groups[0]!.projects.map((project) => project.cwd)).toEqual(["/work/gone"]);
    expect(groups[0]!.projects[0]!.label).toBe("Gone Project");
    expect(groups[0]!.projects[0]!.items).toEqual([]);
    expect(groups[0]!.projects[0]!.archived).toBe(true);
    // ...and the live list still does not grow a project from the import.
    const live = groupByDevice([], [session({ id: "s", cwd: "/work/gone" })], machines, prefs);
    expect(live[0]!.projects).toEqual([]);
  });

  it("sorts seeded archived projects with the rest, not in import order", () => {
    // The seeds are appended after grouping, so an unsorted tail would put an
    // older project above a newer one whenever the import feed is not itself
    // in that order.
    const archivedPrefs = { ...prefs, archived: ["/work/a", "/work/b"] };
    const groups = groupByDevice(
      [],
      [
        session({ id: "sa", cwd: "/work/a", updated_at: 100 }),
        session({ id: "sb", cwd: "/work/b", updated_at: 200 }),
      ],
      machines,
      archivedPrefs,
      true,
    );
    expect(groups[0]!.projects.map((project) => project.cwd)).toEqual(["/work/b", "/work/a"]);
  });

  it("never invents an archived project from an import in an unarchived cwd", () => {
    const archivedPrefs = { ...prefs, archived: ["/work/other"] };
    const groups = groupByDevice(
      [],
      [session({ id: "s", cwd: "/work/live", updated_at: 7 })],
      machines,
      archivedPrefs,
      true,
    );
    expect(groups).toEqual([]);
  });

  it("never invents a project from an imported session, pinned or not", () => {
    const pinned = { ...prefs, pinned: ["/work/other"] };
    const groups = groupByDevice([], [session({ id: "s", cwd: "/work/other" })], machines, pinned);
    expect(groups[0]!.projects).toEqual([]);
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(["s"]);
  });
});

// KIN-CONTINUE-001: the device name is always shown, even when this machine is
// the only one. The sidebar renders one heading per group, so the grouping
// must keep the lone self machine as a group instead of flattening it away.
describe("device grouping", () => {
  it("keeps the only machine as a group, so it still has a name to show", () => {
    const groups = groupByDevice(
      [task({ id: "t", cwd: "/work/app", created_at: 1 })],
      [],
      machines,
      prefs,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isSelf).toBe(true);
    expect(groups[0]!.id).toBe("mac-1");
  });

  it("does not count a machine twice when it has archived rows too", () => {
    // The bug this replaced: `groups.length + archivedGroups.length > 1` made a
    // single-machine console grow a second heading the moment anything was
    // archived.
    const tasks = [
      task({ id: "live", cwd: "/work/live", created_at: 1 }),
      task({ id: "old", cwd: "/work/old", created_at: 2 }),
    ];
    const archivedPrefs = { ...prefs, archived: ["/work/old"] };
    const live = groupByDevice(tasks, [], machines, archivedPrefs);
    const archived = groupByDevice(tasks, [], machines, archivedPrefs, true);
    expect(new Set([...live, ...archived].map((group) => group.id)).size).toBe(1);
  });

  it("gives each machine its own group, this machine first", () => {
    const groups = groupByDevice(
      [
        task({ id: "there", cwd: "/srv/app", created_at: 1, executing_device_id: "nas-1" }),
        task({ id: "here", cwd: "/work/app", created_at: 1 }),
      ],
      [],
      machines,
      prefs,
    );
    expect(groups.map((group) => group.id)).toEqual(["mac-1", "nas-1"]);
  });

  it("names the machine when every session runs somewhere else", () => {
    // A Hub whose only work ran on a paired laptop: one machine on screen, but
    // not this one, so grouping by the executing device is the only way to say
    // where the work actually ran.
    const groups = groupByDevice(
      [task({ id: "there", cwd: "/srv/app", created_at: 1, executing_device_id: "nas-1" })],
      [],
      machines,
      prefs,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("nas-1");
    expect(groups[0]!.isSelf).toBe(false);
  });
});
