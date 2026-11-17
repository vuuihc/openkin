// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import { getTaskOrder } from "../../lib/taskOrder";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * Manual order inside a project, from the keyboard.
 *
 * Alt+↑/↓ moves the focused row and keeps focus on it; the order is written on
 * the spot. It is not offered while a search or a status filter is narrowing
 * the list, or in the archived scope: an order written there would be an
 * order for "the current results", not for the project.
 *
 * The hold-to-drag path lands separately and restores its own suite here.
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

/**
 * The rows in the order the reader sees them.
 */
function order(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-session-row]")).map(
    (el) => el.dataset.sessionRow ?? "",
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
    // Six rows, five drawn: row "f" sits behind "Show all". Moving "e" past it
    // would hide "e" from the drawn slice and drop keyboard focus to <body>,
    // so the move clamps at the last row actually on screen.
    fixtures.tasks = [
      task("a", 60),
      task("b", 50),
      task("c", 40),
      task("d", 30),
      task("e", 20),
      task("f", 10),
    ];
    mount();
    await waitFor(() => expect(order()).toEqual(["a", "b", "c", "d", "e"]));
    row("e").focus();

    fireEvent.keyDown(row("e"), { key: "ArrowDown", altKey: true });

    expect(order()).toEqual(["a", "b", "c", "d", "e"]);
    expect(getTaskOrder()).toEqual({});
    expect((document.activeElement as HTMLElement | null)?.dataset.sessionRow).toBe("e");
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
