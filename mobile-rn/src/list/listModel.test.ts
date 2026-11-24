import { describe, expect, it } from "@jest/globals";
import type { Task } from "../../../ui/src/api/contract";
import type { Machine } from "../../../ui/src/lib/devices";
import { t as realT } from "../i18n";
import {
  applyFolds,
  buildListGroups,
  createListController,
  createMemoryFoldStore,
  defaultOpenKeys,
  foldStateKey,
  LIST_TIMEOUT_MS,
  type DeviceGroup,
} from "./listModel";

/**
 * KIN-MOBILE-001 R3 — the conversation list's headless model.
 *
 * The fixture is the signed three-level shape: three machines, two projects on
 * two of them, twelve-plus conversations. No real hostnames, ids or tokens.
 */

function task(
  partial: Partial<Task> & Pick<Task, "id" | "cwd" | "created_at">,
): Task {
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

const MACHINES: Machine[] = [
  { id: "dev-a", label: "Laptop", isSelf: true, online: true, roots: [], agents: [] },
  { id: "dev-b", label: "Studio", isSelf: false, online: true, roots: [], agents: [] },
  { id: "dev-c", label: "Tablet", isSelf: false, online: false, roots: [], agents: [] },
];

/** 14 conversations: alpha is the newest, so its project is the open one. */
function fixture(): Task[] {
  const tasks: Task[] = [];
  const push = (
    id: string,
    cwd: string,
    at: number,
    device: string,
  ): void => {
    tasks.push(
      task({
        id,
        cwd,
        created_at: at,
        started_at: at,
        finished_at: at,
        title: `${id} title`,
        executing_device_id: device,
      }),
    );
  };
  push("a1", "/work/alpha", 1000, "dev-a");
  push("a2", "/work/alpha", 900, "dev-a");
  push("a3", "/work/alpha", 800, "dev-a");
  push("b1", "/work/beta", 700, "dev-a");
  push("b2", "/work/beta", 600, "dev-a");
  push("g1", "/work/gamma", 500, "dev-b");
  push("g2", "/work/gamma", 450, "dev-b");
  push("g3", "/work/gamma", 400, "dev-b");
  push("g4", "/work/gamma", 350, "dev-b");
  push("d1", "/work/delta", 300, "dev-b");
  push("d2", "/work/delta", 250, "dev-b");
  push("e1", "/work/epsilon", 200, "dev-c");
  push("e2", "/work/epsilon", 150, "dev-c");
  push("e3", "/work/epsilon", 100, "dev-c");
  return tasks;
}

const t = (key: string): string => key;
const formatTime = (at: number): string => `t${at}`;

function groupsOf(tasks: Task[] = fixture()): DeviceGroup[] {
  return buildListGroups(tasks, {
    selfDeviceId: "dev-a",
    machines: MACHINES,
    t,
    formatTime,
    pendingByTask: new Map([["a1", 2]]),
  });
}

function response(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as unknown as Response;
}

describe("KIN-MOBILE-001 R3 list model — grouping", () => {
  it("KIN-MOBILE-001 R3: groups device → project → conversation", () => {
    const groups = groupsOf();
    expect(groups.map((group) => group.label)).toEqual([
      "Laptop",
      "Studio",
      "Tablet",
    ]);
    const laptop = groups[0]!;
    expect(laptop.isSelf).toBe(true);
    expect(laptop.projects.map((project) => project.label)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(laptop.projects[0]!.rows.map((row) => row.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
    expect(laptop.count).toBe(5);
    expect(groups[1]!.projects.map((project) => project.label)).toEqual([
      "gamma",
      "delta",
    ]);
    expect(groups[2]!.online).toBe(false);
    expect(groups[2]!.projects[0]!.rows).toHaveLength(3);
  });

  it("KIN-MOBILE-001 R3: an unnamed device heads with the catalogue's own word", () => {
    // A device whose list has not loaded yet has neither a machine label nor
    // an id to fall back to. The heading must be a real catalogue word, not a
    // key path the reader would see as literal text.
    const groups = buildListGroups(
      [task({ id: "u1", cwd: "/work/alpha", created_at: 1 })],
      { selfDeviceId: "", t: realT, formatTime },
    );
    expect(groups).toHaveLength(1);
    expect(realT("nav.thisMachine")).not.toBe("nav.thisMachine");
    expect(groups[0]!.label).toBe(realT("nav.thisMachine"));
  });

  it("KIN-MOBILE-001 R3: carries title, relative time, status and pending count", () => {
    const row = groupsOf()[0]!.projects[0]!.rows[0]!;
    expect(row.title).toBe("a1 title");
    expect(row.timeLabel).toBe("t1000");
    expect(row.statusKey).toBe("sessions.statusSucceeded");
    expect(row.pending).toBe(2);
  });

  it("KIN-MOBILE-001 R3: opens only the newest conversation's project by default", () => {
    const groups = applyFolds(groupsOf(), createMemoryFoldStore());
    const open = groups.flatMap((group) =>
      group.projects
        .filter((project) => project.open)
        .map((project) => `${group.id}:${project.key}`),
    );
    expect(open).toEqual(["dev-a:/work/alpha"]);
    expect(defaultOpenKeys(groups)).toEqual(
      new Set([foldStateKey("dev-a", "/work/alpha")]),
    );
  });

  it("KIN-MOBILE-001 R3: a stored fold wins over the default", () => {
    const store = createMemoryFoldStore({
      [foldStateKey("dev-a", "/work/alpha")]: false,
      [foldStateKey("dev-a", "/work/beta")]: true,
    });
    const groups = applyFolds(groupsOf(), store);
    const laptop = groups[0]!;
    // The default opened alpha; a stored close beats it. Beta was folded by
    // default; a stored open beats that.
    expect(laptop.projects[0]!.open).toBe(false);
    expect(laptop.projects[1]!.open).toBe(true);
  });
});

describe("KIN-MOBILE-001 R3 list model — request state", () => {
  it("KIN-MOBILE-001 R3: a late answer from an older generation is ignored", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const answers = [first.promise, second.promise];
    let call = 0;
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: (() => answers[call++]!) as unknown as typeof fetch,
    });

    const older = controller.load();
    const newer = controller.load();
    second.resolve(
      response([
        task({
          id: "newer",
          cwd: "/work/alpha",
          created_at: 2000,
          executing_device_id: "dev-a",
        }),
      ]),
    );
    await newer;
    first.resolve(
      response([
        task({
          id: "older",
          cwd: "/work/alpha",
          created_at: 1000,
          executing_device_id: "dev-a",
        }),
      ]),
    );
    await older;

    const state = controller.state();
    expect(state.status).toBe("ready");
    const ids = state.groups.flatMap((group) =>
      group.projects.flatMap((project) => project.rows.map((row) => row.id)),
    );
    expect(ids).toEqual(["newer"]);
  });

  it("KIN-MOBILE-001 R3: a failed refresh keeps the rows and flags the error", async () => {
    let call = 0;
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: (() => {
        call += 1;
        return call === 1
          ? Promise.resolve(response(fixture()))
          : Promise.reject(new TypeError("offline"));
      }) as unknown as typeof fetch,
    });

    await controller.load();
    const before = controller.state().groups;
    expect(controller.state().status).toBe("ready");

    const state = await controller.load();
    expect(state.groups).toBe(before);
    expect(state.groups.length).toBe(3);
    expect(state.status).toBe("offline");
    expect(state.error).toBe("unreachable");
  });

  it("KIN-MOBILE-001 R3: an empty page is the empty state, not a failure", async () => {
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: (() => Promise.resolve(response([]))) as unknown as typeof fetch,
    });
    const state = await controller.load();
    expect(state.status).toBe("empty");
    expect(state.groups).toEqual([]);
    expect(state.error).toBeNull();
  });

  it("KIN-MOBILE-001 R3: an expired token fails with a reason and no silent retry", async () => {
    let calls = 0;
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: (() => {
        calls += 1;
        return Promise.resolve(response(null, 401));
      }) as unknown as typeof fetch,
    });
    const state = await controller.load();
    expect(state.status).toBe("failed");
    expect(state.error).toBe("expired");
    expect(calls).toBe(1);
  });

  it("KIN-MOBILE-001 R3: a wait that never answers is bounded", async () => {
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      timeoutMs: 10,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new TypeError("aborted")),
          );
        })) as unknown as typeof fetch,
    });
    expect(LIST_TIMEOUT_MS).toBeGreaterThan(0);
    const state = await controller.load();
    expect(state.status).toBe("failed");
    expect(state.error).toBe("unreachable");
  });

  it("KIN-MOBILE-001 R3: toggling a project persists in the injected store", async () => {
    const store = createMemoryFoldStore();
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      store,
      fetchImpl: (() => Promise.resolve(response(fixture()))) as unknown as typeof fetch,
    });
    await controller.load();
    expect(store.read()[foldStateKey("dev-a", "/work/alpha")]).toBeUndefined();

    const state = controller.toggleProject("dev-a", "/work/alpha");
    expect(state.groups[0]!.projects[0]!.open).toBe(false);
    expect(store.read()[foldStateKey("dev-a", "/work/alpha")]).toBe(false);

    const again = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      store,
      fetchImpl: (() => Promise.resolve(response(fixture()))) as unknown as typeof fetch,
    });
    await again.load();
    expect(again.state().groups[0]!.projects[0]!.open).toBe(false);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
