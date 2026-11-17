// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type { Machine } from "../../lib/devices";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * One project, one name.
 *
 * `/api/projects` is the source of a project's name, and the heading has to use
 * it whether or not the project has a conversation in the loaded page. The list
 * used to title a bucket with its folder's last segment as soon as it had rows,
 * so `[seed] Project Alpha` read `alpha` with a conversation and
 * `Project Alpha` without one, and archiving the last conversation flipped it
 * back. Both shells draw the same buckets, so both are checked here.
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

function viewport() {
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
}

function task(id: string, cwd: string, archivedAt?: number): Task {
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
    ...(archivedAt ? { archived_at: archivedAt } : {}),
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

/**
 * The heading is a button whose accessible name is the label, so an exact-name
 * query distinguishes it from the controls that embed the label ("New session
 * in Project Alpha", "Collapse project Project Alpha").
 */
function heading(name: string): HTMLElement | null {
  const region = screen.getByRole("region", { name: /This machine/ });
  return within(region).queryByRole("button", { name });
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [task("alpha-work", "/work/alpha")];
  fixtures.projects = [
    project("p-alpha", "Project Alpha", "/work/alpha"),
    // A project with no conversation in the loaded page: its heading is drawn
    // from the record, which is the case that already showed the right name.
    project("p-gamma", "Project Gamma", "/work/gamma"),
  ];
  fixtures.machines = [
    { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
  ];
  viewport();
});

describe("a project's heading in the conversation list", () => {
  it("titles a project with its record name in both list states", async () => {
    for (const shell of ["page", "sidebar"] as const) {
      const view = list(shell);
      // The heading appears only after the project records have loaded: before
      // that the empty project is not drawn at all.
      await screen.findByRole("button", { name: "Project Gamma" });

      expect(heading("Project Alpha")).toBeTruthy();
      expect(heading("Project Gamma")).toBeTruthy();
      // The folder is not a second name for the project as a heading.
      expect(heading("alpha")).toBeNull();
      expect(heading("gamma")).toBeNull();

      view.unmount();
    }
  });

  it("keeps the heading after the last conversation is archived", async () => {
    fixtures.tasks = [task("alpha-work", "/work/alpha", 99)];
    list("page");

    // The row is gone from the active list, but the project is still a project:
    // its heading comes from the record and keeps the record's name rather than
    // flipping back to the folder.
    await screen.findByRole("button", { name: "Project Alpha" });
    expect(screen.queryByRole("button", { name: "alpha-work" })).toBeNull();
    expect(heading("Project Gamma")).toBeTruthy();
    expect(heading("alpha")).toBeNull();
  });
});
