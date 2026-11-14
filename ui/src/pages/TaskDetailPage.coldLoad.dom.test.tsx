// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "../api/client";
import { setLocale } from "../i18n";
import TaskDetailPage from "./TaskDetailPage";

/**
 * A cold entry into a conversation draws the chrome first.
 *
 * The page used to return a full-screen skeleton until `GET /api/tasks/:id`
 * answered: on a phone the header and the composer vanished and the screen
 * read as a reload. The list row the shell already holds is the same `Task`
 * shape, so the header, title and composer can exist from the first frame and
 * only the transcript waits.
 */

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    version: 0,
    loaded: false,
    task: null as unknown,
    events: [] as unknown[],
    error: null as unknown,
  };
  return {
    state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => state.version,
    resolve(task: unknown) {
      state.task = task;
      state.loaded = true;
      state.version += 1;
      for (const listener of listeners) listener();
    },
    fail(error: unknown) {
      state.error = error;
      state.loaded = true;
      state.version += 1;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../api/useLiveResources", () => ({
  useTaskResource: (id: string) => {
    useSyncExternalStore(store.subscribe, store.version, store.version);
    return {
      loaded: store.state.loaded,
      error: store.state.error,
      data: {
        task: store.state.loaded ? store.state.task : null,
        events: store.state.loaded ? store.state.events : [],
        deleted: false,
      },
      id,
    };
  },
  usePendingResources: () => ({ data: { approvals: [], questions: [] } }),
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
vi.mock("../components/mobile/MobileHeader", () => ({
  default: ({ title, trailing }: { title?: string; trailing?: ReactNode }) => (
    <div data-testid="mobile-header">
      {title}
      {trailing}
    </div>
  ),
  MobileHeaderButton: ({
    label,
    children,
  }: {
    label?: string;
    children?: ReactNode;
  }) => (
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
  default: ({ loading }: { loading?: boolean }) => (
    <div data-testid="chat-stream" data-loading={String(Boolean(loading))} />
  ),
}));

const cached = {
  id: "task-1",
  title: "Cached title",
  status: "running",
  agent: "kin",
  cwd: "/work/alpha",
  prompt: "hello",
  tokens_in: 0,
  tokens_out: 0,
  event_epoch: 0,
  created_at: 1,
} as unknown as Task;

function open(fallbackTask?: Task) {
  return render(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" fallbackTask={fallbackTask} />
    </MemoryRouter>,
  );
}

/**
 * The scroll-restore layout effect observes the transcript once the detail has
 * answered. jsdom has no ResizeObserver; nothing in this test depends on its
 * callbacks, only on the page mounting.
 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  setLocale("en");
  localStorage.clear();
  store.state.version = 0;
  store.state.loaded = false;
  store.state.task = null;
  store.state.events = [];
  store.state.error = null;
});

describe("a cold entry into a conversation", () => {
  it("draws the header and composer from the cached row while the detail loads", () => {
    open(cached);
    expect(screen.getByTestId("mobile-header").textContent).toContain("Cached title");
    // The conversation header has no second conversation list on it. The
    // phone's one list is `/sessions` (KIN-CONTINUE-002); session actions is
    // the only trailing menu.
    expect(screen.getByRole("button", { name: "Session actions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Switch session/ })).toBeNull();
    expect(screen.getByTestId("composer").getAttribute("data-disabled")).toBe("true");
    expect(screen.getByTestId("chat-stream").getAttribute("data-loading")).toBe("true");
  });

  it("removes the transcript loading state when the detail answers", () => {
    open(cached);
    expect(screen.getByTestId("chat-stream").getAttribute("data-loading")).toBe("true");
    act(() => {
      store.resolve({ ...cached, title: "Fresh title", status: "succeeded" });
    });
    expect(screen.getByTestId("chat-stream").getAttribute("data-loading")).toBe("false");
  });

  it("drops the indicator and keeps the error state when the detail fails", () => {
    open(cached);
    act(() => {
      store.fail(new Error("detail failed"));
    });
    expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("detail failed");
  });

  it("keeps the same shell and swaps only the transcript when the detail answers", () => {
    open(cached);
    act(() => {
      store.resolve({ ...cached, title: "Fresh title", status: "succeeded" });
    });
    expect(screen.getByTestId("mobile-header").textContent).toContain("Fresh title");
    expect(screen.getByTestId("composer").getAttribute("data-disabled")).toBe("false");
    expect(screen.getByTestId("chat-stream").getAttribute("data-loading")).toBe("false");
  });

  it("shows a page skeleton while a cold entry has no row to draw", () => {
    open();
    expect(document.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("mobile-header")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.getByRole("status", { name: /Loading/ })).toBeTruthy();
  });

  it("leaves the brand mark for the real page once the detail answers", () => {
    open();
    act(() => {
      store.resolve({ ...cached, title: "Fresh title", status: "succeeded" });
    });
    expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
    expect(screen.getByTestId("mobile-header").textContent).toContain("Fresh title");
  });
});
