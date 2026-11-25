// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * KIN-CONTINUE-007: one screenful of conversations at 820.
 *
 * Projects are folded except the one the person was last in, the row cap lets
 * ten conversations render, and a project's 「工作方式」 is one disclosure line.
 * These tests pin that shape in jsdom.
 *
 * The "ten in one 820 screenful" contract is a *measurement*, and jsdom has no
 * layout: the screenful itself is proven only by the 820×1180 coarse-pointer
 * browser measurement in the delivery (shots under rsi/state/shots/
 * list-scan-a/). What is asserted here is the part a unit test can hold — ten
 * conversations render with the row cap out of the way, and only the newest
 * project is open. It does not fake a height.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  projects: [] as Project[],
  pending: [] as { task_id: string }[],
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
    data: { approvals: fixtures.pending, questions: [] },
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
    listProjects: vi.fn(async () => fixtures.projects),
    getOnePager: vi.fn(async () => ({
      markdown: "## How to work here\n\nAlways run the tests before landing.",
    })),
    ensureProject: vi.fn(async () => ({ id: "p", name: "alpha" })),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
      { id: "nas-1", label: "Studio", isSelf: false, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
}));

/** 820×1180 is a portrait iPad: the desktop shell under a thumb. */
function pointer(kind: "fine" | "coarse") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? kind === "coarse" : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

let clock = 0;

function task(id: string, cwd = "/work/alpha", overrides: Partial<Task> = {}): Task {
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
    created_at: clock || Date.now() - 30_000,
    ...overrides,
  } as Task;
}

function project(id: string, name: string, root: string): Project {
  return {
    id,
    name,
    mode: "default",
    status: "active",
    created_at: 1,
    updated_at: 1,
    last_active_at: 1,
    roots: [root],
  } as Project;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <SessionList shell="sidebar" />
    </MemoryRouter>,
  );
}

function rowEl(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-session-row="${id}"]`);
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

/** The project heading's fold chevron: the icon button that says expanded. */
function projectChevron(name: string): HTMLElement {
  const button = screen
    .getAllByRole("button", { name: new RegExp(name) })
    .find((element) => element.hasAttribute("aria-expanded"));
  expect(button).toBeTruthy();
  return button as HTMLElement;
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  clock = 0;
  fixtures.tasks = [task("alpha-work")];
  fixtures.projects = [project("p-alpha", "Project Alpha", "/work/alpha")];
  fixtures.pending = [];
  pointer("coarse");
});

describe("the 820 conversation list", () => {
  it("fits ten conversations in one 820 screenful", () => {
    // Ten rows, one open project: the jsdom half of the contract (the real
    // screenful is the 820×1180 browser measurement). If the project row cap
    // came back below ten, only five would render and this would go red.
    fixtures.tasks = Array.from({ length: 10 }, (_, index) => task(`ten-${index + 1}`));
    mount();

    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-session-row]"));
    expect(rows).toHaveLength(10);
  });

  it("opens only the most recent project by default", () => {
    fixtures.projects = [];
    fixtures.tasks = [
      task("alpha-work", "/work/alpha", { created_at: Date.now() - 60_000 }),
      task("beta-work", "/work/beta", { created_at: Date.now() }),
    ];
    mount();

    // The newest conversation's project is open; the other is a heading.
    expect(rowEl("beta-work")).toBeTruthy();
    expect(document.querySelector('[data-session-row="alpha-work"]')).toBeNull();
    expect(projectChevron("alpha").getAttribute("aria-expanded")).toBe("false");
    expect(projectChevron("beta").getAttribute("aria-expanded")).toBe("true");
  });

  it("folds the project's working style to one disclosure line", async () => {
    const user = userEvent.setup();
    mount();

    // One line by default: the disclosure, no body text. It is a 44px target
    // because an 820 iPad is a thumb.
    const disclosure = await screen.findByRole("button", { name: "How to work here" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.className).toContain("min-h-11");
    expect(screen.queryByText("Always run the tests before landing.")).toBeNull();

    // Enter opens it.
    disclosure.focus();
    await user.keyboard("{Enter}");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("Always run the tests before landing.")).toBeTruthy();

    // Space closes it too.
    await user.keyboard(" ");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");

    // Remembered per project: open it, fold the project away and back, and the
    // disclosure is still open.
    await user.keyboard("{Enter}");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const heading = projectChevron("Project Alpha");
    await user.click(heading);
    expect(screen.queryByRole("button", { name: "How to work here" })).toBeNull();
    await user.click(heading);
    const reopened = await screen.findByRole("button", { name: "How to work here" });
    expect(reopened.getAttribute("aria-expanded")).toBe("true");
  });
});
