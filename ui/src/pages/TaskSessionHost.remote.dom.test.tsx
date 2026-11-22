// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { setLocale } from "../i18n";
import { readSessionTabs } from "../lib/sessionTabs";
import TaskSessionHost from "./TaskSessionHost";

/**
 * One task detail page, local and remote.
 *
 * A routine run executed on another machine is still a task detail: the same
 * page, with `?device=` saying which machine owns the transcript. It is
 * read-only and it is *not* a conversation in this console's tab strip — the
 * tabs are this machine's store, and a remote run is a row in another one.
 *
 * The host already holds the list row for a task executed elsewhere
 * (`executing_device_id`), so a row that links `/tasks/<id>` opens remotely
 * without the list having to know about it.
 */

type Deferred = {
  resolve: (task: unknown) => void;
  reject: (error: unknown) => void;
};

const remoteApi = vi.hoisted(() => {
  const entries = new Map<string, Deferred>();
  const calls: Array<{ device: string; id: string }> = [];
  const key = (device: string, id: string) => `${device}:${id}`;
  return {
    calls,
    reset() {
      entries.clear();
      calls.length = 0;
    },
    /** Record the request and hold its answer until the test settles it. */
    request(device: string, id: string): Promise<unknown> {
      calls.push({ device, id });
      return new Promise((resolve, reject) => {
        entries.set(key(device, id), { resolve, reject });
      });
    },
    settle(device: string, id: string, task: unknown) {
      const entry = entries.get(key(device, id));
      if (!entry) throw new Error(`no pending remote request for ${key(device, id)}`);
      entry.resolve(task);
    },
  };
});

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    getMachineTask: (device: string, id: string) => remoteApi.request(device, id),
    listMachineTaskEvents: async () => [],
  };
});

type DetailState = {
  task: unknown;
  events: unknown[];
  deleted: boolean;
};

const live = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    version: 0,
    list: [] as unknown[],
    details: {} as Record<string, unknown>,
  };
  return {
    state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => state.version,
    detail(id: string): unknown {
      return (
        state.details[id] ?? {
          loaded: false,
          error: null,
          data: { task: null, events: [], deleted: false },
        }
      );
    },
    resolve(id: string, detail: DetailState) {
      state.details[id] = { loaded: true, error: null, data: detail };
      live.notify();
    },
    notify() {
      state.version += 1;
      for (const listener of listeners) listener();
    },
    reset(list: unknown[]) {
      state.version = 0;
      state.list = list;
      state.details = {};
    },
  };
});

vi.mock("../api/useLiveResources", () => ({
  useTaskList: () => {
    useSyncExternalStore(live.subscribe, live.version, live.version);
    return { data: live.state.list, loading: false, error: null, loaded: true };
  },
  usePendingResources: () => ({ data: { approvals: [], questions: [] } }),
  useTaskResource: (id: string, enabled = true) => {
    useSyncExternalStore(live.subscribe, live.version, live.version);
    // A remote run is not in this Hub's task table; the host must not ask.
    if (!enabled) {
      return { loaded: false, error: null, data: { task: null, events: [], deleted: false } };
    }
    return live.detail(id);
  },
}));

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "hub-1", label: "This Hub", isSelf: true, online: true, roots: [], agents: [] },
      { id: "dev-a", label: "Machine A", isSelf: false, online: true, roots: [], agents: [] },
    ],
    agents: [],
    loading: false,
    failed: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../hooks/useAgentRoles", () => ({ useAgentRoles: () => [] }));

// The local page is a marker: this suite asks which view the host chose.
vi.mock("./TaskDetailPage", () => ({
  default: ({ taskId }: { taskId: string }) => <div data-testid="local-detail">{taskId}</div>,
}));

function remoteTask(id: string, title: string) {
  return {
    id,
    title,
    status: "succeeded",
    agent: "kin",
    cwd: "/work",
    prompt: title,
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
    finished_at: 2,
    executing_device_id: "dev-a",
  };
}

function heldTask(id: string, title: string, device: string) {
  return {
    id,
    title,
    status: "succeeded",
    agent: "kin",
    cwd: "/work",
    prompt: title,
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
    executing_device_id: device,
  };
}

function Nav() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/tasks/run-2?device=dev-a")}>
      go run 2
    </button>
  );
}

function open(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <TaskSessionHost />
      <Nav />
    </MemoryRouter>,
  );
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  setLocale("en");
  localStorage.clear();
  live.reset([]);
  remoteApi.reset();
});

describe("the keep-alive host and a run on another machine", () => {
  it("?device= renders the read-only run from that machine", async () => {
    open("/tasks/run-1?device=dev-a");

    expect(remoteApi.calls).toEqual([{ device: "dev-a", id: "run-1" }]);
    expect(screen.queryByTestId("local-detail")).toBeNull();

    await act(async () => {
      remoteApi.settle("dev-a", "run-1", remoteTask("run-1", "Remote report"));
    });

    expect(screen.getByRole("heading", { name: "Remote report" })).toBeTruthy();
    // The read-only note names the machine, and the back link stays Routines.
    expect(screen.getByText(/Read-only · this run lives on Machine A/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Routines/ }).getAttribute("href")).toBe("/routines");
  });

  it("a remote run is not added to the conversation tabs", async () => {
    open("/tasks/run-1?device=dev-a");
    await act(async () => {
      remoteApi.settle("dev-a", "run-1", remoteTask("run-1", "Remote report"));
    });

    // The tabs are this machine's open conversations; a run in another
    // machine's store is not one of them.
    expect(readSessionTabs()).toEqual([]);
    expect(screen.queryByRole("tab", { name: /Remote report/ })).toBeNull();
    expect(screen.queryByTestId("local-detail")).toBeNull();
  });

  it("a local task with no device still mounts the task detail", async () => {
    live.reset([heldTask("task-1", "Local conversation", "")]);
    live.resolve("task-1", {
      task: heldTask("task-1", "Local conversation", ""),
      events: [],
      deleted: false,
    });

    open("/tasks/task-1");

    expect(screen.getByTestId("local-detail").textContent).toBe("task-1");
    expect(remoteApi.calls).toEqual([]);
    expect(readSessionTabs()).toEqual(["task-1"]);
  });

  it("a held task whose executing_device_id is another machine opens remotely", async () => {
    // The list row links `/tasks/<id>` and carries the machine that ran it.
    live.reset([heldTask("run-held", "Held remote run", "dev-a")]);

    open("/tasks/run-held");

    expect(remoteApi.calls).toEqual([{ device: "dev-a", id: "run-held" }]);
    expect(screen.queryByTestId("local-detail")).toBeNull();
    expect(readSessionTabs()).toEqual([]);
  });

  it("a late remote answer for a previous id does not paint", async () => {
    open("/tasks/run-1?device=dev-a");

    act(() => {
      screen.getByText("go run 2").click();
    });
    expect(remoteApi.calls).toEqual([
      { device: "dev-a", id: "run-1" },
      { device: "dev-a", id: "run-2" },
    ]);

    await act(async () => {
      remoteApi.settle("dev-a", "run-2", remoteTask("run-2", "Second run"));
    });
    expect(screen.getByRole("heading", { name: "Second run" })).toBeTruthy();

    // The previous id's answer arrives after the reader moved on. The pane it
    // belonged to is gone, and a generation-guarded hook drops its answer.
    await act(async () => {
      remoteApi.settle("dev-a", "run-1", remoteTask("run-1", "First run"));
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Second run" })).toBeTruthy();
    expect(screen.queryByText("First run")).toBeNull();
  });
});
