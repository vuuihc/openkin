// @vitest-environment jsdom
// R-activity-pill: a reply that lands while the reader is scrolled away must
// announce itself. The send owns one pin of the transcript; while that pin is
// still owed, a growth that lands is never consumed silently — the transcript
// either pins (the send's own bubble, once) or the quiet New activity button is
// raised for it. It never moves the page under a reader who scrolled away.
//
// jsdom has no layout, so this file supplies the three numbers the browser
// would — content height, viewport height, and a `scrollTop` that clamps — the
// same way `TaskDetailPage.follow.dom.test.tsx` does. The seams are copied
// rather than shared: this suite owns its own composer and its own api mock.
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Task, TaskEvent } from "../api/client";
import { setLocale, t } from "../i18n";
import TaskDetailPage from "./TaskDetailPage";

const task = {
  id: "task-1",
  title: "Read the long answer",
  status: "running",
  agent: "kin",
  cwd: "/work/alpha",
  prompt: "read it",
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
    reset(events: unknown[] = []) {
      state.events = events;
      notify();
    },
  };
});

// One object across renders, like the query's cached data: a fresh array per
// render would re-run the transcript's pin effect after unrelated state
// changes and spend a pin this suite is holding open on purpose.
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
  usePendingResources: () => pendingResources,
}));

// The send has to be controllable: the race is about what a commit does while
// the POST is still in flight, so the test decides when (and whether) the
// request answers, not the mock's default.
const api = vi.hoisted(() => {
  let resolveSend: ((value: unknown) => void) | null = null;
  let rejectSend: ((error: unknown) => void) | null = null;
  return {
    followUpPrompt: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          resolveSend = resolve;
          rejectSend = reject;
        }),
    ),
    resolveSend(value: unknown) {
      resolveSend?.(value);
    },
    rejectSend(error: unknown) {
      rejectSend?.(error);
    },
    reset() {
      resolveSend = null;
      rejectSend = null;
    },
  };
});

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
    followUpPrompt: api.followUpPrompt,
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));
vi.mock("../components/mobile/MobileHeader", () => ({
  default: ({ title }: { title?: string }) => <div data-testid="mobile-header">{title}</div>,
  MobileHeaderButton: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
// The composer's one contract here: a submit that calls the page's send
// handler. The race is in the page, not in the input.
vi.mock("../components/chat/Composer", () => ({
  default: ({ onSubmit }: { onSubmit: (text: string) => unknown }) => (
    <form
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void Promise.resolve(onSubmit("hello")).catch(() => {});
      }}
    >
      <button type="submit">send</button>
    </form>
  ),
}));
// The transcript's rendering is not the subject; the scroll region around it
// is. The optimistic bubble is drawn from the page's pending sends so a test
// can see that the reader's own message made it on screen.
vi.mock("../components/chat/ChatStream", () => ({
  default: ({
    pendingUserMessages,
  }: {
    pendingUserMessages?: readonly { key: string; text: string }[];
  }) => (
    <div data-testid="chat-stream">
      {(pendingUserMessages ?? []).map((message) => (
        <div key={message.key} data-testid="pending-user">
          {message.text}
        </div>
      ))}
    </div>
  ),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The transcript's viewport is the scroll box minus the bottom band, so it is
// mutable: a band that gives a row back grows it without a single scroll.
let VIEWPORT = 400;
let contentHeight = 1000;
let scrollTop = 0;

function installLayout() {
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: { configurable: true, get: () => contentHeight },
    clientHeight: { configurable: true, get: () => VIEWPORT },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, Math.max(0, contentHeight - VIEWPORT)));
      },
    },
  });
}

/** The bottom position a browser would clamp to. */
const bottom = () => contentHeight - VIEWPORT;

const seedEvents = () =>
  [
    {
      seq: 1,
      type: "message",
      payload: { role: "assistant", speaker: "kin", text: "the answer so far", model: "m" },
      created_at: 1,
    },
  ] as unknown as TaskEvent[];

function messageEvent(seq: number): TaskEvent {
  return {
    seq,
    type: "message",
    payload: { role: "assistant", speaker: "kin", text: `reply ${seq}`, model: "m" },
    created_at: seq,
  } as unknown as TaskEvent;
}

/** The daemon's own copy of what the person sent. */
function echoEvent(seq: number): TaskEvent {
  return {
    seq,
    type: "message",
    payload: { role: "user", speaker: "user", text: "hello" },
    created_at: seq,
  } as unknown as TaskEvent;
}

function appendReply() {
  act(() => store.append(messageEvent(store.state.events.length + 1)));
}

function newActivityButton() {
  return screen.queryByRole("button", { name: t("task.newActivity") });
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

async function sendFromComposer() {
  await act(async () => {
    fireEvent.submit(screen.getByTestId("composer"));
  });
}

/** The keep-alive host hiding and showing the same mounted pane. */
function renderWithActive(active: boolean) {
  return (
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" fallbackTask={task} active={active} />
    </MemoryRouter>
  );
}

/** The reader moves themselves to an older line. */
function scrollAway(scroller: HTMLElement, top = 100) {
  scrollTop = top;
  fireEvent.scroll(scroller);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  setLocale("en");
  localStorage.clear();
  VIEWPORT = 400;
  contentHeight = 1000;
  scrollTop = 0;
  store.reset(seedEvents());
  api.reset();
  api.followUpPrompt.mockClear();
  installLayout();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ["scrollHeight", "clientHeight", "scrollTop"]) {
    Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});

describe("a follow-up's reply while the send pin is owed", () => {
  it("a reply that lands while a follow-up send is pending raises the new-activity pill", async () => {
    const { scroller } = open();
    // The opening layout landed at the end.
    expect(scroller.scrollTop).toBe(bottom());

    // Send, and leave the POST in flight: `sending` is true and the send's
    // pin is the one thing that may place the transcript. The optimistic
    // bubble is on screen before the request answers.
    await sendFromComposer();
    expect(api.followUpPrompt).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pending-user").textContent).toBe("hello");

    // The reader scrolls up to something older while the reply is on its way.
    scrollAway(scroller);

    // The reply lands — content grows and the agent's message arrives — while
    // the send request is still pending.
    contentHeight = 1400;
    appendReply();

    const pill = newActivityButton();
    expect(pill).not.toBeNull();
    expect(pill!.hasAttribute("disabled")).toBe(false);
  });

  it("that reply does not move the reader's scroll position", async () => {
    const { scroller } = open();
    await sendFromComposer();
    scrollAway(scroller, 100);

    contentHeight = 1400;
    appendReply();

    expect(scroller.scrollTop).toBe(100);
    expect(scroller.scrollTop).not.toBe(bottom());
  });

  it("the send's own bubble still pins to the end once", async () => {
    const { scroller } = open();

    // The reader had scrolled up before sending. Sending is choosing the end,
    // and the pin the send owns is the only thing that may take them there:
    // it places their own bubble, once.
    scrollAway(scroller, 100);
    await sendFromComposer();
    expect(scroller.scrollTop).toBe(bottom());
    expect(newActivityButton()).toBeNull();

    // The daemon echoes the message. The transcript is already at the end, so
    // the echo is seen where it lands: still the end, and no pill is offered.
    contentHeight = 1400;
    act(() => store.append(echoEvent(store.state.events.length + 1)));
    expect(scroller.scrollTop).toBe(bottom());
    expect(scroller.scrollTop).toBe(contentHeight - VIEWPORT);
    expect(newActivityButton()).toBeNull();
  });

  it("a reply that lands while the reader is at the end raises no pill", () => {
    const { scroller } = open();
    contentHeight = 1400;
    appendReply();
    expect(scroller.scrollTop).toBe(bottom());
    expect(newActivityButton()).toBeNull();
  });

  // J16's tablet run: the reader parked 140px above the end, and the reply that
  // landed was filed as seen. The bottom band is part of the scroll region the
  // transcript measures, so a band that gives a row back — the pill dropping, a
  // waiting strip collapsing — grows `clientHeight` and shrinks the gap to the
  // end with no scroll at all. A live-distance test then answers "caught up"
  // for a reader who never moved, and the arrival under the fold is silent. The
  // pill asks the reader's follow intent instead, which only their own scrolls
  // (or a place this page chose: the send pin, a restore, Show newest) write.
  it("a band that gives height back under a parked reader does not swallow the next reply", () => {
    const { scroller } = open();

    // Parked above the fold at the size the reader saw: 100px of unread content
    // below, outside the 96px catch-up line.
    scrollAway(scroller, 500);
    expect(newActivityButton()).toBeNull();

    // The band gives 40px back. No scroll fired; the reader is where they were.
    VIEWPORT = 440;

    // A short reply lands. The live gap is now 90px — inside the catch-up line
    // — but it is still below a reader who has not asked to come down.
    contentHeight = 1030;
    appendReply();

    expect(scroller.scrollTop).toBe(500);
    expect(newActivityButton()).not.toBeNull();
  });

  // The place a restore still owes the reader outranks the send's pin: the
  // layout effect returns from the restore branch without spending it. The
  // growth that finally reaches the saved line therefore lands with the pin
  // still owed — and the pre-fix growth effect suppressed that reply because
  // `sending` was true, so a reader parked at their restored line was never
  // told it arrived.
  it("a reply that lands when a restore still owes the pin raises the pill at the restored place", async () => {
    const { view, scroller } = open();
    // The reader's place is a middle line of a longer transcript...
    contentHeight = 1400;
    scrollAway(scroller, 700);
    // ...unreachable for a frame while the pane is hidden and the transcript
    // has not laid its rows out again: showing it leaves the restore pending.
    contentHeight = 800;
    view.rerender(renderWithActive(false));
    view.rerender(renderWithActive(true));
    expect(scroller.scrollTop).toBe(bottom());

    // Send with the POST in flight. This commit cannot reach the saved line
    // either, so the pin stays owed behind the restore.
    await sendFromComposer();
    expect(scroller.scrollTop).toBe(bottom());

    // The transcript grows enough to hold the saved line and the reply.
    contentHeight = 1400;
    appendReply();

    expect(scroller.scrollTop).toBe(700);
    expect(newActivityButton()).not.toBeNull();
  });

  // Line 953's refund: the reader moved after sending, while a restore still
  // held the pin open. Their new place must win over both the restore they
  // overrode and the send's pin.
  it("a reader who scrolls away from a pending restore keeps their place when the reply lands", async () => {
    const { view, scroller } = open();
    contentHeight = 1400;
    scrollAway(scroller, 700);
    contentHeight = 800;
    view.rerender(renderWithActive(false));
    view.rerender(renderWithActive(true));
    await sendFromComposer();

    // The reader chooses another line while the POST is still in flight.
    scrollAway(scroller, 100);

    contentHeight = 1400;
    appendReply();

    expect(scroller.scrollTop).toBe(100);
    expect(newActivityButton()).not.toBeNull();
  });
});
