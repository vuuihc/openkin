// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { ApiError, type Task } from "../api/client";
import { setLocale } from "../i18n";
import { forgetPendingSend, handOffPendingSend, pendingSend } from "../lib/pendingSend";
import { setLocalTaskTitle } from "../lib/taskTitles";
import TaskSessionHost from "./TaskSessionHost";

/**
 * The keep-alive host decides which conversation is on screen while a switch
 * settles. A conversation the console just created already has everything it
 * needs to be drawn — the list row the create answer seeded, and the bubble
 * handed over from the draft — even though its detail GET has not answered.
 * Readiness must accept that snapshot, or the host keeps the *previous*
 * conversation in front and the new one only appears after the GET.
 *
 * A genuinely cold entry has neither, and gets the branded wait rather than a
 * skeleton of a transcript nobody has seen.
 *
 * The same mounted host owns the tab strip, whose labels are names of the same
 * conversations. A rename is a local preference the live feed never carries,
 * so the strip has to repaint itself rather than wait for the next event.
 */

type DetailState = {
  task: Task | null;
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
    /** The create answer's seed: a task with no GET answer yet. */
    seed(id: string, task: Task) {
      state.details[id] = {
        loaded: false,
        error: null,
        data: { task, events: [], deleted: false },
      };
      live.notify();
    },
    resolve(id: string, detail: DetailState) {
      state.details[id] = {
        loaded: true,
        error: null,
        data: { task: detail.task, events: detail.events, deleted: detail.deleted },
      };
      live.notify();
    },
    fail(id: string, error: unknown) {
      state.details[id] = {
        loaded: true,
        error,
        data: { task: null, events: [], deleted: false },
      };
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
  useTaskResource: (id: string) => {
    useSyncExternalStore(live.subscribe, live.version, live.version);
    return live.detail(id);
  },
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const pending = () => new Promise<never>(() => {});
  return {
    ...actual,
    isAuthenticated: () => true,
    listAgents: pending,
    getTaskUsage: pending,
    getTaskLimitWait: pending,
    listQueuedPrompts: pending,
    listWorkerSteps: pending,
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));
vi.mock("../hooks/useAgentRoles", () => ({ useAgentRoles: () => [] }));
vi.mock("../components/mobile/MobileHeader", () => ({
  default: ({ title, trailing }: { title?: string; trailing?: ReactNode }) => (
    <div data-testid="mobile-header">
      {title}
      {trailing}
    </div>
  ),
  MobileHeaderButton: ({ label, children }: { label?: string; children?: ReactNode }) => (
    <button type="button" aria-label={label}>
      {children}
    </button>
  ),
}));
vi.mock("../components/chat/Composer", () => ({
  default: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="composer" data-disabled={String(Boolean(disabled))} />
  ),
}));
vi.mock("../components/chat/ChatStream", () => ({
  default: ({
    loading,
    pendingUserMessages,
  }: {
    loading?: boolean;
    pendingUserMessages?: readonly { key: string; text: string }[];
  }) => (
    <div data-testid="chat-stream" data-loading={String(Boolean(loading))}>
      {(pendingUserMessages ?? []).map((message) => (
        <span key={message.key} data-testid="pending-handoff">
          {message.text}
        </span>
      ))}
    </div>
  ),
}));

const oldTask = {
  id: "task-old",
  title: "Old conversation",
  status: "succeeded",
  agent: "kin",
  cwd: "/work",
  prompt: "old prompt",
  tokens_in: 0,
  tokens_out: 0,
  event_epoch: 0,
  created_at: 1,
} as unknown as Task;

const newTask = {
  id: "task-new",
  title: "New conversation",
  status: "queued",
  agent: "kin",
  cwd: "/work",
  prompt: "hello",
  tokens_in: 0,
  tokens_out: 0,
  event_epoch: 0,
  created_at: 2,
} as unknown as Task;

const goneTask = {
  ...oldTask,
  id: "task-gone",
  title: "Stale title",
} as unknown as Task;

/** Route buttons stand in for the new-chat route's create-then-navigate. */
function Nav() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" data-testid="go-old" onClick={() => navigate("/tasks/task-old")}>
        old
      </button>
      <button type="button" data-testid="go-new" onClick={() => navigate("/tasks/task-new")}>
        new
      </button>
    </>
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

/** The pane carrying `text`, when it is not inside an `aria-hidden` subtree. */
function visiblePane(text: string): HTMLElement | undefined {
  return screen
    .getAllByTestId("mobile-header")
    .find(
      (element) =>
        element.textContent?.includes(text) && element.closest('[aria-hidden="true"]') === null,
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
  for (const id of ["task-old", "task-new", "task-gone"]) forgetPendingSend(id);
  live.reset([]);
});

describe("the keep-alive host and a just-created conversation", () => {
  it("shows a newly created row and handed-off message before its detail answers", () => {
    live.reset([newTask]);
    live.seed("task-new", newTask);
    handOffPendingSend("task-new", pendingSend("hello", []));

    open("/tasks/task-new");

    expect(visiblePane("New conversation")).toBeTruthy();
    expect(screen.getByTestId("pending-handoff").textContent).toBe("hello");
    expect(screen.getByTestId("chat-stream").getAttribute("data-loading")).toBe("true");
    // Nothing about this is a page load: the whole-page wait is not drawn.
    expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
  });

  it("does not keep the outgoing conversation visible after the new conversation has a usable snapshot", async () => {
    live.reset([oldTask, newTask]);
    live.resolve("task-old", { task: oldTask, events: [], deleted: false });
    live.seed("task-new", newTask);
    handOffPendingSend("task-new", pendingSend("hello", []));

    open("/tasks/task-old");
    expect(visiblePane("Old conversation")).toBeTruthy();

    await act(async () => {
      screen.getByTestId("go-new").click();
    });

    // The new detail GET has not answered. Its seeded row is enough: the
    // conversation the reader just started is the one in front, and the old
    // one must not hold the screen while a request it does not depend on runs.
    expect(visiblePane("New conversation")).toBeTruthy();
    expect(visiblePane("Old conversation")).toBeUndefined();
    expect(screen.getByTestId("pending-handoff").textContent).toBe("hello");
  });

  it("keeps a cold entry without a snapshot on the wheel waiting state", () => {
    live.reset([]);
    open("/tasks/task-cold");

    expect(document.querySelectorAll(".animate-pulse").length).toBe(0);
    expect(screen.queryByTestId("mobile-header")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();
    const status = screen.getByRole("status", { name: /Loading/ });
    const wheel = status.querySelector(".kin-ios-spinner");
    expect(wheel?.getAttribute("aria-hidden")).toBe("true");
    expect(wheel?.querySelectorAll("span")).toHaveLength(12);
    expect(status.querySelector("svg")).toBeNull();
  });

  it("repaints the open tab when another surface renames the conversation", () => {
    live.reset([oldTask]);
    live.resolve("task-old", { task: oldTask, events: [], deleted: false });
    open("/tasks/task-old");
    expect(screen.getByRole("tab", { name: /Old conversation/ })).toBeTruthy();

    // The sidebar's row menu writes the local title. The feed says nothing and
    // this conversation is idle, so an unsubscribed strip would keep the old
    // label above a header that already draws the new one.
    act(() => {
      setLocalTaskTitle("task-old", "Renamed in the sidebar");
    });

    expect(screen.getByRole("tab", { name: /Renamed in the sidebar/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /Old conversation/ })).toBeNull();
  });

  it("does not let a cached row override a known deleted conversation", () => {
    live.reset([goneTask]);
    // A 404 is the other way the daemon says "gone". A cached list row must
    // not resurrect it as a drawable conversation: the page's not-found answer
    // still owns the pane. (`deleted: true` also redirects the route home, so
    // the 404 path is what can be observed inside the host.)
    live.fail("task-gone", new ApiError(404, "Task not found"));

    open("/tasks/task-gone");

    // The alert renders the locale's `task.notFound`, not the daemon's 404 text
    // (the injected "Task not found" above is deliberately the old wording).
    expect(screen.getByRole("alert").textContent).toContain("Conversation not found");
    expect(screen.queryByTestId("mobile-header")).toBeNull();
  });
});
