// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function project(id: string, name: string, root: string | string[]): Project {
  return {
    id,
    name,
    mode: "default",
    status: "active",
    created_at: 1,
    updated_at: 1,
    last_active_at: 1,
    roots: Array.isArray(root) ? root : [root],
  } as Project;
}

function list(shell: "page" | "sidebar", path = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[path]}>
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

  /**
   * One project record, two roots.
   *
   * `/api/projects` says `/work/alpha` and `/work/aaa-config` are one project;
   * the person reads that as one heading. Drawing one heading per root left a
   * permanently empty duplicate, and opening it found nothing. Both shells draw
   * the same list, so both are checked.
   */
  it("draws one heading for a project with two roots", async () => {
    fixtures.projects = [
      project("p-alpha", "Project Alpha", ["/work/alpha", "/work/aaa-config"]),
    ];
    fixtures.tasks = [task("alpha-work", "/work/alpha")];

    for (const shell of ["page", "sidebar"] as const) {
      const view = list(shell);
      await screen.findByRole("button", { name: "Project Alpha" });

      const region = screen.getByRole("region", { name: /This machine/ });
      expect(within(region).queryAllByRole("button", { name: "Project Alpha" })).toHaveLength(1);
      // The second root is part of the same project, not a heading of its own.
      expect(within(region).queryByRole("button", { name: "aaa-config" })).toBeNull();

      view.unmount();
    }
  });

  it("files conversations from both roots under that heading", async () => {
    fixtures.projects = [
      project("p-alpha", "Project Alpha", ["/work/alpha", "/work/aaa-config"]),
    ];
    fixtures.tasks = [task("alpha-work", "/work/alpha"), task("config-work", "/work/aaa-config")];

    list("page");
    const headingButton = await screen.findByRole("button", { name: "Project Alpha" });
    const region = screen.getByRole("region", { name: /This machine/ });
    expect(within(region).queryAllByRole("button", { name: "Project Alpha" })).toHaveLength(1);

    // Both conversations live inside that one heading's section. The row's
    // accessible name is a sentence (title · agent · time), hence the pattern.
    const bucketSection = headingButton.closest("section")!;
    expect(within(bucketSection).getByRole("button", { name: /alpha-work/ })).toBeTruthy();
    expect(within(bucketSection).getByRole("button", { name: /config-work/ })).toBeTruthy();
  });

  it("archives every root of a merged heading and restores one heading", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fixtures.projects = [
      project("p-alpha", "Project Alpha", ["/work/alpha", "/work/aaa-config"]),
    ];
    fixtures.tasks = [task("alpha-work", "/work/alpha"), task("config-work", "/work/aaa-config")];

    const active = list("page");
    await screen.findByRole("button", { name: "Project Alpha" });
    const region = screen.getByRole("region", { name: /This machine/ });
    await userEvent.click(within(region).getByRole("button", { name: "Remove from sidebar" }));

    // Archive is one project decision: both roots go, so no root's rows keep
    // the heading alive and the heading can actually be put away.
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("kin_archived_projects") ?? "[]")).toEqual([
        "/work/alpha",
        "/work/aaa-config",
      ]),
    );
    expect(confirm).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Project Alpha" })).toBeNull();
    active.unmount();

    // The archived scope draws the same one heading, with both roots' rows and
    // one Restore.
    const archived = list("page", "/sessions?scope=archived");
    const archivedHeading = await screen.findByRole("button", { name: "Project Alpha" });
    const archivedRegion = screen.getByRole("region", { name: /This machine/ });
    expect(within(archivedRegion).queryAllByRole("button", { name: "Project Alpha" })).toHaveLength(
      1,
    );
    const archivedSection = archivedHeading.closest("section")!;
    expect(within(archivedSection).getByRole("button", { name: /alpha-work/ })).toBeTruthy();
    expect(within(archivedSection).getByRole("button", { name: /config-work/ })).toBeTruthy();

    await userEvent.click(
      within(archivedRegion).getByRole("button", { name: "Restore Project Alpha" }),
    );
    // Restore is the same one decision in reverse: every root comes back, or
    // the heading returns half hidden.
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("kin_archived_projects") ?? "[]")).toEqual([]),
    );
    archived.unmount();

    const restored = list("page");
    const restoredHeading = await screen.findByRole("button", { name: "Project Alpha" });
    const restoredRegion = screen.getByRole("region", { name: /This machine/ });
    expect(
      within(restoredRegion).queryAllByRole("button", { name: "Project Alpha" }),
    ).toHaveLength(1);
    const restoredSection = restoredHeading.closest("section")!;
    expect(within(restoredSection).getByRole("button", { name: /alpha-work/ })).toBeTruthy();
    expect(within(restoredSection).getByRole("button", { name: /config-work/ })).toBeTruthy();
    restored.unmount();
  });
});
