// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type { Machine } from "../../lib/devices";
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
    listAgentSessionsPage: vi.fn(async () => ({ items: [] as AgentSession[], next_cursor: undefined })),
    listProjects: vi.fn(async () => fixtures.projects),
    listTasks: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p", name: "shared" })),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: fixtures.machines,
    loading: false,
    failed: fixtures.machines.length === 0,
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

function task(
  id: string,
  cwd: string,
  device?: string,
  archivedAt?: number,
  status: Task["status"] = "succeeded",
): Task {
  return {
    id,
    title: id,
    cwd,
    agent: "kin",
    prompt: "",
    status,
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
    ...(device ? { executing_device_id: device } : {}),
    ...(archivedAt ? { archived_at: archivedAt } : {}),
  } as Task;
}

function page(path = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionList shell="page" />
    </MemoryRouter>,
  );
}

function sidebar(path = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionList shell="sidebar" />
    </MemoryRouter>,
  );
}

/** The list's URL, and whether the last write replaced or pushed history. */
function LocationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <output data-testid="location" data-nav={navigationType}>
      {location.search}
    </output>
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
  fixtures.machines = [
    { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    { id: "nas-1", label: "Studio", isSelf: false, online: true, roots: [], agents: [] },
  ];
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

  it("offers the remote copy no local-only rows in its touch menu", async () => {
    page();

    const remote = section(/Studio/);
    await openMenu(remote);
    // A new session belongs to the NAS and keeps its machine. The cover and
    // the archive entry are this machine's project record; a row that would
    // return early is a row that silently did nothing.
    expect(screen.getByRole("button", { name: "New session in shared" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open cover" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove from sidebar" })).toBeNull();
  });

  it("restores the local project, never the remote copy that shares its path", async () => {
    fixtures.tasks = [task("remote-put-away", "/work/shared", "nas-1", 99)];
    localStorage.setItem("kin_archived_projects", JSON.stringify(["/work/shared"]));
    page("/sessions?scope=archived");

    // The NAS archived its own conversation; this machine archived the
    // project. They share a path but not an identity, so the remote row has
    // no Restore and the empty local heading still does.
    const remote = section(/Studio/);
    expect(
      await within(remote).findByRole("button", { name: /remote-put-away/ }),
    ).toBeTruthy();
    expect(within(remote).queryByRole("button", { name: /Restore/ })).toBeNull();

    const local = section(/This machine/);
    await userEvent.click(within(local).getByRole("button", { name: "Restore shared" }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("kin_archived_projects") ?? "[]")).toEqual([]),
    );
    // The remote conversation is untouched by the local restore.
    expect(section(/Studio/)).toBeTruthy();
    expect(within(section(/Studio/)).getByRole("button", { name: /remote-put-away/ })).toBeTruthy();
  });

  it("treats a named machine as remote when this machine cannot be identified", async () => {
    // Both listMachines and serverVersion failed: there is no self id. A named
    // device is then not proven local, so no local project write is offered.
    fixtures.machines = [];
    fixtures.tasks = [task("remote-work", "/work/shared", "nas-1")];
    page();

    const remote = section(/nas-1/);
    await openMenu(remote);
    expect(screen.getByRole("button", { name: "New session in shared" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pin project" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open cover" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove from sidebar" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "New session in shared" }));
    // The draft still remembers which machine the path belongs to.
    await waitFor(() => expect(localStorage.getItem("kin_draft_machine")).toBe("nas-1"));
  });
});

/**
 * The attention view is a scope of the same list, at both shell widths.
 *
 * The chips are URL-backed (`?attention=`), so these tests read the rows the
 * person sees rather than a pure helper: a view that only narrows one shell,
 * or that forgets the search term when it writes the URL, would pass every
 * unit test above.
 */

function sidebarWithProbe(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionList shell="sidebar" />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("the conversation attention view", () => {
  it("?attention=needs lists only conversations waiting on the reader, at both shell widths", async () => {
    fixtures.tasks = [
      task("waiting-approval", "/work/shared", undefined, undefined, "waiting_approval"),
      task("waiting-input", "/work/shared", "nas-1", undefined, "waiting_input"),
      task("still-running", "/work/shared", undefined, undefined, "running"),
      task("finished", "/work/shared", undefined, undefined, "succeeded"),
      task("put-away", "/work/shared", undefined, 99, "waiting_input"),
    ];

    for (const shell of ["page", "sidebar"] as const) {
      const { unmount } =
        shell === "page" ? page("/sessions?attention=needs") : sidebar("/sessions?attention=needs");

      expect(
        await screen.findByRole("button", { name: /waiting-approval/ }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: /waiting-input/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /still-running/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /finished/ })).toBeNull();
      // The archived row is on the other side of the archive, not in this view.
      expect(screen.queryByRole("button", { name: /put-away/ })).toBeNull();

      unmount();
    }
  });

  it("?attention=running lists only in-flight conversations", async () => {
    fixtures.tasks = [
      task("live-running", "/work/shared", undefined, undefined, "running"),
      task("queued-running", "/work/shared", undefined, undefined, "queued"),
      task("retrying-running", "/work/shared", undefined, undefined, "retrying"),
      task("blocked-waiting", "/work/shared", undefined, undefined, "waiting_input"),
      task("finished-done", "/work/shared", undefined, undefined, "succeeded"),
    ];
    page("/sessions?attention=running");

    expect(await screen.findByRole("button", { name: /live-running/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /queued-running/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /retrying-running/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /blocked-waiting/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /finished-done/ })).toBeNull();
  });

  it("clicking the Needs you chip writes one URL change and keeps the search term", async () => {
    fixtures.tasks = [task("build-one", "/work/shared")];
    sidebarWithProbe("/sessions?search=build");

    const chips = await screen.findByRole("group", { name: "Conversation view" });
    await userEvent.click(within(chips).getByRole("button", { name: "Needs you" }));

    const location = screen.getByTestId("location");
    await waitFor(() => expect(location.textContent).toContain("attention=needs"));
    // The search is the list's other narrowing, not part of the view: the chip
    // keeps it, and the change is one replace rather than a history entry.
    expect(location.textContent).toContain("search=build");
    expect(location.textContent).not.toContain("status=");
    expect(location.textContent).not.toContain("scope=");
    expect(location.getAttribute("data-nav")).toBe("REPLACE");
  });

  it("an unknown ?attention= value shows the whole list, not an empty one", async () => {
    fixtures.tasks = [
      task("waiting-one", "/work/shared", undefined, undefined, "waiting_input"),
      task("live-two", "/work/shared", undefined, undefined, "running"),
      task("finished-three", "/work/shared", undefined, undefined, "succeeded"),
    ];
    page("/sessions?attention=waiting");

    // A stale link must not claim that nothing matches the view it names.
    expect(await screen.findByRole("button", { name: /waiting-one/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /live-two/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /finished-three/ })).toBeTruthy();
    expect(
      (await screen.findByRole("group", { name: "Conversation view" }))
        .querySelector('[aria-pressed="true"]')?.textContent,
    ).toBe("All");
  });
});
