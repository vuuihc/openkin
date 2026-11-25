// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import { getTaskOrder, setBucketOrder } from "../../lib/taskOrder";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * Manual order inside a project, from the keyboard.
 *
 * Alt+↑/↓ moves the focused row and keeps focus on it; the order is written on
 * the spot. It is not offered while a search or a status filter is narrowing
 * the list, or in the archived scope: an order written there would be an
 * order for "the current results", not for the project.
 *
 * A completed hold is the touch equivalent: it lifts the row, the other rows
 * make way, and release writes the order. jsdom has no layout, so
 * `getBoundingClientRect` is modeled as a 40px row stack in DOM order — the
 * drag reads the same midpoints a browser would.
 *
 * KIN-MANAGE-001, gap-log 2026-11-15: the list order used to follow only
 * attention and recency.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  sessions: [] as AgentSession[],
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
      items: fixtures.sessions,
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

function task(id: string, createdAt: number, archived = false, cwd = "/work/alpha"): Task {
  return {
    id,
    title: id,
    cwd,
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

/** The Mac sidebar: fine pointer, so each project heading draws its hover strip. */
function mountSidebar() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <SessionList shell="sidebar" />
    </MemoryRouter>,
  );
}

function row(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-session-row="${id}"]`);
  if (!el) throw new Error(`row ${id} is not on screen`);
  return el;
}

/**
 * The rows in the order the reader sees them.
 */
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
  // A sheet owns one history entry; start each test from a clean one.
  window.history.replaceState({ idx: 0 }, "", "/sessions");
  fixtures.tasks = [task("a", 30), task("b", 20), task("c", 10)];
  fixtures.sessions = [];
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
    // The lifted row is translated inside its slot; a browser's rect includes
    // that transform, and the drag subtracts it back out to find the slot.
    const lift = index >= 0 ? this.closest<HTMLElement>("[data-dragging]") : null;
    const shift = Number(
      /translateY\((-?[\d.]+)px\)/.exec(lift?.getAttribute("style") ?? "")?.[1] ?? 0,
    );
    const top = index >= 0 ? index * ROW_HEIGHT + shift : 0;
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

  it("does not move the last drawn row of a truncated project out of the slice", async () => {
    // Eleven rows, ten drawn: row "k" sits behind "Show all". Moving "j" past
    // it would hide "j" from the drawn slice and drop keyboard focus to <body>,
    // so the move clamps at the last row actually on screen.
    fixtures.tasks = [
      task("a", 110),
      task("b", 100),
      task("c", 90),
      task("d", 80),
      task("e", 70),
      task("f", 60),
      task("g", 50),
      task("h", 40),
      task("i", 30),
      task("j", 20),
      task("k", 10),
    ];
    mount();
    await waitFor(() =>
      expect(order()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]),
    );
    row("j").focus();

    fireEvent.keyDown(row("j"), { key: "ArrowDown", altKey: true });

    expect(order()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    expect(getTaskOrder()).toEqual({});
    expect((document.activeElement as HTMLElement | null)?.dataset.sessionRow).toBe("j");
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

/**
 * The way back out of a manual order, and the only sign that the keyboard
 * gesture exists. Both live where the move is offered: the project sheet only
 * carries the reset once that project has a stored order, and a row only shows
 * the hint while Alt+↑/↓ would actually do something.
 *
 * KIN-MANAGE-001, gap-log 2026-11-15 (第二切片 R-drag-order-ux).
 */
describe("order escape hatch", () => {
  it("restore-time-order-appears-only-after-a-manual-move", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));

    await user.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.queryByRole("button", { name: "Restore time order" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());

    row("a").focus();
    fireEvent.keyDown(row("a"), { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(order()).toEqual(["b", "a", "c"]));

    await user.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.getByRole("button", { name: "Restore time order" })).toBeTruthy();
  });

  it("restore-time-order-clears-the-bucket-and-returns-the-clock-order", async () => {
    const user = userEvent.setup();
    // A second project's order must survive: the sheet speaks for one bucket.
    setBucketOrder("/work/beta", ["x"]);
    mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    row("a").focus();
    fireEvent.keyDown(row("a"), { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(order()).toEqual(["b", "a", "c"]));
    expect(getTaskOrder()).toEqual({
      "/work/alpha": ["b", "a", "c"],
      "/work/beta": ["x"],
    });

    await user.click(screen.getByRole("button", { name: "Project actions" }));
    await user.click(screen.getByRole("button", { name: "Restore time order" }));

    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    expect(getTaskOrder()).toEqual({ "/work/beta": ["x"] });
  });

  it("fine-pointer-project-strip-restores-time-order", async () => {
    const user = userEvent.setup();
    // The Mac sidebar is a fine pointer, so its project actions live in the
    // hover strip rather than the sheet. The way back out of a manual order
    // has to exist there too.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    mountSidebar();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    expect(screen.queryByRole("button", { name: "Restore time order" })).toBeNull();

    row("a").focus();
    fireEvent.keyDown(row("a"), { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(order()).toEqual(["b", "a", "c"]));

    await user.click(screen.getByRole("button", { name: "Restore time order" }));

    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    expect(getTaskOrder()).toEqual({});
  });

  it("restore-time-order-is-offered-for-a-remote-only-project", async () => {
    const user = userEvent.setup();
    // The order is a per-browser preference, so it applies to a remote copy
    // too. The reset must not hide behind the local project record.
    fixtures.tasks = [
      { ...task("a", 30), executing_device_id: "nas-1" },
      { ...task("b", 20), executing_device_id: "nas-1" },
    ];
    setBucketOrder("/work/alpha", ["b", "a"]);
    mount();
    await waitFor(() => expect(order()).toEqual(["b", "a"]));

    await user.click(screen.getByRole("button", { name: "Project actions" }));
    await user.click(screen.getByRole("button", { name: "Restore time order" }));

    await waitFor(() => expect(order()).toEqual(["a", "b"]));
    expect(getTaskOrder()).toEqual({});
  });

  it("a-row-carries-the-reorder-hint-while-a-move-is-offered", async () => {
    const view = mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    expect(row("a").getAttribute("title")).toBe("Alt+↑/↓ moves this chat");
    // The hint is a tooltip, never part of what a screen reader announces.
    expect(row("a").getAttribute("aria-label")).not.toContain("Alt");
    view.unmount();

    // A narrowed list still shows the stored order, but a move is not offered
    // there, so the row must not advertise the gesture.
    const searched = mount("/sessions?search=alpha");
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    expect(row("a").hasAttribute("title")).toBe(false);
    expect(row("a").getAttribute("aria-label")).not.toContain("Alt");
    searched.unmount();

    fixtures.tasks = [task("a", 30, true), task("b", 20, true), task("c", 10, true)];
    mount("/sessions?scope=archived");
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    expect(row("a").hasAttribute("title")).toBe(false);
    expect(row("a").getAttribute("aria-label")).not.toContain("Alt");
  });

  it("an-imported-row-does-not-advertise-a-move-that-is-discarded", async () => {
    const user = userEvent.setup();
    // Imported sessions are an index, not a project: their bucket ignores
    // stored orders, so a move here would be discarded. The hint must follow
    // the move, not the global "reorder is on" flag.
    fixtures.tasks = [];
    fixtures.sessions = [
      {
        id: "s1",
        agent_id: "claude-code",
        external_ref: "s1",
        title: "Imported chat",
        cwd: "/work/alpha",
        status: "idle",
        first_seen_at: 0,
        last_seen_at: 0,
        updated_at: 1,
        linked: false,
      } as AgentSession,
    ];
    mount();
    const heading = await screen.findByRole("button", { name: /^Imported sessions/ });
    if (heading.getAttribute("aria-expanded") === "false") await user.click(heading);
    await waitFor(() => expect(row("s1")).toBeTruthy());
    expect(row("s1").hasAttribute("title")).toBe(false);
    expect(row("s1").getAttribute("aria-label")).not.toContain("Alt");
  });
});

/**
 * The touch door into the same order: hold a row, drag it, release.
 *
 * The hold used to open the row's action sheet (#190). Where the list offers
 * a reorder the drag wins that gesture; the sheet stays on the trailing
 * trigger. The order is written once, on release, and a cancelled gesture
 * writes nothing.
 */
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
    // The dragged row follows the finger; the others only make way. `ids`
    // already draws a in slot 1 (top 40), so the transform is only the rest of
    // the finger's 50px travel: a's top stays at 50 instead of being carried
    // by the new slot and the transform at once.
    expect(document.querySelector<HTMLElement>("[data-dragging]")?.style.transform).toBe(
      "translateY(10px)",
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

  it("a row cannot be dropped into another project bucket", async () => {
    fixtures.tasks = [
      task("a", 30),
      task("b", 20),
      task("c", 10),
      task("x", 9, false, "/work/beta"),
      task("y", 8, false, "/work/beta"),
    ];
    // Keep Alpha open across the manual expand of Beta: a remembered fold is
    // an opinion about the whole list, so opening Beta would otherwise fold
    // the project that carries none (KIN-CONTINUE-007, step 3).
    localStorage.setItem(
      "kin_session_folds",
      JSON.stringify({ "mac-1::/work/alpha": true, "mac-1::/work/beta": false }),
    );
    mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    fireEvent.click(screen.getByRole("button", { name: "Expand project beta" }));
    await waitFor(() => expect(order()).toHaveLength(5));
    vi.useFakeTimers();

    // Hold the last alpha row and drag far past both beta rows: the hit test
    // only knows this bucket's ids, so the row stays inside its project.
    pointer(row("c"), "pointerdown", 200, 20);
    act(() => vi.advanceTimersByTime(600));
    pointer(row("c"), "pointermove", 200, 30);
    pointer(row("c"), "pointermove", 200, 260);
    pointer(row("c"), "pointerup", 200, 260);

    const alpha = order().filter((id) => ["a", "b", "c"].includes(id));
    const beta = order().filter((id) => ["x", "y"].includes(id));
    expect(alpha).toEqual(["a", "b", "c"]);
    expect(beta).toEqual(["x", "y"]);
    expect(getTaskOrder()).toEqual({ "/work/alpha": ["a", "b", "c"] });
  });

  it("an imported read-only row does not start a drag", async () => {
    const user = userEvent.setup();
    fixtures.tasks = [];
    fixtures.sessions = [
      {
        id: "s1",
        agent_id: "claude-code",
        external_ref: "s1",
        title: "Imported chat",
        cwd: "/work/alpha",
        status: "idle",
        first_seen_at: 0,
        last_seen_at: 0,
        updated_at: 1,
        linked: false,
      } as AgentSession,
      {
        id: "s2",
        agent_id: "claude-code",
        external_ref: "s2",
        title: "Another imported chat",
        cwd: "/work/alpha",
        status: "idle",
        first_seen_at: 0,
        last_seen_at: 0,
        updated_at: 1,
        linked: false,
      } as AgentSession,
    ];
    mount();
    const heading = await screen.findByRole("button", { name: /^Imported sessions/ });
    if (heading.getAttribute("aria-expanded") === "false") await user.click(heading);
    await waitFor(() => expect(row("s1")).toBeTruthy());

    vi.useFakeTimers();
    pointer(row("s1"), "pointerdown", 200, 20);
    act(() => vi.advanceTimersByTime(600));
    pointer(row("s1"), "pointermove", 200, 80);

    // No lift, and nothing written: an imported session's order is not ours.
    expect(document.querySelector("[data-dragging]")).toBeNull();
    expect(getTaskOrder()).toEqual({});
  });

  it("the list does not scroll while a row is dragged", async () => {
    mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
    vi.useFakeTimers();

    pointer(row("a"), "pointerdown", 200, 20);
    act(() => vi.advanceTimersByTime(600));
    pointer(row("a"), "pointermove", 200, 60);

    // Touch events keep targeting the element the touch started on, so a
    // non-passive touchmove on the lifted row is what stops the page from
    // scrolling under the drag (`touch-action: pan-y` was fixed at start).
    const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
    row("a").dispatchEvent(touchMove);
    expect(touchMove.defaultPrevented).toBe(true);
  });
});
