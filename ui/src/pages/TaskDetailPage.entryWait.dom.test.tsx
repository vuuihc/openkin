// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "../api/client";
import { setLocale } from "../i18n";
import { BRAND_MARK_PATH } from "../components/BrandMark";
import TaskDetailPage from "./TaskDetailPage";

/**
 * A list row navigates into `/tasks/<id>` and the detail GET is slow.
 *
 * The row makes `task` truthy, so the page draws its shell — header, title,
 * composer — from the cache, and the transcript scroller waits for the detail
 * invisibly. The middle of a phone screen was blank: the only waiting row
 * (`ChatStream`'s `ThinkingRow`) lives inside the `invisible` scroller, so the
 * page had no visible, named wait surface at all. This is that path, not the
 * no-row cold start the earlier tests covered.
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
    resolveWith(task: unknown, events: unknown[]) {
      state.task = task;
      state.events = events;
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
vi.mock("../hooks/useSlowHint", () => ({ useSlowHint: () => false }));
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

function open() {
  return render(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" fallbackTask={cached} />
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
  store.state.version = 0;
  store.state.loaded = false;
  store.state.task = null;
  store.state.events = [];
  store.state.error = null;
});

describe("entering a conversation from its list row", () => {
  it("shows a named wait surface in the transcript region while the detail is held", () => {
    open();
    // The shell is the cached row's: header, title, composer.
    expect(screen.getByTestId("mobile-header").textContent).toContain("Cached title");
    expect(screen.getByTestId("composer")).toBeTruthy();

    // The transcript region itself is the wait, and it is visible: the old
    // waiting row lived inside an `invisible` scroller, which is the blank.
    const region = screen.getByRole("region", { name: "Conversation" });
    const statuses = within(region).getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0].getAttribute("aria-label")).toMatch(/Loading/);
    expect(statuses[0].closest(".invisible")).toBeNull();

    // Nothing pretends the conversation is loaded: no scroller, no
    // `chat.thinking` row on a conversation that may already be finished.
    expect(screen.queryByTestId("chat-stream")).toBeNull();
  });

  it("the wait surface is the brand tile, not the blue block", () => {
    open();
    const status = screen.getByRole("status", { name: /Loading/ });
    expect(status.querySelector("svg path")?.getAttribute("d")).toBe(BRAND_MARK_PATH);
    expect(status.innerHTML).not.toContain("bg-kin-blue");
  });

  it("resolving the detail replaces the wait surface with the transcript", () => {
    open();
    expect(screen.getByRole("status", { name: /Loading/ })).toBeTruthy();
    act(() => {
      store.resolveWith({ ...cached, title: "Fresh title", status: "succeeded" }, [
        { seq: 1, kind: "message", payload: { text: "hello" } },
      ]);
    });
    expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
    expect(screen.getByTestId("chat-stream").getAttribute("data-loading")).toBe("false");
    expect(screen.getByRole("region", { name: "Conversation" })).toBeTruthy();
  });

  it("a failed detail keeps the error and drops the wait surface", () => {
    open();
    act(() => {
      store.fail(new Error("detail failed"));
    });
    expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("detail failed");
  });
});
