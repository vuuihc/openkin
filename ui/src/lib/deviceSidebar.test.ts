import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, Task } from "../api/client";
import type { Machine } from "./devices";
import { groupByDevice, projectKey, sessionsForProject, showMachineLabels } from "./deviceSidebar";

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

  it("gives a session-only project its own row, ordered by its own recency", () => {
    const tasks = [task({ id: "t", cwd: "/work/app", created_at: 1, finished_at: 1 })];
    const sessions = [
      session({ id: "s1", cwd: "/work/app", updated_at: 1 }),
      // Touched later than any task here, so it belongs above /work/app.
      session({ id: "s2", cwd: "/work/other", updated_at: 900 }),
    ];
    const groups = groupByDevice(tasks, sessions, machines, prefs);
    expect(groups[0]!.projects.map((p) => p.cwd)).toEqual(["/work/other", "/work/app"]);
    const app = groups[0]!.projects.find((p) => p.cwd === "/work/app")!;
    expect(sessionsForProject(groups[0]!.sessions, app).map((s) => s.id)).toEqual(["s1"]);
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
    const tasks = [task({ id: "old", cwd: "/srv/old", created_at: 1, executing_device_id: "nas-1" })];
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

  it("carries the stored pin onto a row it invents for a session", () => {
    const pinned = { ...prefs, pinned: ["/work/other"] };
    const groups = groupByDevice(
      [],
      [session({ id: "s", cwd: "/work/other" })],
      machines,
      pinned,
    );
    // The row sorts to the pin tier, so it has to draw as pinned: the button
    // would otherwise offer to pin a project that already is.
    expect(groups[0]!.projects[0]!.pinned).toBe(true);
  });
});

describe("showMachineLabels", () => {
  it("stays quiet when the only machine is this one", () => {
    const groups = groupByDevice(
      [task({ id: "t", cwd: "/work/app", created_at: 1 })],
      [],
      machines,
      prefs,
    );
    expect(showMachineLabels(groups, [])).toBe(false);
  });

  it("does not count a machine twice when it has archived rows too", () => {
    // The bug this replaced: `groups.length + archivedGroups.length > 1` made a
    // single-machine console grow a machine heading the moment anything was
    // archived.
    const tasks = [
      task({ id: "live", cwd: "/work/live", created_at: 1 }),
      task({ id: "old", cwd: "/work/old", created_at: 2 }),
    ];
    const archivedPrefs = { ...prefs, archived: ["/work/old"] };
    const live = groupByDevice(tasks, [], machines, archivedPrefs);
    const archived = groupByDevice(tasks, [], machines, archivedPrefs, true);
    expect(showMachineLabels(live, archived)).toBe(false);
  });

  it("names the machine when there is more than one", () => {
    const groups = groupByDevice(
      [
        task({ id: "here", cwd: "/work/app", created_at: 1 }),
        task({ id: "there", cwd: "/srv/app", created_at: 1, executing_device_id: "nas-1" }),
      ],
      [],
      machines,
      prefs,
    );
    expect(showMachineLabels(groups, [])).toBe(true);
  });

  it("names the machine when every session runs somewhere else", () => {
    // A Hub whose only work ran on a paired laptop: one machine on screen, but
    // not this one, so staying silent hides where the work actually ran.
    const groups = groupByDevice(
      [task({ id: "there", cwd: "/srv/app", created_at: 1, executing_device_id: "nas-1" })],
      [],
      machines,
      prefs,
    );
    expect(showMachineLabels(groups, [])).toBe(true);
  });

  it("says nothing at all when the console is empty", () => {
    expect(showMachineLabels([], [])).toBe(false);
  });
});
