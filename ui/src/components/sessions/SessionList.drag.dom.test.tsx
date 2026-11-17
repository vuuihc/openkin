// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import { getTaskOrder, setBucketOrder } from "../../lib/taskOrder";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * Manual order inside a project, from both doors.
 *
 * A completed hold lifts a row and the other rows make way; release writes the
 * order. Alt+↑/↓ is the same operation from the keyboard, with focus staying on
 * the row that moved. Neither is offered while a search or a status filter is
 * narrowing the list, or in the archived scope: an order written there would be
 * an order for "the current results", not for the project.
 *
 * jsdom has no layout, so `getBoundingClientRect` is modeled as a 40px row
 * stack in DOM order — the drag reads the same midpoints a browser would.
 *
 * KIN-MANAGE-001, gap-log 2026-11-15: the list order used to follow only
 * attention and recency.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
}));

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: fixtures.tasks,
    loaded: true,
    error: null,
    pageFull: false,
    loading: false,
  }),
  usePendingResources: () => ({
    data: { approvals: [], questions: [] },
    loaded: true,
    error: null,
  }),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    listAgentSessionsPage: vi.fn(async () => ({
      items: [] as AgentSession[],
      next_cursor: undefined,
    })),
    listTasks: vi.fn(async () => []),
    listProjects: vi.fn(async () => [] as Project[]),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
}));

const ROW_HEIGHT = 40;

function task(id: string, createdAt: number, archived = false): Task {
  return {
    id,
    title: id,
    cwd: "/work/alpha",
    agent: "kin",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: createdAt,
    ...(archived ? { archived_at: 5 } : {}),
  } as Task;
}

function mount(entry = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SessionList shell="page" />
    </MemoryRouter>,
  );
}

function row(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-session-row="${id}"]`);
  if (!el) throw new Error(`row ${id} is not on screen`);
  return el;
}

/** The rows in the order the reader sees them. */
function order(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-session-row]")).map(
    (el) => el.dataset.sessionRow ?? "",
  );
}

/**
 * A pointer event carrying the coordinates the drag reads. jsdom has no
 * PointerEvent constructor; React listens for the native type either way, and
 * `pointerType` stays undefined so the left-button guard passes.
 */
function pointer(node: Element, type: string, clientX: number, clientY: number) {
  fireEvent(
    node,
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
    }),
  );
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [task("a", 30), task("b", 20), task("c", 10)];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  // A browser would lay the rows out in DOM order; the drag asks for those
  // midpoints, so the model has to move when the rows do.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-session-row]"));
    const index = this.hasAttribute("data-session-row") ? rows.indexOf(this) : -1;
    const top = index >= 0 ? index * ROW_HEIGHT : 0;
    return {
      top,
      bottom: top + ROW_HEIGHT,
      height: ROW_HEIGHT,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe("keyboard reorder", () => {
  it("Alt+ArrowDown moves the focused chat one place down in its project and persists", async () => {
    mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    row("a").focus();

    fireEvent.keyDown(row("a"), { key: "ArrowDown", altKey: true });

    await waitFor(() => expect(order()).toEqual(["b", "a", "c"]));
    expect(getTaskOrder()).toEqual({ "/work/alpha": ["b", "a", "c"] });
  });

  it("Alt+ArrowUp moves it up", async () => {
    mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    row("c").focus();

    fireEvent.keyDown(row("c"), { key: "ArrowUp", altKey: true });

    await waitFor(() => expect(order()).toEqual(["a", "c", "b"]));
    expect(getTaskOrder()).toEqual({ "/work/alpha": ["a", "c", "b"] });
  });

  it("the moved row keeps focus", async () => {
    mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    row("a").focus();

    fireEvent.keyDown(row("a"), { key: "ArrowDown", altKey: true });

    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.sessionRow).toBe("a"),
    );
    expect(order()).toEqual(["b", "a", "c"]);
  });

  it("Alt+Arrow does nothing while a search query is active or in the archived scope", async () => {
    // Search: the stored order still displays, but a reorder here would be an
    // order for "the current results", so the keys stay plain navigation.
    const view = mount("/sessions?search=alpha");
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    row("a").focus();
    fireEvent.keyDown(row("a"), { key: "ArrowDown", altKey: true });
    expect(order()).toEqual(["a", "b", "c"]);
    expect(getTaskOrder()).toEqual({});
    view.unmount();

    fixtures.tasks = [task("a", 30, true), task("b", 20, true), task("c", 10, true)];
    mount("/sessions?scope=archived");
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    row("a").focus();
    fireEvent.keyDown(row("a"), { key: "ArrowDown", altKey: true });
    expect(order()).toEqual(["a", "b", "c"]);
    expect(getTaskOrder()).toEqual({});
  });
});

describe("pointer reorder", () => {
  it("a long press starts a drag instead of opening the action sheet", async () => {
    mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    vi.useFakeTimers();

    pointer(row("a"), "pointerdown", 200, 20);
    act(() => vi.advanceTimersByTime(600));

    // The hold has a job again: it lifts the row. The sheet is still one tap
    // away on the row's trailing trigger, but the gesture no longer opens it.
    expect(document.querySelector("[data-dragging]")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a drag released over the next row persists the new order", async () => {
    mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    vi.useFakeTimers();

    pointer(row("a"), "pointerdown", 200, 20);
    act(() => vi.advanceTimersByTime(600));
    // First move establishes the finger's origin; the second crosses b's
    // midpoint (60) and puts a after it while the finger is still down.
    pointer(row("a"), "pointermove", 200, 30);
    pointer(row("a"), "pointermove", 200, 80);
    expect(order()).toEqual(["b", "a", "c"]);
    // The dragged row follows the finger; the others only make way.
    expect(document.querySelector<HTMLElement>("[data-dragging]")?.style.transform).toBe(
      "translateY(50px)",
    );

    pointer(row("a"), "pointerup", 200, 80);

    expect(order()).toEqual(["b", "a", "c"]);
    expect(getTaskOrder()).toEqual({ "/work/alpha": ["b", "a", "c"] });
  });

  it("a cancelled drag leaves the stored order untouched", async () => {
    setBucketOrder("/work/alpha", ["c", "b", "a"]);
    mount();
    await waitFor(() => expect(order()).toEqual(["c", "b", "a"]));
    vi.useFakeTimers();

    pointer(row("c"), "pointerdown", 200, 20);
    act(() => vi.advanceTimersByTime(600));
    pointer(row("c"), "pointermove", 200, 30);
    pointer(row("c"), "pointermove", 200, 80);
    expect(order()).toEqual(["b", "c", "a"]);

    pointer(row("c"), "pointercancel", 200, 80);

    expect(order()).toEqual(["c", "b", "a"]);
    expect(getTaskOrder()).toEqual({ "/work/alpha": ["c", "b", "a"] });
  });
});
