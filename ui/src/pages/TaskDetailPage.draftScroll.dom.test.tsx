// @vitest-environment jsdom
// F4: a keystroke in the composer is draft text, not a reason to move the
// transcript.
//
// Measured in a real browser first (`scripts/measure-draft-scroll.mjs`, ten
// readings at 1100x760 and 820x1180, all 0 px), so this file is the guard that
// keeps the answer true: the page's `onValueChange` -> `persistFollowUpDraft`
// path writes refs and localStorage only, and must never reach the two layout
// effects that pin a reader to the bottom.
//
// jsdom has no layout, so this file supplies the numbers a browser would —
// the same prototype stubs `TaskDetailPage.scrollKept.dom.test.tsx` uses —
// and counts writes to the transcript's `scrollTop`, not just its value: a
// re-pin that happened to restore the same offset would still be a write.
import { useSyncExternalStore, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Task, TaskEvent } from "../api/client";
import { setLocale, t } from "../i18n";
import { getFollowUpDraft } from "../lib/followUpDraft";
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
    setEvents(events: unknown[]) {
      state.events = events;
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
// ask for, and a red would then say nothing about the keystroke.
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
// The real composer keeps its text in local state and reports every change
// through `onValueChange`; the page wiring around that callback is what this
// file tests, so the stand-in keeps the same contract (a controlled textarea,
// the draft reported on each edit) without the upload and run-config surface.
vi.mock("../components/chat/Composer", () => ({
  default: function ComposerStub({
    initialValue = "",
    placeholder,
    disabled,
    onValueChange,
  }: {
    initialValue?: string;
    placeholder?: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
  }) {
    const [value, setValue] = useState(initialValue);
    return (
      <textarea
        data-testid="composer-input"
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          onValueChange?.(next);
        }}
      />
    );
  },
}));
vi.mock("../components/chat/ChatStream", () => ({
  default: () => <div data-testid="chat-stream" />,
}));

const VIEWPORT = 400;
const BOTTOM_HEIGHT = 1400;
const MIDDLE = 320;
const bottomOf = (height: number) => Math.max(0, height - VIEWPORT);

let contentHeight = BOTTOM_HEIGHT;
let scrollTop = 0;
let hidden = false;
/** Writes to the transcript's own scrollTop. Counted, not inferred from value. */
let transcriptWrites = 0;
let transcriptEl: HTMLElement | null = null;

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
    set(this: HTMLElement, value: number) {
      if (this === transcriptEl) transcriptWrites += 1;
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

function open() {
  const view = render(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" active />
    </MemoryRouter>,
  );
  const scroller = screen.getByRole("region", { name: t("task.transcript") });
  transcriptEl = scroller;
  return { view, scroller };
}

/** The reader scrolls up to a passage: the same numbers Chrome reports, and
 * the scroll event the browser would deliver after the move. */
function scrollToReaderPlace(scroller: HTMLElement, top: number) {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
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
  transcriptWrites = 0;
  transcriptEl = null;
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

describe("F4: a composer keystroke leaves the transcript alone", () => {
  it("typing into the composer does not move the transcript", async () => {
    const user = userEvent.setup();
    store.setEvents(transcript(12));
    const { scroller } = open();

    // Opening lands at the end; the reader then scrolls up into the answer.
    expect(scroller.scrollTop).toBe(bottomOf(BOTTOM_HEIGHT));
    scrollToReaderPlace(scroller, MIDDLE);
    expect(scroller.scrollTop).toBe(MIDDLE);
    expect(getSessionScroll("task-1")).toBe(MIDDLE);

    const composer = screen.getByTestId("composer-input");
    await user.click(composer);
    transcriptWrites = 0;

    // One real key. Anything the page writes to the transcript after this is
    // the keystroke moving the reader.
    await user.type(composer, "x");

    expect(transcriptWrites).toBe(0);
    expect(scroller.scrollTop).toBe(MIDDLE);
    expect(scroller.scrollTop).not.toBe(bottomOf(BOTTOM_HEIGHT));
  });

  it("a draft keystroke leaves the composer value and focus intact", async () => {
    const user = userEvent.setup();
    store.setEvents(transcript(12));
    open();

    const composer = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    await user.click(composer);
    await user.type(composer, "x");

    // The character stays where it was typed, and the draft is the one the
    // page persists for this task.
    expect(composer.value).toBe("x");
    expect(document.activeElement).toBe(composer);
    expect(getFollowUpDraft("task-1").prompt).toBe("x");
  });
});
