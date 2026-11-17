// @vitest-environment jsdom
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import type { Task } from "../api/client";
import { liveResources } from "../api/liveResources";
import { setLocale } from "../i18n";
import { useAppStore } from "../store/appStore";
import TaskDetailPage from "./TaskDetailPage";

/**
 * KIN-RESULT-002: `/tasks/<id>?panel=files&file=<path>` is a real address.
 *
 * A refresh, a paste, a Forward and a notification-style arrival all have to
 * land on the same file, and the address must not grow an entry just because
 * the page read it. The page's own controls are the other half: opening the
 * panel and closing it are user actions, so they push exactly one entry each,
 * and Back/Forward follow the URL rather than being second-guessed.
 *
 * The files panel itself is stubbed: what this test pins is the address and the
 * one-shot "open this path" command the page hands across, not file rendering.
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
    approvals: [approval("ap-named", 2)],
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
// The panel's own rendering has its own tests; this probe records the one-shot
// command the page hands it and whether it is mounted at all.
vi.mock("../components/workspace/WorkspacePanel", () => ({
  default: ({
    taskId,
    openPath,
    openNonce,
  }: {
    taskId: string;
    openPath?: string | null;
    openNonce?: number;
  }) => (
    <div
      data-testid="workspace-panel"
      data-task={taskId}
      data-open-path={openPath ?? ""}
      data-nonce={openNonce ?? 0}
    />
  ),
}));

function panel() {
  return screen.queryByTestId("workspace-panel");
}

function LocationProbe() {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <div data-testid="location" data-key={location.key} data-type={type}>
      {location.pathname + location.search}
    </div>
  );
}

function address() {
  return screen.getByTestId("location").textContent;
}

function historyType() {
  return screen.getByTestId("location").getAttribute("data-type");
}

function HistoryProbe() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate(-1)}>
        back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        forward
      </button>
      <LocationProbe />
    </>
  );
}

function at(entries: string[], index = entries.length - 1) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <HistoryProbe />
      <TaskDetailPage taskId="task-1" fallbackTask={task} />
    </MemoryRouter>,
  );
}

function open(search: string) {
  return at([`/tasks/task-1${search}`]);
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function SwitchingPanes() {
  // The route is task-2 from the first render, but task-2 has not loaded, so
  // task-1 still owns the screen. The button stands in for its detail arriving.
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

function KeptAlivePanes() {
  // Both panes stay mounted while the route decides which one owns the screen,
  // so a pane that goes out of sight keeps its refs — the case this pins.
  const location = useLocation();
  const navigate = useNavigate();
  const onTask1 = location.pathname === "/tasks/task-1";
  return (
    <>
      <button type="button" onClick={() => navigate("/tasks/task-2?panel=files")}>
        other task
      </button>
      <HistoryProbe />
      <TaskDetailPage taskId="task-1" active={onTask1} fallbackTask={task} />
      <TaskDetailPage taskId="task-2" active={!onTask1} fallbackTask={{ ...task, id: "task-2" }} />
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(liveResources, "refreshPending").mockResolvedValue(undefined);
  useAppStore.setState({ shownPanel: null, lensPick: null });
  setLocale("en");
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the files panel's address", () => {
  it("an arrival link opens the files panel on the named file without adding a history entry", async () => {
    open("?panel=files&file=src/a%20b.ts");
    const arrivalKey = screen.getByTestId("location").getAttribute("data-key");

    await waitFor(() => expect(panel()?.getAttribute("data-open-path")).toBe("src/a b.ts"));
    expect(panel()?.getAttribute("data-task")).toBe("task-1");
    expect(panel()?.getAttribute("data-nonce")).not.toBe("0");
    expect(useAppStore.getState().shownPanel).toEqual({ view: "task-1", id: "files" });

    // Reading the link does not rewrite it, and does not add an entry.
    expect(address()).toBe("/tasks/task-1?panel=files&file=src/a%20b.ts");
    expect(screen.getByTestId("location").getAttribute("data-key")).toBe(arrivalKey);
    expect(historyType()).toBe("POP");
  });

  it("an unsafe file link opens the list and the address loses only the file", async () => {
    at(["/tasks/task-1", "/tasks/task-1?panel=files&file=..%2F..%2Fetc%2Fpasswd"]);

    await waitFor(() => expect(address()).toBe("/tasks/task-1?panel=files"));
    expect(panel()?.getAttribute("data-open-path")).toBe("");
    expect(useAppStore.getState().shownPanel).toEqual({ view: "task-1", id: "files" });
    // A replace, not a push: one Back still reaches the conversation.
    expect(historyType()).not.toBe("PUSH");

    fireEvent.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(address()).toBe("/tasks/task-1");
  });

  it("Back walks file → conversation and Forward restores the file", async () => {
    at(["/tasks/task-1", "/tasks/task-1?panel=files&file=src/a%20b.ts"]);
    await waitFor(() => expect(panel()?.getAttribute("data-open-path")).toBe("src/a b.ts"));

    fireEvent.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() => expect(address()).toBe("/tasks/task-1"));
    await waitFor(() => expect(panel()).toBeNull());
    expect(useAppStore.getState().shownPanel).toBeNull();
    expect(historyType()).toBe("POP");

    // Forward follows the URL: the same file comes back, and nothing is pushed.
    fireEvent.click(screen.getByRole("button", { name: "forward" }));
    await waitFor(() => expect(panel()?.getAttribute("data-open-path")).toBe("src/a b.ts"));
    expect(address()).toBe("/tasks/task-1?panel=files&file=src/a%20b.ts");
    expect(useAppStore.getState().shownPanel).toEqual({ view: "task-1", id: "files" });
    expect(historyType()).toBe("POP");
  });

  it("opening and closing the panel from the page pushes one entry each", async () => {
    open("");

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    await waitFor(() => expect(address()).toBe("/tasks/task-1?panel=files"));
    expect(historyType()).toBe("PUSH");
    expect(panel()).toBeTruthy();
    expect(useAppStore.getState().shownPanel).toEqual({ view: "task-1", id: "files" });

    fireEvent.click(screen.getByRole("button", { name: "Show list" }));
    await waitFor(() => expect(address()).toBe("/tasks/task-1"));
    expect(historyType()).toBe("PUSH");
    await waitFor(() => expect(panel()).toBeNull());

    // Two pushes above the conversation: one Back reopens the list, a second
    // returns to the conversation.
    fireEvent.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() => expect(address()).toBe("/tasks/task-1?panel=files"));
    await waitFor(() => expect(panel()).toBeTruthy());
    expect(historyType()).toBe("POP");
  });

  it("a hidden pane does not answer a link for another conversation", async () => {
    render(
      <MemoryRouter initialEntries={["/tasks/task-2?panel=files&file=src/a%20b.ts"]}>
        <SwitchingPanes />
      </MemoryRouter>,
    );

    // The pane that still owns the screen answers to task-1, not task-2; the
    // incoming one is not active yet. Nobody consumes the link.
    expect(useAppStore.getState().shownPanel).toBeNull();
    expect(panel()).toBeNull();
    expect(address()).toBe("/tasks/task-2?panel=files&file=src/a%20b.ts");

    fireEvent.click(screen.getByRole("button", { name: "loaded" }));
    await waitFor(() => expect(panel()?.getAttribute("data-task")).toBe("task-2"));
    expect(panel()?.getAttribute("data-open-path")).toBe("src/a b.ts");
    expect(useAppStore.getState().shownPanel).toEqual({ view: "task-2", id: "files" });
    expect(address()).toBe("/tasks/task-2?panel=files&file=src/a%20b.ts");
  });

  it("a kept-alive pane reopens its file when Back returns it to the same entry", async () => {
    render(
      <MemoryRouter initialEntries={["/tasks/task-1?panel=files&file=src/a%20b.ts"]}>
        <KeptAlivePanes />
      </MemoryRouter>,
    );
    await waitFor(() => expect(panel()?.getAttribute("data-open-path")).toBe("src/a b.ts"));
    const linkKey = screen.getByTestId("location").getAttribute("data-key");

    // Another conversation takes the screen and opens its own files panel, so
    // the kept-alive pane is left with nothing open.
    fireEvent.click(screen.getByRole("button", { name: "other task" }));
    await waitFor(() => expect(panel()?.getAttribute("data-task")).toBe("task-2"));
    expect(panel()?.getAttribute("data-open-path")).toBe("");

    // Back lands on the very entry that named the file — the same location key
    // the pane applied before it went out of sight.
    fireEvent.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() => expect(address()).toBe("/tasks/task-1?panel=files&file=src/a%20b.ts"));
    expect(screen.getByTestId("location").getAttribute("data-key")).toBe(linkKey);
    await waitFor(() => expect(panel()?.getAttribute("data-task")).toBe("task-1"));
    expect(panel()?.getAttribute("data-open-path")).toBe("src/a b.ts");
    expect(useAppStore.getState().shownPanel).toEqual({ view: "task-1", id: "files" });
  });

  it("consuming focus leaves a neighbouring file byte-identical", async () => {
    open("?focus=ap-named&panel=files&file=src/a%20b.ts");

    // The focus consumer drops its own key; the file keeps its `%20`.
    await waitFor(() => expect(address()).toBe("/tasks/task-1?panel=files&file=src/a%20b.ts"));
    await waitFor(() => expect(panel()?.getAttribute("data-open-path")).toBe("src/a b.ts"));
    expect(useAppStore.getState().shownPanel).toEqual({ view: "task-1", id: "files" });
  });
});
