// @vitest-environment jsdom
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { Task } from "../api/client";
import { liveResources } from "../api/liveResources";
import { setLocale } from "../i18n";
import TaskDetailPage from "./TaskDetailPage";

/**
 * KIN-NOTIFY-001 / R0b-2a: a notification lands on the conversation and the
 * card it named.
 *
 * The inbox used to be the landing page for every approval and question push,
 * which meant a tap took two hops: a cross-conversation list, then the
 * conversation. The card lives in its own transcript now, so the link names the
 * conversation and `?focus=` says which waiting card stopped the agent. What
 * this test pins is the last inch: the named card is the one the keyboard
 * cursor and DOM focus land on, not merely the first one in the queue, and the
 * link stops claiming an item once the page has answered.
 */

const task: Task = {
  id: "task-1",
  title: "Fix the login bug",
  status: "running",
  agent: "kin",
  cwd: "/work/alpha",
  prompt: "fix it",
  tokens_in: 0,
  tokens_out: 0,
  event_epoch: 0,
  created_at: 1,
} as unknown as Task;

function approval(id: string, createdAt: number, taskId = "task-1") {
  return {
    id,
    task_id: taskId,
    kind: "tool_use",
    payload: { tool_name: "Write", input: { path: "a.ts" } },
    decision: "pending",
    created_at: createdAt,
  };
}

const pending = {
  loaded: true,
  error: null,
  loading: false,
  data: {
    approvals: [
      approval("ap-older", 1),
      approval("ap-named", 2),
      approval("ap-other-task", 3, "task-2"),
    ],
    questions: [],
  },
};

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { version: 0 };
  return {
    state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => state.version,
  };
});

vi.mock("../api/useLiveResources", () => ({
  useTaskResource: (id: string) => {
    useSyncExternalStore(store.subscribe, store.version, store.version);
    return {
      loaded: true,
      error: null,
      data: { task: { ...task, id }, events: [], deleted: false },
      id,
    };
  },
  usePendingResources: () => pending,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const never = () => new Promise<never>(() => {});
  return {
    ...actual,
    isAuthenticated: () => true,
    listAgents: never,
    getTaskUsage: never,
    getTaskLimitWait: never,
    listQueuedPrompts: never,
    listWorkerSteps: never,
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));
vi.mock("../components/mobile/MobileHeader", () => ({
  default: ({ title }: { title?: string }) => <div data-testid="mobile-header">{title}</div>,
  MobileHeaderButton: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("../components/chat/Composer", () => ({
  default: () => <div data-testid="composer" />,
}));
vi.mock("../components/chat/ChatStream", () => ({
  default: ({
    pendingSlots,
    trailing,
  }: {
    pendingSlots?: Record<string, ReactNode>;
    trailing?: ReactNode;
  }) => (
    <div data-testid="chat-stream">
      {Object.entries(pendingSlots ?? {}).map(([id, node]) => (
        <div key={id}>{node}</div>
      ))}
      {trailing}
    </div>
  ),
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function open(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/tasks/task-1${search}`]}>
      <LocationProbe />
      <TaskDetailPage taskId="task-1" fallbackTask={task} />
    </MemoryRouter>,
  );
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Navigable() {
  const location = useLocation();
  const navigate = useNavigate();
  const onTask = location.pathname === "/tasks/task-1";
  return (
    <>
      <button
        type="button"
        onClick={() => {
          (document.activeElement as HTMLElement | null)?.blur();
          navigate("/sessions");
        }}
      >
        leave
      </button>
      <button type="button" onClick={() => navigate("/tasks/task-1?focus=ap-named")}>
        tap again
      </button>
      <LocationProbe />
      <div className={onTask ? "" : "hidden"}>
        <TaskDetailPage taskId="task-1" active={onTask} fallbackTask={task} />
      </div>
    </>
  );
}

function SwitchingPanes() {
  // `/tasks/task-2` is the route from the first render, but task-2 has not
  // loaded: task-1 still owns the screen. The button stands in for its detail
  // arriving.
  const [ready, setReady] = useState(false);
  const location = useLocation();
  const onTask1 = location.pathname === "/tasks/task-1";
  return (
    <>
      <button type="button" onClick={() => setReady(true)}>
        loaded
      </button>
      <LocationProbe />
      <TaskDetailPage taskId="task-1" active={onTask1 || !ready} fallbackTask={task} />
      <TaskDetailPage
        taskId="task-2"
        active={!onTask1 && ready}
        fallbackTask={{ ...task, id: "task-2" }}
      />
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  // jsdom has no layout, and the reveal asks the card to scroll itself into
  // view; the focus assertion below is what this test is about.
  Element.prototype.scrollIntoView = vi.fn();
  // The absent-item path asks the store for a read that starts after the link,
  // and concludes only from that answer; this test answers it immediately.
  vi.spyOn(liveResources, "refreshPending").mockResolvedValue(undefined);
  setLocale("en");
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a notification that names a waiting card", () => {
  it("focuses that card, not the first one in the queue", async () => {
    open("?focus=ap-named");

    const named = document.querySelector('[data-pending-id="ap-named"]');
    await waitFor(() => expect(document.activeElement).toBe(named));
    expect(named?.textContent).toContain("focused");
    const older = document.querySelector('[data-pending-id="ap-older"]');
    expect(older?.textContent).not.toContain("focused");
  });

  it("keeps trying when the card cannot take focus on the first attempt", async () => {
    // A real page calls focus() while the transcript scroller is still
    // `visibility:hidden` (it positions its scroll after the first paint), and
    // a node in a hidden subtree cannot take focus: focus() returns without
    // firing focusin. The reveal must retry rather than consume the link on a
    // landing that never happened.
    const realFocus = HTMLElement.prototype.focus;
    let refused = 0;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      ...args: Parameters<HTMLElement["focus"]>
    ) {
      if (this.getAttribute("data-pending-id") === "ap-named" && refused === 0) {
        refused += 1;
        return;
      }
      realFocus.apply(this, args);
    });

    open("?focus=ap-named");

    const named = document.querySelector('[data-pending-id="ap-named"]');
    await waitFor(() => expect(document.activeElement).toBe(named));
    expect(refused).toBe(1);
    expect(screen.getByTestId("location").textContent).toBe("/tasks/task-1");
  });

  it("drops the parameter so the link stops naming an item", async () => {
    open("?focus=ap-named");
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/tasks/task-1"),
    );
  });

  it("still opens the conversation when the named item is gone", async () => {
    open("?focus=answered-elsewhere");

    // Answered on another device, expired, or outside the window: the
    // conversation is the right landing and the parameter has nothing to name.
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/tasks/task-1"),
    );
    expect(screen.getByTestId("chat-stream")).toBeTruthy();
    expect(document.querySelector('[data-pending-id="answered-elsewhere"]')).toBeNull();
  });

  it("lets the routed conversation answer, not one kept on screen", async () => {
    // The host keeps the outgoing conversation visible, and owning the
    // keyboard, until the incoming one has loaded. If that stale pane consumed
    // the parameter, the conversation the tap was for would never see it.
    render(
      <MemoryRouter initialEntries={["/tasks/task-2?focus=ap-other-task"]}>
        <SwitchingPanes />
      </MemoryRouter>,
    );

    // The stale pane never answers for work that is not its own: the link is
    // still there when the incoming pane is ready to take it.
    expect(screen.getByTestId("location").textContent).toBe(
      "/tasks/task-2?focus=ap-other-task",
    );
    expect(liveResources.refreshPending).not.toHaveBeenCalled();

    // The incoming pane loads; only now does it take the screen and the link.
    fireEvent.click(screen.getByRole("button", { name: "loaded" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/tasks/task-2"),
    );
    const named = () => document.querySelector('[data-pending-id="ap-other-task"]');
    await waitFor(() => expect(named()?.textContent).toContain("focused"));
  });

  it("waits for a pending read that follows the link before calling it gone", async () => {
    // "Loaded" is not "fresh": the snapshot may predate the push that woke the
    // app. The link stays until a read that started after it answers.
    let finish: () => void = () => {};
    vi.mocked(liveResources.refreshPending).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    open("?focus=answered-elsewhere");

    await waitFor(() => expect(liveResources.refreshPending).toHaveBeenCalled());
    expect(screen.getByTestId("location").textContent).toBe(
      "/tasks/task-1?focus=answered-elsewhere",
    );
    finish();
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/tasks/task-1"),
    );
  });

  it("focuses the card again when the same banner is tapped a second time", async () => {
    // The pane stays mounted after the reader leaves, and the link stops
    // naming the item once consumed. A later tap is a new navigation and must
    // not be swallowed as a replay of the first.
    render(
      <MemoryRouter initialEntries={["/tasks/task-1?focus=ap-named"]}>
        <Navigable />
      </MemoryRouter>,
    );
    const named = document.querySelector('[data-pending-id="ap-named"]');
    await waitFor(() => expect(document.activeElement).toBe(named));

    fireEvent.click(screen.getByRole("button", { name: "leave" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/sessions"),
    );
    expect(document.activeElement).not.toBe(named);

    fireEvent.click(screen.getByRole("button", { name: "tap again" }));
    await waitFor(() => expect(document.activeElement).toBe(named));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/tasks/task-1"),
    );
  });
});
