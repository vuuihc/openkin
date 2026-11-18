// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Task, TaskEvent } from "../api/client";
import { setLocale, t } from "../i18n";
import TaskDetailPage from "./TaskDetailPage";

/**
 * J9: switching conversations keeps the reader's place.
 *
 * The session host keeps recent panes alive and hides the ones behind the
 * current conversation with `display:none`. A hidden scroller reports
 * `clientHeight === 0` and its `scrollTop` reads back 0, so the position the
 * reader left has to survive in the page and be re-applied when the pane is
 * shown again — across a live transcript that kept growing while it was away.
 *
 * jsdom has no layout; this file supplies the numbers a browser would —
 * content height, viewport height and a clamping `scrollTop` — the same way
 * `TaskDetailPage.follow.dom.test.tsx` does, and toggles the viewport height
 * to stand in for `display:none`.
 */

const task = {
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

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { version: 0, events: [] as unknown[] };
  const notify = () => {
    state.version += 1;
    for (const listener of listeners) listener();
  };
  return {
    state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => state.version,
    append(event: unknown) {
      state.events = [...state.events, event];
      notify();
    },
    reset() {
      state.events = [];
      notify();
    },
  };
});

vi.mock("../api/useLiveResources", () => ({
  useTaskResource: (id: string) => {
    useSyncExternalStore(store.subscribe, store.version, store.version);
    return {
      loaded: true,
      error: null,
      data: {
        task: { ...task, id },
        events: store.state.events as TaskEvent[],
        deleted: false,
      },
      id,
    };
  },
  usePendingResources: () => ({
    loaded: true,
    error: null,
    loading: false,
    data: { approvals: [], questions: [] },
  }),
}));

// A send that is accepted but not yet answered, so `sending` stays true while
// the rest of the journey runs — a task blocked on an approval holds queued
// prompts exactly like this.
const followUpPrompt = vi.hoisted(() => vi.fn(() => new Promise<never>(() => {})));

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
    followUpPrompt,
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
  default: ({ onSubmit }: { onSubmit: (text: string) => unknown }) => (
    <form
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit("follow up");
      }}
    >
      <button type="submit">send</button>
    </form>
  ),
}));
vi.mock("../components/chat/ChatStream", () => ({
  default: () => <div data-testid="chat-stream" />,
}));

const VIEWPORT = 400;
let contentHeight = 3644;
let viewportHeight = VIEWPORT;
let scrollTop = 0;

function installLayout() {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => contentHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => viewportHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, Math.max(0, contentHeight - viewportHeight)));
    },
  });
}

function messageEvent(seq: number): TaskEvent {
  return {
    seq,
    type: "message",
    payload: { role: "assistant", speaker: "kin", text: `reply ${seq}`, model: "test-model" },
    created_at: seq,
  } as unknown as TaskEvent;
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  setLocale("en");
  localStorage.clear();
  contentHeight = 3644;
  viewportHeight = VIEWPORT;
  scrollTop = 0;
  installLayout();
  store.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
});

describe("switching away and back keeps the transcript's place", () => {
  it("re-applies the reader's scrollTop when the hidden pane is shown again", () => {
    const view = render(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active fallbackTask={task} />
      </MemoryRouter>,
    );
    const scroller = screen.getByRole("region", { name: t("task.transcript") });

    // The reader leaves the bottom and reads from 320.
    scrollTop = 320;
    fireEvent.scroll(scroller);

    // The host hides this pane for another conversation (display:none): the
    // browser drops the scroll position and the scroller has no height.
    viewportHeight = 0;
    scrollTop = 0;
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active={false} fallbackTask={task} />
      </MemoryRouter>,
    );

    // It comes back, with output that arrived while the reader was away.
    contentHeight = 4200;
    viewportHeight = VIEWPORT;
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active fallbackTask={task} />
      </MemoryRouter>,
    );

    expect(scroller.scrollTop).toBe(320);
  });

  it("does not drag a reader who scrolled away back down while a send is in flight", async () => {
    render(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active fallbackTask={task} />
      </MemoryRouter>,
    );
    const scroller = screen.getByRole("region", { name: t("task.transcript") });

    // A send is accepted but never answered — the task is blocked on an
    // approval, so queued prompts hold `sending` true for the rest of the visit.
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    await waitFor(() => expect(followUpPrompt).toHaveBeenCalledTimes(1));

    // The reader leaves the bottom after sending.
    scrollTop = 320;
    fireEvent.scroll(scroller);

    // A queued turn is answered while the send is still in flight.
    contentHeight = 4200;
    act(() => store.append(messageEvent(1)));

    // Their place wins over "you just sent something".
    expect(scroller.scrollTop).toBe(320);
  });

  it("keeps the saved place while output arrives in the hidden pane", () => {
    const view = render(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active fallbackTask={task} />
      </MemoryRouter>,
    );
    const scroller = screen.getByRole("region", { name: t("task.transcript") });

    scrollTop = 320;
    fireEvent.scroll(scroller);

    viewportHeight = 0;
    scrollTop = 0;
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active={false} fallbackTask={task} />
      </MemoryRouter>,
    );

    // A live conversation keeps growing behind the reader's back.
    contentHeight = 4200;
    act(() => store.append(messageEvent(1)));

    viewportHeight = VIEWPORT;
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active fallbackTask={task} />
      </MemoryRouter>,
    );

    expect(scroller.scrollTop).toBe(320);
  });
});
