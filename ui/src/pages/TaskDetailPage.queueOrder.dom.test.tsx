// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, type QueuedPrompt, type Task, type TaskEvent } from "../api/client";
import { setLocale, t } from "../i18n";
import { EDIT_IN_FLIGHT_MS } from "../lib/queuedPrompts";
import { useAppStore } from "../store/appStore";
import TaskDetailPage from "./TaskDetailPage";

/**
 * Reordering the queue from the badge.
 *
 * The page owns the daemon call and the answer is what the badge numbers: the
 * transcript never re-sorts itself. A 409 means somebody else moved a row, so
 * the page re-reads and says so rather than guessing. And answers can land out
 * of order — a later move's answer owns the queue, an earlier one that arrives
 * afterwards is dropped (AGENTS.md §11: every async answer carries its origin).
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
      state.version += 1;
      for (const listener of listeners) listener();
    },
  };
});

const api = vi.hoisted(() => ({
  listQueuedPrompts: vi.fn(),
  reorderQueuedPrompts: vi.fn(),
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
  usePendingResources: () => ({
    loaded: true,
    error: null,
    loading: false,
    data: { approvals: [], questions: [] },
  }),
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
    listQueuedPrompts: api.listQueuedPrompts,
    listWorkerSteps: never,
    reorderQueuedPrompts: api.reorderQueuedPrompts,
    followUpPrompt: never,
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
  default: () => <form data-testid="composer" />,
}));

function messageEvent(seq: number, text: string): TaskEvent {
  return {
    task_id: "task-1",
    event_epoch: 0,
    seq,
    ts: seq,
    type: "message",
    payload: { role: "user", content: [{ type: "text", text }] },
  } as unknown as TaskEvent;
}

function prompt(id: number, seq: number): QueuedPrompt {
  return {
    id,
    prompt: `message ${seq}`,
    user_seq: seq,
    queued_at: seq,
    position: seq,
  } as unknown as QueuedPrompt;
}

const one = prompt(101, 1);
const two = prompt(102, 2);
const three = prompt(103, 3);

/** The place-in-line the badge shows for the message with this text. */
function placeOf(text: string): string | null {
  const row = screen.getByText(text).closest("[data-message-key]");
  return row?.querySelector("[data-queue-place]")?.textContent ?? null;
}

function moveDown(text: string): HTMLElement {
  return screen.getByRole("button", {
    name: t("chat.moveQueuedDownNamed", { text }),
  });
}

async function open() {
  const view = render(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" fallbackTask={task} />
    </MemoryRouter>,
  );
  // The queue read is debounced 250ms behind the mount.
  await waitFor(() => expect(screen.getAllByText(t("chat.queued"))).toHaveLength(3));
  await waitFor(() => expect(placeOf("second thought")).toBe("2"));
  return view;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function deferredRejection<T>() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_, r) => {
    reject = r;
  });
  return { promise, reject };
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  setLocale("en");
  store.setEvents([
    messageEvent(1, "first thought"),
    messageEvent(2, "second thought"),
    messageEvent(3, "third thought"),
  ]);
  api.listQueuedPrompts.mockReset();
  api.reorderQueuedPrompts.mockReset();
  api.listQueuedPrompts.mockResolvedValue([one, two, three]);
  useAppStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reordering the queue", () => {
  it("a poll started before a move cannot restore the old order", async () => {
    const poll = deferred<QueuedPrompt[]>();
    api.listQueuedPrompts.mockResolvedValueOnce([one, two, three]).mockReturnValue(poll.promise);
    api.reorderQueuedPrompts.mockResolvedValue([one, three, two]);
    await open();
    await waitFor(() => expect(api.listQueuedPrompts).toHaveBeenCalledTimes(2), { timeout: 3500 });
    fireEvent.click(moveDown("second thought"));
    await waitFor(() => expect(placeOf("second thought")).toBe("3"));
    await act(async () => poll.resolve([one, two, three]));
    expect(placeOf("second thought")).toBe("3");
  });

  it("leaving a conversation drops its pending reorder answer", async () => {
    const move = deferred<QueuedPrompt[]>();
    api.reorderQueuedPrompts.mockReturnValue(move.promise);
    const view = await open();
    fireEvent.click(moveDown("second thought"));
    api.listQueuedPrompts.mockResolvedValue([three, two, one]);
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-2" fallbackTask={{ ...task, id: "task-2" }} />
      </MemoryRouter>,
    );
    // Settle before the next conversation's first read, so only the visit
    // invalidation can stop this answer from briefly showing the wrong badges.
    await act(async () => move.resolve([one, three, two]));
    expect(screen.queryAllByText(t("chat.queued"))).toHaveLength(0);
    await waitFor(() => expect(placeOf("third thought")).toBe("1"));
    expect(placeOf("first thought")).toBe("3");
  });

  it("a double tap sends the permutation only once", async () => {
    const move = deferred<QueuedPrompt[]>();
    api.reorderQueuedPrompts.mockReturnValue(move.promise);
    await open();
    fireEvent.click(moveDown("second thought"));
    fireEvent.click(moveDown("second thought"));
    expect(api.reorderQueuedPrompts).toHaveBeenCalledTimes(1);
    await act(async () => move.resolve([one, three, two]));
  });

  it("a queue read skipped during a move runs again when the move settles", async () => {
    const move = deferred<QueuedPrompt[]>();
    api.reorderQueuedPrompts.mockReturnValue(move.promise);
    await open();
    const reads = api.listQueuedPrompts.mock.calls.length;
    fireEvent.click(moveDown("second thought"));

    // An event lands while the move is in flight. The poll must not read over
    // the write, so it defers instead of dropping the read on the floor.
    api.listQueuedPrompts.mockResolvedValue([three, two, one]);
    act(() =>
      store.setEvents([
        messageEvent(1, "first thought"),
        messageEvent(2, "second thought"),
        messageEvent(3, "third thought"),
        messageEvent(4, "fourth thought"),
      ]),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(api.listQueuedPrompts).toHaveBeenCalledTimes(reads);

    // The answer arrives. The read the poll deferred has to follow it: the
    // move's answer is not the queue another device may have changed, and a
    // read skipped at a turn boundary would otherwise stay lost until the slow
    // poll. The daemon's list here is an order the move never sent.
    await act(async () => move.resolve([one, three, two]));
    await waitFor(() => expect(placeOf("third thought")).toBe("1"), { timeout: 1500 });
    expect(placeOf("first thought")).toBe("3");
  });

  it("a move that never answers stops owning the queue after its deadline", async () => {
    const move = deferred<QueuedPrompt[]>();
    api.reorderQueuedPrompts.mockReturnValue(move.promise);
    await open();

    const clock = vi.spyOn(Date, "now");
    const startedAt = Date.now();
    clock.mockReturnValue(startedAt);

    fireEvent.click(moveDown("second thought"));
    expect(api.reorderQueuedPrompts).toHaveBeenCalledTimes(1);
    // Still inside the deadline: the same permutation is one request, not two.
    fireEvent.click(moveDown("second thought"));
    expect(api.reorderQueuedPrompts).toHaveBeenCalledTimes(1);

    // The request hangs. `apiFetch` has no timeout, so past the edit deadline
    // the poll reads again and the arrows accept a new move, instead of the
    // page refusing both for the life of the conversation.
    const reads = api.listQueuedPrompts.mock.calls.length;
    clock.mockReturnValue(startedAt + EDIT_IN_FLIGHT_MS + 1);
    act(() =>
      store.setEvents([
        messageEvent(1, "first thought"),
        messageEvent(2, "second thought"),
        messageEvent(3, "third thought"),
        messageEvent(4, "fourth thought"),
      ]),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(api.listQueuedPrompts).toHaveBeenCalledTimes(reads + 1);

    fireEvent.click(moveDown("second thought"));
    expect(api.reorderQueuedPrompts).toHaveBeenCalledTimes(2);

    await act(async () => move.resolve([one, three, two]));
    clock.mockRestore();
  });

  it("a 409 that lands after the pane is hidden says nothing", async () => {
    const move = deferredRejection<QueuedPrompt[]>();
    api.reorderQueuedPrompts.mockReturnValue(move.promise);
    const view = await open();
    fireEvent.click(moveDown("second thought"));

    // `TaskSessionHost` hides a pane without changing its id: the answer now
    // belongs to a screen the reader has left, so it must not toast over the
    // next conversation or the list.
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" fallbackTask={task} active={false} />
      </MemoryRouter>,
    );
    await act(async () => move.reject(new ApiError(409, "queue changed")));

    expect(useAppStore.getState().toasts).toHaveLength(0);
    expect(placeOf("second thought")).toBe("2");

    // Coming back re-reads the queue: the pane missed the poll while hidden,
    // so showing it again must not resurrect the order from before the leave.
    const reads = api.listQueuedPrompts.mock.calls.length;
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" fallbackTask={task} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.listQueuedPrompts).toHaveBeenCalledTimes(reads + 1));
  });

  it("a hidden pane stops reading the queue and reads again when shown", async () => {
    const view = await open();
    const reads = api.listQueuedPrompts.mock.calls.length;
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" fallbackTask={task} active={false} />
      </MemoryRouter>,
    );
    // The pane is hidden, not closed: polling it would spend a request on a
    // screen nobody is looking at.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(api.listQueuedPrompts).toHaveBeenCalledTimes(reads);

    // Showing it again reads before the next interval: the queue may have
    // drained while the pane was hidden, and the badges must catch up now.
    view.rerender(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <TaskDetailPage taskId="task-1" fallbackTask={task} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.listQueuedPrompts).toHaveBeenCalledTimes(reads + 1));
  });

  it("a move sends the full permutation and renders the daemon's answer", async () => {
    // The answer is a different full permutation from the one sent. A real
    // daemon answers what it accepted, but another device can move a row
    // between this console's read and its write — and the rule under test is
    // that the answer is what the badge numbers, never a local splice.
    api.reorderQueuedPrompts.mockResolvedValue([three, two, one]);
    await open();

    fireEvent.click(moveDown("second thought"));

    await waitFor(() => expect(api.reorderQueuedPrompts).toHaveBeenCalledTimes(1));
    // Every currently queued id, once, in the wanted order — not a subset.
    expect(api.reorderQueuedPrompts).toHaveBeenCalledWith("task-1", [101, 103, 102]);

    await waitFor(() => expect(placeOf("third thought")).toBe("1"));
    expect(placeOf("second thought")).toBe("2");
    expect(placeOf("first thought")).toBe("3");
  });

  it("a 409 re-reads the queue and says the order changed", async () => {
    api.reorderQueuedPrompts.mockRejectedValue(new ApiError(409, "queue changed"));
    // The re-read answers with an order the tap never asked for: if the page
    // kept a local arrangement, these numbers would not follow it.
    api.listQueuedPrompts
      .mockResolvedValueOnce([one, two, three])
      .mockResolvedValue([three, one, two]);
    await open();

    fireEvent.click(moveDown("second thought"));

    await waitFor(() => expect(api.listQueuedPrompts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(placeOf("third thought")).toBe("1"));
    expect(placeOf("first thought")).toBe("2");
    expect(placeOf("second thought")).toBe("3");

    const said = useAppStore
      .getState()
      .toasts.filter((entry) => entry.message === t("chat.queueOrderChanged"));
    expect(said).toHaveLength(1);
  });

  it("a late reorder answer does not overwrite a newer queue", async () => {
    const first = deferred<QueuedPrompt[]>();
    const second = deferred<QueuedPrompt[]>();
    api.reorderQueuedPrompts.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await open();

    // Two moves from the same base, both in flight. The second is a different
    // permutation, so it is a real request rather than a double tap.
    fireEvent.click(moveDown("second thought"));
    fireEvent.click(moveDown("first thought"));
    await waitFor(() => expect(api.reorderQueuedPrompts).toHaveBeenCalledTimes(2));
    expect(api.reorderQueuedPrompts).toHaveBeenNthCalledWith(2, "task-1", [102, 101, 103]);

    // The newer answer lands first and owns the queue.
    await act(async () => second.resolve([two, one, three]));
    await waitFor(() => expect(placeOf("second thought")).toBe("1"));
    expect(placeOf("first thought")).toBe("2");

    // The older answer arrives afterwards and is dropped.
    await act(async () => first.resolve([one, three, two]));
    await act(async () => undefined);
    expect(placeOf("first thought")).toBe("2");
    expect(placeOf("second thought")).toBe("1");
    expect(placeOf("third thought")).toBe("3");
  });
});

// The strip's band is published as custom properties from `FloatingApproval`
// and spent by `.phone-approval-clearance` in the phone media query. The
// transcript scroller names it so the last queued row can be scrolled above
// the strip instead of resting under it; with nothing pending the `0px`
// fallbacks leave today's footer clearance alone.
const INDEX_CSS = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
const TASK_PAGE_SOURCE = readFileSync(join(process.cwd(), "src/pages/TaskDetailPage.tsx"), "utf8");

describe("the transcript clears the approval strip", () => {
  it("R-queue-reorder-yield: the task transcript reserves the approval band on phones", async () => {
    await open();

    const scroller = screen.getByRole("region", { name: t("task.transcript") });
    expect(scroller.className.split(/\s+/).filter(Boolean)).toContain("phone-approval-clearance");

    // Both branches of the scroller's ternary: the invisible pre-positioning
    // element is the same scroller a frame later, and losing the band on the
    // flip would make the page jump.
    expect(TASK_PAGE_SOURCE).toMatch(
      /kin-scroll py-5 min-h-0 phone-approval-clearance outline-none/,
    );
    expect(TASK_PAGE_SOURCE).toMatch(
      /kin-scroll py-5 min-h-0 phone-approval-clearance invisible outline-none/,
    );

    // The class is only worth its name while the shipped rule spends the band
    // the strip publishes.
    const rule = INDEX_CSS.match(
      /@media \(max-width: 767\.98px\)\s*\{\s*\.phone-approval-clearance\s*\{([^}]*)\}/,
    );
    expect(rule, "the phone rule exists").not.toBeNull();
    const body = rule![1];
    expect(body).toMatch(/padding-bottom:\s*max\(\s*var\(--phone-footer-clearance\)/);
    expect(body).toMatch(/var\(--approval-strip-height,\s*0px\)/);
    expect(body).toMatch(/var\(--approval-strip-bottom,\s*0px\)/);
    expect(body).toMatch(/\+\s*8px/);
  });
});
