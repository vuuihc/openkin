// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * Two machines, one path: the project menu touches only the copy that runs
 * here.
 *
 * The archive list and the project pin list are local-storage facts with no
 * device column. A touch menu that offered "Pin project" on a remote copy, or
 * an archive filter that applied the local entry to the remote copy, would
 * edit or hide a project on a machine the person is not looking at.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  projects: [] as Project[],
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
    listAgentSessionsPage: vi.fn(async () => ({ items: [] as AgentSession[], next_cursor: undefined })),
    listProjects: vi.fn(async () => fixtures.projects),
    listTasks: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p", name: "shared" })),
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

function viewport(pointer: "fine" | "coarse") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query === "(min-width: 768px)"
        ? false
        : query === "(pointer: coarse)"
          ? pointer === "coarse"
          : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function task(id: string, cwd: string, device?: string): Task {
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
    ...(device ? { executing_device_id: device } : {}),
  } as Task;
}

function page() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <SessionList shell="page" />
    </MemoryRouter>,
  );
}

function section(name: RegExp): HTMLElement {
  return screen.getByRole("region", { name }) as HTMLElement;
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [
    task("local-work", "/work/shared"),
    task("remote-work", "/work/shared", "nas-1"),
  ];
  fixtures.projects = [];
  viewport("coarse");
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

async function openMenu(scope: HTMLElement) {
  const button = await within(scope).findByRole("button", { name: "Project actions" });
  await userEvent.click(button);
}

describe("a project menu on a path two machines share", () => {
  it("offers the pin only on the local copy", async () => {
    page();

    const remote = section(/Studio/);
    await openMenu(remote);
    expect(screen.queryByRole("button", { name: "Pin project" })).toBeNull();
    expect(screen.getByRole("button", { name: "New session in shared" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const local = section(/This machine/);
    await openMenu(local);
    await userEvent.click(screen.getByRole("button", { name: "Pin project" }));

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("kin_pinned_projects") ?? "[]")).toEqual([
        "/work/shared",
      ]),
    );
  });

  it("archives the local copy only and leaves the remote copy on screen", async () => {
    page();

    await openMenu(section(/This machine/));
    await userEvent.click(screen.getByRole("button", { name: "Remove from sidebar" }));

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("kin_archived_projects") ?? "[]")).toEqual([
        "/work/shared",
      ]),
    );
    // The local heading is put away; the NAS copy of the same path is not.
    await waitFor(() => expect(screen.queryByRole("region", { name: /This machine/ })).toBeNull());
    const remote = section(/Studio/);
    expect(within(remote).getByRole("button", { name: "shared" })).toBeTruthy();
  });
});
