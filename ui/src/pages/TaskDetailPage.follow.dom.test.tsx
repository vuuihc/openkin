// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Task, TaskEvent } from "../api/client";
import { setLocale, t } from "../i18n";
import TaskDetailPage from "./TaskDetailPage";

/**
 * C3b: following a running conversation.
 *
 * New output belongs at the bottom while the reader is there, and it keeps
 * arriving below the fold while they read something older. Saying nothing is
 * how a running session looks stopped; moving the page under their eyes is how
 * reading becomes impossible. So the transcript pins only while the reader is
 * at the bottom, and otherwise offers one quiet way back — a real button, not
 * a toast, because it has to be reachable by keyboard and findable by name.
 *
 * jsdom has no layout, so this file supplies the three numbers the browser
 * would — content height, viewport height, and a `scrollTop` that clamps — the
 * same way `MobileList.dom.test.tsx` does.
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

// Hoisted: the api mock below is lifted above the imports, so its answer has
// to exist before this module's own values do.
const followUpPrompt = vi.hoisted(() => vi.fn());

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
// The transcript's own rendering is not the subject; the scroll region around
// it is. The composer is reduced to its one contract — a submit that calls the
// page's send handler — so the follow-up case can send without a real input.
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
let contentHeight = 1000;
let scrollTop = 0;

function installLayout() {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => contentHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => VIEWPORT,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, Math.max(0, contentHeight - VIEWPORT)));
    },
  });
}

/** The bottom position a browser would clamp to. */
const bottom = () => contentHeight - VIEWPORT;

function messageEvent(seq: number): TaskEvent {
  return {
    seq,
    type: "message",
    payload: { role: "assistant", speaker: "kin", text: `reply ${seq}`, model: "test-model" },
    created_at: seq,
  } as unknown as TaskEvent;
}

function appendMessage() {
  act(() => store.append(messageEvent(store.state.events.length + 1)));
}

function open() {
  const view = render(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" fallbackTask={task} />
    </MemoryRouter>,
  );
  const scroller = screen.getByRole("region", { name: t("task.transcript") });
  return { view, scroller };
}

function newActivity() {
  return screen.queryByRole("button", { name: t("task.newActivity") });
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
  contentHeight = 1000;
  scrollTop = 0;
  installLayout();
  store.reset();
  followUpPrompt.mockReset();
  followUpPrompt.mockResolvedValue({ ...task });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
});

describe("following a running conversation", () => {
  it("stays pinned to the bottom while the reader is at the bottom", () => {
    const { scroller } = open();
    expect(scroller.scrollTop).toBe(bottom());
    expect(newActivity()).toBeNull();

    contentHeight = 1400;
    appendMessage();

    expect(scroller.scrollTop).toBe(bottom());
    expect(newActivity()).toBeNull();
  });

  it("offers new activity only after the reader scrolls away", () => {
    const { scroller } = open();

    // Away from the bottom, but nothing has arrived yet: no pill.
    scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(newActivity()).toBeNull();

    contentHeight = 1400;
    appendMessage();

    expect(newActivity()).toBeTruthy();
    // The transcript did not move under the reader.
    expect(scroller.scrollTop).toBe(100);
  });

  it("the pill returns the reader to the newest message", () => {
    const { scroller } = open();
    scrollTop = 100;
    fireEvent.scroll(scroller);
    contentHeight = 1400;
    appendMessage();

    const pill = newActivity();
    expect(pill).toBeTruthy();
    fireEvent.click(pill!);

    expect(scroller.scrollTop).toBe(bottom());
    expect(newActivity()).toBeNull();

    // Back at the bottom, following resumes: the next arrival pins again.
    contentHeight = 1800;
    appendMessage();
    expect(scroller.scrollTop).toBe(bottom());
    expect(newActivity()).toBeNull();
  });

  it("the pill keeps its chevron and label on one row", () => {
    const { scroller } = open();
    scrollTop = 100;
    fireEvent.scroll(scroller);
    contentHeight = 1400;
    appendMessage();

    const pill = newActivity();
    expect(pill).toBeTruthy();
    // The chevron and the label share one nowrap inline-flex row: as bare
    // siblings inside the button's label span they would stack, because
    // Tailwind's preflight makes the icon's svg a block.
    const row = pill!.querySelector("span.inline-flex");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("items-center");
    expect(row!.className).toContain("whitespace-nowrap");
    expect(row!.querySelector("svg")).not.toBeNull();
    expect(row!.textContent).toBe(t("task.newActivity"));
  });

  it("a follow-up send clears the pill and re-pins", async () => {
    const { scroller } = open();
    scrollTop = 100;
    fireEvent.scroll(scroller);
    contentHeight = 1400;
    appendMessage();
    expect(newActivity()).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "send" }));
    await waitFor(() => expect(followUpPrompt).toHaveBeenCalledTimes(1));

    expect(newActivity()).toBeNull();
    expect(scroller.scrollTop).toBe(bottom());

    contentHeight = 1800;
    appendMessage();
    expect(scroller.scrollTop).toBe(bottom());
    expect(newActivity()).toBeNull();
  });
});
