// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type { Machine } from "../../lib/devices";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * The conversation list's density is one decision, read off a pointer.
 *
 * The Mac sidebar is a fine-pointer surface and packs its rows at the scale's
 * 36px step; a finger keeps the 44px target it had. The project heading's gap
 * above shrinks with them, and the conversation block still steps in from the
 * project block — the level #26 and #47 exist to keep legible — just by the
 * smaller step. These tests pin the class the decision emits, not a pixel:
 * jsdom has no layout.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  projects: [] as Project[],
  machines: [] as Machine[],
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
    listProjects: vi.fn(async () => fixtures.projects),
    listTasks: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p", name: "alpha" })),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({ machines: fixtures.machines, loading: false, failed: false }),
}));

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

function task(id: string, cwd = "/work/alpha"): Task {
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
    created_at: 1,
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

function list(shell: "page" | "sidebar") {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <SessionList shell={shell} />
    </MemoryRouter>,
  );
}

function row(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-session-row="${id}"]`);
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [task("alpha-work"), task("alpha-second")];
  fixtures.projects = [project("p-alpha", "Project Alpha", "/work/alpha")];
  fixtures.machines = [
    { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
  ];
});

describe("conversation-list density", () => {
  it("dense rows only on a fine pointer", () => {
    pointer("fine");
    const dense = list("sidebar");
    expect(row("alpha-work").className).toContain("min-h-9");
    expect(row("alpha-work").className).not.toContain("min-h-11");
    dense.unmount();

    pointer("coarse");
    list("sidebar");
    expect(row("alpha-work").className).toContain("min-h-11");
    expect(row("alpha-work").className).not.toContain("min-h-9");
  });

  it("a project heading keeps a header gap smaller than the old pt-4 in the sidebar", async () => {
    pointer("fine");
    list("sidebar");

    // The heading row is the block around the project's own navigation row:
    // chevron, folder, name, count.
    const heading = await screen.findByRole("button", { name: "Project Alpha" });
    const headingRow = heading.parentElement as HTMLElement;
    expect(headingRow.className).toContain("pt-2");
    expect(headingRow.className).not.toContain("pt-4");
  });

  it("the three sidebar levels still step inward", async () => {
    pointer("fine");
    list("sidebar");
    await screen.findByRole("button", { name: "Project Alpha" });

    const projectStep = document.querySelector<HTMLElement>('[data-sidebar-indent="project"]');
    const sessionStep = document.querySelector<HTMLElement>('[data-sidebar-indent="session"]');
    expect(projectStep).not.toBeNull();
    expect(sessionStep).not.toBeNull();
    // The outer step is untouched; the conversation block keeps its own step,
    // now the scale's 12px one instead of 16px.
    expect(projectStep?.className).toContain("pl-4");
    expect(sessionStep?.className).toContain("pl-3");
    expect(sessionStep?.className).not.toContain("pl-4");
    // The levels are nested, so the smaller step is still a step inward and
    // not a second level drawn beside its parent.
    expect(projectStep?.contains(sessionStep as Node)).toBe(true);
  });
});
