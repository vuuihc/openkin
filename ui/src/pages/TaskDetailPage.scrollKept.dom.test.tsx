// @vitest-environment jsdom
// J9/J11: leaving a conversation and coming back must return the reader to the
// line they were reading, not to the end. The transcript already remembers the
// place (`sessionScroll` + `savedScrollTopRef`); what these cases pin is that a
// late scroll event, a remount, or a first event after the restore cannot turn
// "follow the end" back on and spend the bookmark.
//
// jsdom has no layout, so this file supplies the numbers a browser would —
// content height, viewport height, and a `scrollTop` that clamps — the same way
// `TaskDetailPage.follow.dom.test.tsx` and `MobileList.dom.test.tsx` do. The
// pane is modelled the way the keep-alive host draws it: `active=false` means
// `display:none`, and a display:none element reports 0 for scrollTop,
// scrollHeight and clientHeight (measured in Chrome for this change).
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Task, TaskEvent } from "../api/client";
import { setLocale, t } from "../i18n";
import { getSessionScroll } from "../lib/sessionScroll";
import TaskDetailPage from "./TaskDetailPage";

const task = {
  id: "task-1",
  title: "Morning planning",
  status: "succeeded",
  agent: "kin",
  cwd: "/work/alpha",
  prompt: "plan the day",
  tokens_in: 0,
  tokens_out: 0,
  event_epoch: 0,
  created_at: 1,
} as unknown as Task;

/**
 * The task detail the live resource holds. `loaded` is the GET's answer: a
 * conversation already in the shared cache answers on the first render; a cold
 * one starts false and resolves later.
 */
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    version: 0,
    loaded: true,
    events: [] as unknown[],
  };
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
    setLoaded(loaded: boolean) {
      state.loaded = loaded;
      notify();
    },
    setEvents(events: unknown[]) {
      state.events = events;
      notify();
    },
    append(event: unknown) {
      state.events = [...state.events, event];
      notify();
    },
    reset() {
      state.loaded = true;
      state.events = [];
      notify();
    },
  };
});

// Stable identities, like the live store's own snapshot: a fresh array on
// every render would re-run the follow effect for reasons the test did not
// ask for, and a red would then say nothing about the scroll restore.
const pendingResources = vi.hoisted(() => ({
  loaded: true,
  error: null,
  loading: false,
  data: { approvals: [] as unknown[], questions: [] as unknown[] },
}));

vi.mock("../api/useLiveResources", () => ({
  useTaskResource: (id: string) => {
    useSyncExternalStore(store.subscribe, store.version, store.version);
    return {
      loaded: store.state.loaded,
      error: null,
      data: {
        task: { ...task, id },
        events: store.state.events as TaskEvent[],
        deleted: false,
      },
    };
  },
  usePendingResources: () => pendingResources,
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
    followUpPrompt: never,
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));
vi.mock("../components/mobile/MobileHeader", () => ({
  default: ({ title }: { title?: string }) => <div>{title}</div>,
  MobileHeaderButton: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("../components/chat/Composer", () => ({
  default: () => <div data-testid="composer" />,
}));
vi.mock("../components/chat/ChatStream", () => ({
  default: () => <div data-testid="chat-stream" />,
}));

const VIEWPORT = 400;
const BOTTOM_HEIGHT = 1400;
const MIDDLE = 320;
const bottomOf = (height: number) => Math.max(0, height - VIEWPORT);

/** What the browser reports for the transcript right now. */
let contentHeight = BOTTOM_HEIGHT;
let scrollTop = 0;
/** `display:none` on the pane's host: every layout number reads 0. */
let hidden = false;

function installLayout() {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => (hidden ? 0 : contentHeight),
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => (hidden ? 0 : VIEWPORT),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => (hidden ? 0 : scrollTop),
    set: (value: number) => {
      if (hidden) return;
      scrollTop = Math.max(0, Math.min(value, Math.max(0, contentHeight - VIEWPORT)));
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

function transcript(count: number): TaskEvent[] {
  return Array.from({ length: count }, (_, index) => messageEvent(index + 1));
}

function open(active: boolean) {
  const view = render(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" active={active} />
    </MemoryRouter>,
  );
  const scroller = screen.getByRole("region", { name: t("task.transcript") });
  return { view, scroller };
}

/** Rerender the same instance with another `active` value (the host's hide/show). */
function show(view: ReturnType<typeof open>["view"], active: boolean) {
  view.rerender(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" active={active} />
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
  Element.prototype.scrollIntoView = vi.fn();
  setLocale("en");
  localStorage.clear();
  contentHeight = BOTTOM_HEIGHT;
  scrollTop = 0;
  hidden = false;
  store.reset();
  installLayout();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
});

describe("the reader's place across a conversation switch", () => {
  it("keeps the reader's place when the conversation is reopened", () => {
    store.setEvents(transcript(12));
    const { view, scroller } = open(true);
    // Opening lands at the end (there is no saved place yet).
    expect(scroller.scrollTop).toBe(bottomOf(BOTTOM_HEIGHT));

    // The reader scrolls up to a passage. The product records it on the scroll
    // event, the way a real scroller reports the move.
    scrollTop = MIDDLE;
    fireEvent.scroll(scroller);
    expect(getSessionScroll("task-1")).toBe(MIDDLE);

    // Leaving: the keep-alive host adds `display:none`. A flick's last scroll
    // event is still queued and lands after the hide, when the element reports
    // 0/0/0 — not the reader moving.
    show(view, false);
    hidden = true;
    fireEvent.scroll(scroller);

    // Coming back: the pane is shown again in the same place the browser left
    // it (a browser that drops it reports 0; the restore must still be right).
    hidden = false;
    scrollTop = 0;
    show(view, true);
    expect(scroller.scrollTop).toBe(MIDDLE);

    // One more event arrives after the restore. It belongs at the end for a
    // reader who is at the end; this reader is not.
    contentHeight = 1800;
    act(() => store.append(messageEvent(13)));

    expect(scroller.scrollTop).toBe(MIDDLE);
    expect(scroller.scrollTop).not.toBe(bottomOf(1800));
  });

  it("a late event does not pin a restored place to the bottom", () => {
    store.setEvents(transcript(12));
    const first = open(true);
    expect(first.scroller.scrollTop).toBe(bottomOf(BOTTOM_HEIGHT));

    scrollTop = MIDDLE;
    fireEvent.scroll(first.scroller);
    expect(getSessionScroll("task-1")).toBe(MIDDLE);

    // The pane is evicted from the keep-alive cache and reopened. The shared
    // detail still answers on the first render, so this is a remount, not a
    // cold GET: the restore runs before the first event can arrive.
    first.view.unmount();
    scrollTop = 0;
    const reopened = open(true);
    expect(reopened.scroller.scrollTop).toBe(MIDDLE);

    // The transcript grows a moment after the restore.
    contentHeight = 1800;
    act(() => store.append(messageEvent(13)));

    expect(reopened.scroller.scrollTop).toBe(MIDDLE);
    expect(reopened.scroller.scrollTop).not.toBe(bottomOf(1800));
  });

  it("a reader at the bottom still follows new output", () => {
    store.setEvents(transcript(12));
    const { scroller } = open(true);
    expect(scroller.scrollTop).toBe(bottomOf(BOTTOM_HEIGHT));

    // Nothing moved the reader away: the next event still lands at the end.
    contentHeight = 1800;
    act(() => store.append(messageEvent(13)));

    expect(scroller.scrollTop).toBe(bottomOf(1800));
  });
});
