import { describe, expect, it } from "@jest/globals";
import type {
  Approval,
  Task,
  UserQuestion,
} from "../../../ui/src/api/contract";
import type { Machine } from "../../../ui/src/lib/devices";
import {
  pendingApprovalsPath,
  pendingQuestionsPath,
} from "../approvals/approvalsModel";
import { listProjectsPath, listTasksPath } from "../api/transport";
import { t as realT } from "../i18n";
import {
  applyFolds,
  buildListGroups,
  createListController,
  createListMemory,
  createMemoryFoldStore,
  defaultOpenKeys,
  foldStateKey,
  LIST_TIMEOUT_MS,
  type DeviceGroup,
  type ListViewState,
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
    let taskCalls = 0;
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      // The pending lists answer at once; the task page is what arrives late.
      fetchImpl: ((input: string) => {
        const url = String(input);
        if (!url.endsWith(listTasksPath())) {
          return Promise.resolve(response([]));
        }
        taskCalls += 1;
        return taskCalls === 1 ? first.promise : second.promise;
      }) as unknown as typeof fetch,
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
    let taskCalls = 0;
    let calls = 0;
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: ((input: string) => {
        calls += 1;
        if (String(input).endsWith(listTasksPath())) taskCalls += 1;
        return Promise.resolve(response(null, 401));
      }) as unknown as typeof fetch,
    });
    const state = await controller.load();
    expect(state.status).toBe("failed");
    expect(state.error).toBe("expired");
    // One read per endpoint (the page, the two pending lists and the project
    // records), and not a single retry of the dead token.
    expect(calls).toBe(4);
    expect(taskCalls).toBe(1);
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

function serverApproval(taskId: string, id = `approval-${taskId}`): Approval {
  return { id, task_id: taskId } as unknown as Approval;
}

function serverQuestion(taskId: string, id = `question-${taskId}`): UserQuestion {
  return { id, task_id: taskId } as unknown as UserQuestion;
}

/**
 * One fake node for the controller's four parallel reads, routed by path.
 * Handlers receive their own call number, so a test can make the second
 * pending read fail while the first stays good.
 */
function controllerFetch(handlers: {
  tasks: (call: number) => Response | Promise<Response>;
  approvals?: (call: number) => Response | Promise<Response>;
  questions?: (call: number) => Response | Promise<Response>;
  projects?: (call: number) => Response | Promise<Response>;
}): typeof fetch {
  let taskCalls = 0;
  let approvalCalls = 0;
  let questionCalls = 0;
  let projectCalls = 0;
  return ((input: string) => {
    const url = String(input);
    if (url.endsWith(listTasksPath())) {
      taskCalls += 1;
      return Promise.resolve(handlers.tasks(taskCalls));
    }
    if (url.endsWith(pendingApprovalsPath)) {
      approvalCalls += 1;
      const answer = handlers.approvals ?? (() => response([]));
      return Promise.resolve(answer(approvalCalls));
    }
    if (url.endsWith(pendingQuestionsPath)) {
      questionCalls += 1;
      const answer = handlers.questions ?? (() => response([]));
      return Promise.resolve(answer(questionCalls));
    }
    if (url.endsWith(listProjectsPath)) {
      projectCalls += 1;
      const answer = handlers.projects ?? (() => response([]));
      return Promise.resolve(answer(projectCalls));
    }
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof fetch;
}

/** The loaded page as `[taskId, pending]`, in draw order. */
function pendingRows(state: ListViewState): [string, number][] {
  return state.groups.flatMap((group) =>
    group.projects.flatMap((project) =>
      project.rows.map((row) => [row.id, row.pending] as [string, number]),
    ),
  );
}

function pageTask(id: string, at: number, device = "dev-a"): Task {
  return task({
    id,
    cwd: "/work/alpha",
    created_at: at,
    executing_device_id: device,
  });
}

describe("KIN-MOBILE-001 R5 list model — server pending counts", () => {
  it("KIN-MOBILE-001 R5: the controller counts the server's pending approvals and questions per row", async () => {
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: controllerFetch({
        tasks: () => response([pageTask("a1", 1000), pageTask("a2", 900)]),
        approvals: () =>
          response([
            serverApproval("a1", "ap-1"),
            serverApproval("a1", "ap-2"),
          ]),
        questions: () =>
          response([
            serverQuestion("a1", "q-1"),
            serverQuestion("a2", "q-2"),
          ]),
      }),
    });

    const state = await controller.load();

    expect(state.status).toBe("ready");
    expect(pendingRows(state)).toEqual([
      ["a1", 3],
      ["a2", 1],
    ]);
  });

  it("KIN-MOBILE-001 R5: a failed pending read keeps the last counts and does not fail the list", async () => {
    let approvalsFail = false;
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: controllerFetch({
        tasks: () => response([pageTask("a1", 1000)]),
        approvals: () =>
          approvalsFail
            ? response({ error: "boom" }, 500)
            : response([serverApproval("a1")]),
        questions: () => response([]),
      }),
    });

    await controller.load();
    expect(pendingRows(controller.state())).toEqual([["a1", 1]]);

    // The tasks read still works; only one of the two pending lists is down.
    // The rows and their counts stay exactly as they were, and the list is not
    // blamed for a read the reader never asked to be authoritative.
    approvalsFail = true;
    const state = await controller.load();

    expect(state.status).toBe("ready");
    expect(state.error).toBeNull();
    expect(pendingRows(state)).toEqual([["a1", 1]]);
  });

  it("KIN-MOBILE-001 R5: a pending count for a task outside the page adds no row", async () => {
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: controllerFetch({
        tasks: () => response([pageTask("a1", 1000)]),
        approvals: () =>
          response([serverApproval("a1"), serverApproval("ghost")]),
        questions: () => response([serverQuestion("ghost", "q-ghost")]),
      }),
    });

    const state = await controller.load();

    expect(pendingRows(state)).toEqual([["a1", 1]]);
    expect(state.groups.flatMap((group) =>
      group.projects.flatMap((project) => project.rows),
    )).toHaveLength(1);
  });

  it("KIN-MOBILE-001 R5: a late older page's counts are dropped with its tasks answer", async () => {
    const olderPage = deferred<Response>();
    const newerPage = deferred<Response>();
    let taskCalls = 0;
    let approvalCalls = 0;
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      // The first tasks and approvals reads belong to the older load; the
      // second pair describes the page the reader is looking at now.
      fetchImpl: ((input: string) => {
        const url = String(input);
        if (url.endsWith(listTasksPath())) {
          taskCalls += 1;
          return taskCalls === 1 ? olderPage.promise : newerPage.promise;
        }
        if (url.endsWith(pendingApprovalsPath)) {
          approvalCalls += 1;
          return Promise.resolve(
            response(
              approvalCalls === 1
                ? [serverApproval("older", "ap-1"), serverApproval("older", "ap-2")]
                : [serverApproval("newer")],
            ),
          );
        }
        return Promise.resolve(response([]));
      }) as unknown as typeof fetch,
    });

    const older = controller.load();
    const newer = controller.load();
    newerPage.resolve(response([pageTask("newer", 2000)]));
    await newer;
    expect(pendingRows(controller.state())).toEqual([["newer", 1]]);

    // The older page's counts arrive with its tasks, long after the newer
    // answer landed. Both are dropped whole: no older row, and no older count
    // leaking onto the newer row either.
    olderPage.resolve(response([pageTask("older", 1000)]));
    await older;

    expect(pendingRows(controller.state())).toEqual([["newer", 1]]);
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

describe("KIN-MOBILE-001 R3 list memory", () => {
  it("KIN-MOBILE-001 R3: a claim supersedes the earlier one and only the newest mount is current", () => {
    const memory = createListMemory();
    const first = memory.claim();
    expect(memory.isCurrent(first)).toBe(true);

    // A remount claims the same memory while the old one is still alive.
    const second = memory.claim();
    expect(second).not.toBe(first);
    expect(memory.isCurrent(second)).toBe(true);
    expect(memory.isCurrent(first)).toBe(false);
    // An older generation never becomes current again.
    expect(memory.isCurrent(second - 1)).toBe(false);
    expect(memory.isCurrent(second + 1)).toBe(false);
  });

  it("KIN-MOBILE-001 R3: stored pages are keyed by origin, so another node's rows never restore", () => {
    const memory = createListMemory();
    const pageA: ListViewState = {
      status: "ready",
      groups: groupsOf(),
      error: null,
    };
    const pageB: ListViewState = { status: "empty", groups: [], error: null };

    expect(memory.readSnapshot("https://a.example")).toBeNull();
    memory.writeSnapshot("https://a.example", pageA);
    memory.writeSnapshot("https://b.example", pageB);

    expect(memory.readSnapshot("https://a.example")).toBe(pageA);
    expect(memory.readSnapshot("https://b.example")).toBe(pageB);
    // A re-pairing to a third node restores nothing.
    expect(memory.readSnapshot("https://c.example")).toBeNull();
  });

  it("KIN-MOBILE-001 R3: the query, the offset and the focused row survive the route and patch independently", () => {
    const memory = createListMemory({ query: "seed" });
    expect(memory.read()).toEqual({
      query: "seed",
      offset: 0,
      focusedRowId: "",
    });

    memory.write({ offset: 180 });
    memory.write({ query: "alpha" });
    memory.write({ focusedRowId: "task-2" });
    expect(memory.read()).toEqual({
      query: "alpha",
      offset: 180,
      focusedRowId: "task-2",
    });

    // A patch that names one field leaves the others alone.
    memory.write({});
    expect(memory.read()).toEqual({
      query: "alpha",
      offset: 180,
      focusedRowId: "task-2",
    });
  });

  it("KIN-MOBILE-001 R3: a controller handed a restored page keeps its rows when a project folds", () => {
    const restored: ListViewState = {
      status: "ready",
      groups: groupsOf(),
      error: null,
    };
    const controller = createListController({
      origin: "https://kin.example.com",
      selfDeviceId: "dev-a",
      machines: MACHINES,
      t,
      formatTime,
      store: createMemoryFoldStore(),
      initialState: restored,
    });
    expect(pendingRows(controller.state())).toHaveLength(14);

    const folded = controller.toggleProject("dev-a", "/work/beta");
    // The page behind the fold is the restored one, not a fresh loading
    // state: every row is still there and only the fold moved.
    expect(folded.status).toBe("ready");
    expect(pendingRows(folded)).toHaveLength(14);
    const beta = folded.groups
      .find((group) => group.id === "dev-a")
      ?.projects.find((project) => project.key === "/work/beta");
    expect(beta?.open).toBe(false);
  });

  it("KIN-MOBILE-001 R3: a stored failure is not a page and the mount reads again", () => {
    const options = {
      origin: "https://kin.example.com",
      selfDeviceId: "dev-a",
      machines: MACHINES,
      t,
      formatTime,
      store: createMemoryFoldStore(),
    };
    // A failure is a network fact about the moment. Restoring it would trap
    // the mount on an error it never retries, so the controller starts on
    // loading and the mount reads.
    const failed = createListController({
      ...options,
      initialState: {
        status: "failed",
        groups: groupsOf(),
        error: "unreachable",
      },
    });
    expect(failed.state()).toEqual({
      status: "loading",
      groups: [],
      error: null,
    });

    // Ready and empty pages are pages, so both restore.
    const ready = createListController({
      ...options,
      initialState: {
        status: "ready",
        groups: groupsOf(),
        error: null,
      },
    });
    expect(ready.state().status).toBe("ready");
    expect(pendingRows(ready.state())).toHaveLength(14);

    const empty = createListController({
      ...options,
      initialState: { status: "empty", groups: [], error: null },
    });
    expect(empty.state().status).toBe("empty");
  });
});

/**
 * KIN-MOBILE-001 R3 — the heading's name comes from the project record.
 *
 * `/api/projects` is the authority for a project's identity and name; a cwd is
 * only one of its addresses. The web list already adapts those records in
 * `ui/src/components/sessions/SessionList.tsx:670-692`; the phone reads the
 * same endpoint through the same shared bucketing rule.
 */
describe("KIN-MOBILE-001 R3 list model — project names", () => {
  const alphaRecord = {
    id: "p1",
    name: "[seed] Project Alpha",
    roots: ["/work/alpha"],
  };

  it("KIN-MOBILE-001 R3: a project record names the heading and all its roots file under it", () => {
    const tasks = [
      task({ id: "pa1", cwd: "/work/alpha", created_at: 300 }),
      task({ id: "pa2", cwd: "/work/alpha2", created_at: 200 }),
      task({ id: "pb1", cwd: "/work/beta", created_at: 100 }),
    ];
    const groups = buildListGroups(tasks, {
      selfDeviceId: "dev-a",
      t,
      formatTime,
      projects: [
        {
          id: "p1",
          name: "[seed] Project Alpha",
          roots: ["/work/alpha", "/work/alpha2"],
        },
      ],
    });

    expect(groups).toHaveLength(1);
    const projects = groups[0]!.projects;
    expect(projects.map((project) => project.label)).toEqual([
      "[seed] Project Alpha",
      "beta",
    ]);
    // The heading keeps the record's first root as its key, so folds, search
    // and the stored order keep answering to the same bucket; both roots' rows
    // file under it.
    expect(projects[0]!.key).toBe("/work/alpha");
    expect(projects[0]!.rows.map((row) => row.id)).toEqual(["pa1", "pa2"]);
    // A folder no record claims keeps its own heading and the folder's name.
    expect(projects[1]!.key).toBe("/work/beta");
    expect(projects[1]!.rows.map((row) => row.id)).toEqual(["pb1"]);
  });

  it("KIN-MOBILE-001 R3: the list controller reads /api/projects and names the heading", async () => {
    const urls: string[] = [];
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: ((input: string) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith(listProjectsPath)) {
          return Promise.resolve(response([alphaRecord]));
        }
        if (url.endsWith(listTasksPath())) {
          return Promise.resolve(response([pageTask("a1", 1000)]));
        }
        return Promise.resolve(response([]));
      }) as unknown as typeof fetch,
    });

    const state = await controller.load();

    expect(state.groups[0]!.projects[0]!.label).toBe("[seed] Project Alpha");
    expect(urls.some((url) => url.endsWith(listProjectsPath))).toBe(true);
  });

  it("KIN-MOBILE-001 R3: a failed projects read keeps the rows and the last names", async () => {
    let projectsFail = false;
    const controller = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: controllerFetch({
        tasks: () => response([pageTask("a1", 1000)]),
        projects: () =>
          projectsFail
            ? response({ error: "boom" }, 500)
            : response([alphaRecord]),
      }),
    });

    await controller.load();
    expect(controller.state().groups[0]!.projects[0]!.label).toBe(
      "[seed] Project Alpha",
    );

    // The task page keeps answering; only the names' read is down. The list
    // keeps its rows and the names it already learned — a failed name read is
    // not a failed page.
    projectsFail = true;
    const state = await controller.load();
    expect(state.status).toBe("ready");
    expect(state.groups[0]!.projects[0]!.label).toBe("[seed] Project Alpha");
    expect(state.groups[0]!.projects[0]!.rows.map((row) => row.id)).toEqual([
      "a1",
    ]);

    // A controller that never read the records is not failed either: with no
    // record, the folder's own name is the honest heading.
    const fresh = createListController({
      origin: "http://kin.example.com",
      selfDeviceId: "dev-a",
      t,
      formatTime,
      fetchImpl: controllerFetch({
        tasks: () => response([pageTask("a1", 1000)]),
        projects: () => response({ error: "boom" }, 500),
      }),
    });
    const first = await fresh.load();
    expect(first.status).toBe("ready");
    expect(first.groups[0]!.projects[0]!.label).toBe("alpha");
  });
});
