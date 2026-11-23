// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "../api/client";
import { setLocale, t } from "../i18n";
import { getSessionScroll } from "../lib/sessionScroll";
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
// The page renders exactly one bar, chosen by this hook. These suites walk
// the phone bar, which is the header their `MobileHeader` mock stands in for.
vi.mock("../hooks/useMinWidth", () => ({ useMinWidth: () => false }));
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

// jsdom has no layout. The scroll-restore test below supplies the numbers a
// browser would — content height, viewport height and a clamping `scrollTop`.
// A browser fires `scroll` after any assignment that moves it, so the setter
// delivers that event too (after the assignment, as a browser does); the
// viewport height toggles to stand in for the keep-alive host's `display:none`.
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
    set(this: HTMLElement, value: number) {
      const next = Math.max(0, Math.min(value, Math.max(0, contentHeight - viewportHeight)));
      if (next === scrollTop) return;
      scrollTop = next;
      const node = this;
      queueMicrotask(() => node.dispatchEvent(new Event("scroll")));
    },
  });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  setLocale("en");
  localStorage.clear();
  contentHeight = 3644;
  viewportHeight = VIEWPORT;
  scrollTop = 0;
  installLayout();
  store.state.version = 0;
  store.state.loaded = false;
  store.state.task = null;
  store.state.events = [];
  store.state.error = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
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

  it("draws the iOS spinner on the cold-entry wait surface", () => {
    // No list row: the status element itself is the wait surface, and the
    // one-off arrival fade is named for the wait (`kin-wait-enter`), not for
    // the removed brand mark.
    const cold = render(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" />
      </MemoryRouter>,
    );
    const coldStatus = screen.getByRole("status", { name: t("common.loading") });
    expect(coldStatus.className).toContain("kin-wait-enter");
    expect(coldStatus.querySelectorAll(".kin-ios-spinner span")).toHaveLength(12);
    cold.unmount();

    // With a cached row, the transcript region is the surface and the status
    // nests inside it; both the fade's name and the wheel are pinned here.
    open();
    const region = screen.getByRole("region", { name: "Conversation" });
    expect(region.className).toContain("kin-wait-enter");
    const status = within(region).getByRole("status", { name: t("common.loading") });
    expect(status.querySelector(".kin-ios-spinner")).toBeTruthy();
  });

  it("the wait surface is the iOS wheel, not the brand tile", () => {
    open();
    const status = screen.getByRole("status", { name: /Loading/ });
    const wheel = status.querySelector(".kin-ios-spinner");
    // The familiar twelve-spoke indicator, hidden from the a11y tree because
    // the surrounding status role already says what is happening.
    expect(wheel?.getAttribute("aria-hidden")).toBe("true");
    expect(wheel?.querySelectorAll("span")).toHaveLength(12);
    expect(status.querySelector("svg")).toBeNull();
    expect(status.querySelector(".kin-brand-mark")).toBeNull();
    expect(status.innerHTML).not.toContain("bg-kin-blue");
  });

  it("resolving the detail replaces the wait surface with the transcript", async () => {
    open();
    expect(screen.getByRole("status", { name: /Loading/ })).toBeTruthy();
    // Await the opening jump's own `scroll` event inside act, as a browser
    // delivers it after the layout.
    await act(async () => {
      store.resolveWith({ ...cached, title: "Fresh title", status: "succeeded" }, [
        { seq: 1, kind: "message", payload: { text: "hello" } },
      ]);
    });
    expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
    expect(document.querySelector(".kin-ios-spinner")).toBeNull();
    expect(screen.getByTestId("chat-stream").getAttribute("data-loading")).toBe("false");
    expect(screen.getByRole("region", { name: "Conversation" })).toBeTruthy();
  });

  it("a failed detail keeps the error and drops the wait surface", () => {
    open();
    act(() => {
      store.fail(new Error("detail failed"));
    });
    expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
    expect(document.querySelector(".kin-ios-spinner")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("detail failed");
  });
});

/**
 * J9: switching conversations keeps the reader's place.
 *
 * A pane the session host shows again can be a frame shorter than the place
 * it was left at — the transcript is laid out again before its rows settle.
 * That frame must not be mistaken for "the reader is at the end": recording
 * the clamped `0` makes the next event pin them to the bottom of a
 * conversation they were reading.
 */
describe("coming back to a conversation", () => {
  const firstTurn = { seq: 1, kind: "message", payload: { text: "hello" } };

  async function openWithTranscript() {
    const view = render(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active fallbackTask={cached} />
      </MemoryRouter>,
    );
    // Flush the opening jump's own `scroll` event before the test moves the
    // reader, as a browser would deliver it in a later task.
    await act(async () => {
      store.resolveWith({ ...cached, status: "succeeded" }, [firstTurn]);
    });
    return view;
  }

  it("keeps the reader's place when the transcript is not laid out to it yet", async () => {
    const view = await openWithTranscript();
    const scroller = screen.getByRole("region", { name: t("task.transcript") });

    // The reader leaves the bottom and reads from 320.
    scrollTop = 320;
    fireEvent.scroll(scroller);

    // The host hides this pane while another conversation is opened
    // (`display:none` drops the DOM's scrollTop), then shows it again before
    // the transcript has been laid out to that depth.
    viewportHeight = 0;
    scrollTop = 0;
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active={false} fallbackTask={cached} />
      </MemoryRouter>,
    );
    contentHeight = 200;
    viewportHeight = VIEWPORT;
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active fallbackTask={cached} />
      </MemoryRouter>,
    );

    // The bookmark survives the clamped frame instead of being recorded as 0.
    expect(getSessionScroll("task-1")).toBe(320);

    // A frame later the transcript reaches past the viewport but still falls
    // short of the bookmark. The restore clamps to 100 and the browser fires
    // `scroll` for that move too; it is not the reader moving, so the
    // bookmark and the pending restore must survive it.
    contentHeight = 500;
    await act(async () => {
      store.resolveWith({ ...cached, status: "succeeded" }, [
        firstTurn,
        { seq: 2, kind: "message", payload: { text: "still laying out" } },
      ]);
    });
    expect(scroller.scrollTop).toBe(100);
    expect(getSessionScroll("task-1")).toBe(320);

    // Hiding and showing again at that same partial layout restores through
    // the activate path: it clamps to the same 100, and that `scroll` must
    // not be read as the reader moving either.
    viewportHeight = 0;
    scrollTop = 0;
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active={false} fallbackTask={cached} />
      </MemoryRouter>,
    );
    viewportHeight = VIEWPORT;
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" active fallbackTask={cached} />
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(scroller.scrollTop).toBe(100);
    expect(getSessionScroll("task-1")).toBe(320);

    // Rows land and the live conversation appends: the reader is put back at
    // their place, not pinned to the bottom of the new answer.
    contentHeight = 4000;
    await act(async () => {
      store.resolveWith({ ...cached, status: "succeeded" }, [
        firstTurn,
        { seq: 2, kind: "message", payload: { text: "still laying out" } },
        { seq: 3, kind: "message", payload: { text: "a new answer" } },
      ]);
    });
    expect(scroller.scrollTop).toBe(320);
    expect(getSessionScroll("task-1")).toBe(320);
  });
});
