// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Link } from "react-router-dom";
import type { OnePager, Project, ProjectPulse, Routine, Task } from "../api/client";
import { setLocale } from "../i18n";
import { useAppStore } from "../store/appStore";
import { readProjectCover, writeProjectCover } from "../lib/projectCoverCache";
import { setLocalTaskTitle } from "../lib/taskTitles";

/**
 * KIN-PROJECT-001: the project cover is one surface, not a second list.
 * KIN-CONTINUE-003 row 11: roots, modes, cover scroll and no duplicate list.
 *
 * The page has no tabs and one conversation row — the newest. The pulse, the
 * activity feed and the routines each fail inside their own block, because a
 * cover that blanks itself when one feed is down cannot answer the question it
 * exists for. The summary edits the One-Pager's Current Focus in place.
 */

const machineState = vi.hoisted(() => ({
  failed: false,
  agents: [{ id: "kin", installed: true, available: true }],
  machines: [
    {
      id: "mac-1",
      label: "MacBook Pro",
      isSelf: true,
      online: true,
      roots: [] as string[],
      agents: [{ id: "kin", installed: true, available: true }],
    },
  ],
}));

const client = vi.hoisted(() => ({
  getProject: vi.fn(),
  getOnePager: vi.fn(),
  getProjectPulse: vi.fn(),
  listProjectTasks: vi.fn(),
  listAgentSessions: vi.fn(),
  listRoutines: vi.fn(),
  putOnePager: vi.fn(),
  patchProject: vi.fn(),
  refreshProjectPulse: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    isAuthenticated: () => true,
    getProject: client.getProject,
    getOnePager: client.getOnePager,
    getProjectPulse: client.getProjectPulse,
    listProjectTasks: client.listProjectTasks,
    listAgentSessions: client.listAgentSessions,
    listRoutines: client.listRoutines,
    putOnePager: client.putOnePager,
    patchProject: client.patchProject,
    refreshProjectPulse: client.refreshProjectPulse,
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: machineState.machines.map((machine) => ({
      ...machine,
      agents: machine.isSelf ? machineState.agents : machine.agents,
    })),
    loading: false,
    failed: machineState.failed,
  }),
}));

import { ApiError } from "../api/client";
import ProjectDetailPage, { lastCommitAt } from "./ProjectDetailPage";

const project: Project = {
  id: "p1",
  name: "alpha",
  mode: "ship",
  status: "active",
  created_at: 1,
  updated_at: 2,
  last_active_at: 3,
  roots: ["/work/alpha"],
};

const onePager: OnePager = {
  project_id: "p1",
  markdown: "# alpha\n\n## North Star\nwhy it exists\n\n## Current Focus\nship the first slice\n",
  updated_at: 100,
  one_pager_summary: { focus: "ship the first slice", north_star: "why it exists" },
};

function task(partial: Partial<Task> & Pick<Task, "id" | "created_at">): Task {
  return {
    title: partial.title ?? partial.id,
    agent: "kin",
    cwd: "/work/alpha",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    ...partial,
  };
}

function pulse(overrides: Partial<ProjectPulse> = {}): ProjectPulse {
  return {
    project_id: "p1",
    generated_at: Date.now(),
    window_days: 14,
    session_total: 2,
    session_window: 2,
    sessions_running: 0,
    sessions_waiting: 0,
    session_heat: [
      { date: "2026-11-09", count: 1 },
      { date: "2026-11-10", count: 2 },
    ],
    git_available: true,
    commit_window: 1,
    commit_heat: [{ date: "2026-11-10", count: 1 }],
    auto_markdown: "",
    ...overrides,
  };
}

const routine: Routine = {
  id: "r1",
  project_id: "p1",
  cwd: "/work/alpha",
  agent: "kin",
  permission_mode: "default",
  prompt: "tidy the notes",
  interval_secs: 86400,
  enabled: true,
  next_due_at: 4,
  consec_failures: 0,
  created_at: 1,
  title: "Tidy notes",
  missed_run_policy: "coalesce",
  lane: "default",
  recurrence: "",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 1024px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderPage(entry = "/projects/p1", withSwitch = false) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      {withSwitch && <Link to="/projects/p2">switch project</Link>}
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/routines" element={<div>routines page</div>} />
        <Route path="/tasks/:id" element={<div>task page</div>} />
        <Route path="/agent-sessions/:id" element={<div>session page</div>} />
        <Route path="/new" element={<div>new chat page</div>} />
        <Route path="/sessions" element={<div>sessions page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function happyPath() {
  // A fresh object per read, like the daemon's JSON: React must see a new
  // project record on a reload, not an identity-equal value it can skip.
  client.getProject.mockImplementation(async () => ({ ...project }));
  client.getOnePager.mockResolvedValue(onePager);
  client.getProjectPulse.mockResolvedValue(pulse());
  client.listProjectTasks.mockResolvedValue([
    task({ id: "older", created_at: 10, title: "older chat" }),
    task({ id: "newest", created_at: 30, title: "newest chat" }),
  ]);
  client.listAgentSessions.mockResolvedValue([]);
  client.listRoutines.mockResolvedValue({ routines: [routine], has_more: false });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  setLocale("en");
  sessionStorage.clear();
  // A rename is per-browser and outlives a test; a title left in storage would
  // rename the next test's rows.
  localStorage.removeItem("kin_task_titles");
  useAppStore.setState({ wsStatus: "connected", reconnectGen: 0 });
  machineState.agents = [{ id: "kin", installed: true, available: true }];
  machineState.failed = false;
  machineState.machines = [
    {
      id: "mac-1",
      label: "MacBook Pro",
      isSelf: true,
      online: true,
      roots: [],
      agents: machineState.agents,
    },
  ];
  for (const fn of Object.values(client)) fn.mockReset();
  happyPath();
});

describe("the project cover (KIN-PROJECT-001)", () => {
  it("shows the project, its newest conversation and no second list", async () => {
    renderPage();

    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByText("/work/alpha")).toBeTruthy();
    expect(await screen.findByText("ship the first slice")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /newest chat/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /older chat/ })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("names its four sections with headings", async () => {
    renderPage();
    await screen.findByText("alpha");

    for (const name of [
      "One-line summary",
      "Recent activity",
      "Last two weeks",
      "Routines in this project",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
  });

  it("shows the project's routines as belonging, with the /routines entry", async () => {
    renderPage();

    expect(await screen.findByText("Tidy notes")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Go to routines/ }).getAttribute("href")).toBe(
      "/routines",
    );
    expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
  });

  it("reads routines from the machine that owns the project folder", async () => {
    machineState.machines = [
      ...machineState.machines,
      {
        id: "node-1",
        label: "Build node",
        isSelf: false,
        online: true,
        roots: ["/work"],
        agents: [{ id: "kin", installed: true, available: true }],
      },
    ];
    renderPage();

    expect(await screen.findByText("Tidy notes")).toBeTruthy();
    expect(client.listRoutines).toHaveBeenCalledWith({ limit: 100 }, "node-1");
    expect(client.listRoutines).not.toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "p1" }),
      expect.anything(),
    );
    expect(screen.getByRole("link", { name: /Go to routines/ }).getAttribute("href")).toBe(
      "/routines?device=node-1",
    );
  });

  it("keeps the remembered remote routines owner when the machine list fails", async () => {
    machineState.failed = true;
    localStorage.setItem("kin_routines_device", "node-1");
    renderPage();

    expect(await screen.findByText("alpha")).toBeTruthy();
    await waitFor(() => expect(client.listRoutines).toHaveBeenCalledWith({ limit: 100 }, "node-1"));
    expect(client.listRoutines).not.toHaveBeenCalledWith(expect.anything(), undefined);
    expect(screen.getByRole("link", { name: /Go to routines/ }).getAttribute("href")).toBe(
      "/routines?device=node-1",
    );
  });

  it("does not read the Hub routines when a failed machine list has no owner", async () => {
    machineState.failed = true;
    localStorage.removeItem("kin_routines_device");
    renderPage();

    expect(await screen.findByText("alpha")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/Routines are unavailable right now/)).toBeTruthy(),
    );
    expect(client.listRoutines).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /Go to routines/ })).toBeNull();
  });

  it("starts a chat in the project's only root", async () => {
    renderPage();

    const link = await screen.findByRole("link", { name: "New chat" });
    expect(link.getAttribute("href")).toBe("/new?cwd=%2Fwork%2Falpha");
  });

  it("keeps the cover when the overview feed fails", async () => {
    client.getProjectPulse.mockRejectedValue(new Error("pulse down"));
    renderPage();

    expect(await screen.findByText("Overview is unavailable right now")).toBeTruthy();
    // The rest of the cover is still the answer to "what happened here".
    expect(await screen.findByText("ship the first slice")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /newest chat/ })).toBeTruthy();
    // A failed first load is terminal, not an eternal skeleton.
    const card = screen.getByRole("heading", { name: "Last two weeks" }).closest("section");
    expect(card?.querySelectorAll(".animate-pulse").length).toBe(0);
  });

  it("treats a missing One-Pager as an empty summary, not a missing project", async () => {
    client.getOnePager.mockRejectedValue(new ApiError(404, "one-pager file missing"));
    renderPage();

    expect(await screen.findByRole("heading", { level: 1, name: "alpha" })).toBeTruthy();
    expect(
      await screen.findByText("Nothing yet — say in one line what this project is doing."),
    ).toBeTruthy();
    expect(screen.queryByText("Project not found")).toBeNull();
  });

  it("keeps the project when the summary read fails", async () => {
    client.getOnePager.mockRejectedValue(new Error("summary down"));
    renderPage();

    expect(await screen.findByText("The summary is unavailable right now")).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 1, name: "alpha" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /newest chat/ })).toBeTruthy();
  });

  it("says the project is gone instead of drawing an empty cover", async () => {
    client.getProject.mockRejectedValue(new ApiError(404, "not found"));
    renderPage();

    expect(await screen.findByText("Project not found")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Back/ })).toBeTruthy();
    expect(screen.queryByText("One-line summary")).toBeNull();
  });

  it("saves the one line into Current Focus, leaving the other sections alone", async () => {
    client.putOnePager.mockImplementation(async (_id: string, markdown: string) => ({
      project_id: "p1",
      markdown,
      updated_at: 101,
      one_pager_summary: { focus: "the new line", north_star: "why it exists" },
    }));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("ship the first slice");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "One-line summary" });
    expect(document.activeElement).toBe(field);
    await user.clear(field);
    await user.type(field, "the new line");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(client.putOnePager).toHaveBeenCalledTimes(1));
    const [, markdown, updatedAt] = client.putOnePager.mock.calls[0];
    expect(markdown).toContain("## Current Focus\nthe new line");
    expect(markdown).toContain("## North Star\nwhy it exists");
    expect(updatedAt).toBe(100);
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.getByText("the new line")).toBeTruthy();
  });

  it("saves against the version the editor opened, not a reconnect's newer one", async () => {
    client.putOnePager.mockImplementation(async (_id: string, markdown: string) => ({
      project_id: "p1",
      markdown,
      updated_at: 201,
      one_pager_summary: { focus: "my line" },
    }));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("ship the first slice");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "One-line summary" });
    await user.clear(field);
    await user.type(field, "my line");

    // Another device wrote meanwhile and a reconnect read it. The draft stays,
    // but saving must still use the base this editor started from, which is
    // what makes the 409 (rather than a silent overwrite) possible.
    client.getOnePager.mockResolvedValue({
      project_id: "p1",
      markdown: "# alpha\n\n## Current Focus\ntheir line\n",
      updated_at: 150,
      one_pager_summary: { focus: "their line" },
    });
    useAppStore.setState({ reconnectGen: 1 });
    await waitFor(() => expect(client.getOnePager).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.putOnePager).toHaveBeenCalledTimes(1));
    expect(client.putOnePager.mock.calls[0][2]).toBe(100);
  });

  it("shows the other version on conflict and overwrites only on request", async () => {
    const theirs: OnePager = {
      project_id: "p1",
      markdown: "# alpha\n\n## Current Focus\ntheir line\n",
      updated_at: 200,
      one_pager_summary: { focus: "their line" },
    };
    client.getOnePager.mockResolvedValueOnce(onePager).mockResolvedValueOnce(theirs);
    client.putOnePager
      .mockRejectedValueOnce(new ApiError(409, "conflict"))
      .mockImplementation(async (_id: string, markdown: string) => ({
        project_id: "p1",
        markdown,
        updated_at: 201,
        one_pager_summary: { focus: "my line" },
      }));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("ship the first slice");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "One-line summary" });
    await user.clear(field);
    await user.type(field, "my line");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/This cover changed elsewhere/)).toBeTruthy();
    expect(screen.getByText("their line")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Keep mine and overwrite" }));
    await waitFor(() => expect(client.putOnePager).toHaveBeenCalledTimes(2));
    const [, markdown, updatedAt] = client.putOnePager.mock.calls[1];
    // Composed on their document, not the stale one, so their other sections
    // survive the overwrite.
    expect(markdown).toContain("## Current Focus\nmy line");
    expect(updatedAt).toBe(200);
  });

  it("keeps the last conversation row when a reload fails", async () => {
    renderPage();
    await screen.findByRole("button", { name: /newest chat/ });

    client.listProjectTasks.mockRejectedValue(new Error("tasks down"));
    useAppStore.setState({ reconnectGen: 1 });

    expect(await screen.findByText("Recent activity is unavailable right now")).toBeTruthy();
    // The error sits above the row it could not refresh.
    expect(screen.getByRole("button", { name: /newest chat/ })).toBeTruthy();
  });

  it("a rename made elsewhere updates the cover's recent row without navigation", async () => {
    client.listProjectTasks.mockResolvedValue([
      task({ id: "t1", created_at: 30, title: "Old name" }),
    ]);
    renderPage();

    expect(await screen.findByRole("button", { name: /Old name/ })).toBeTruthy();

    // The sidebar's rename writes the browser's map and tells every mounted
    // reader; the cover's one row is a reader, not a copy taken at read time.
    act(() => {
      setLocalTaskTitle("t1", "New name");
    });

    expect(await screen.findByRole("button", { name: /New name/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Old name/ })).toBeNull();
    // The rename reaches the row without re-reading the feed or leaving the
    // cover: a refetch would lose the reader's place for a name they typed.
    expect(client.listProjectTasks).toHaveBeenCalledTimes(1);
  });

  it("a rename that lands before the activity read resolves is the name the row shows", async () => {
    const feed = deferred<Task[]>();
    client.listProjectTasks.mockReturnValue(feed.promise);
    renderPage();

    await screen.findByText("alpha");
    act(() => {
      setLocalTaskTitle("t1", "New name");
    });
    await act(async () => {
      feed.resolve([task({ id: "t1", created_at: 30, title: "Old name" })]);
      await feed.promise;
    });

    // The read answered with the daemon's title, but the reader's rename is the
    // current one; the row must not flash the old name back over it.
    expect(await screen.findByRole("button", { name: /New name/ })).toBeTruthy();
    expect(screen.queryByText(/Old name/)).toBeNull();
  });

  it("the cached cover row is renamed for the next visit", async () => {
    client.listProjectTasks.mockResolvedValue([
      task({ id: "t1", created_at: 30, title: "Old name" }),
    ]);
    const view = renderPage();
    await screen.findByRole("button", { name: /Old name/ });

    act(() => {
      setLocalTaskTitle("t1", "New name");
    });
    await waitFor(() => expect(readProjectCover("p1")?.latest?.title).toBe("New name"));
    view.unmount();

    // Reopening with the feed down paints the per-browser cover first, and that
    // row was written with the old name unless the rename updated it too.
    client.listProjectTasks.mockRejectedValue(new Error("offline"));
    renderPage();

    expect(await screen.findByRole("button", { name: /New name/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Old name/ })).toBeNull();
    expect(readProjectCover("p1")?.latest?.title).toBe("New name");
  });

  it("drops a project read that a newer route has replaced", async () => {
    const slow = deferred<Project>();
    const fast = deferred<Project>();
    client.getProject.mockImplementation((projectId: string) =>
      projectId === "p1" ? slow.promise : fast.promise,
    );
    client.getOnePager.mockImplementation(async (projectId: string) => ({
      ...onePager,
      project_id: projectId,
      markdown: `# beta\n\n## Current Focus\n${projectId} line\n`,
      one_pager_summary: { focus: `${projectId} line` },
    }));
    const user = userEvent.setup();
    renderPage("/projects/p1", true);

    await user.click(screen.getByRole("link", { name: "switch project" }));
    fast.resolve({ ...project, id: "p2", name: "beta" });
    expect(await screen.findByRole("heading", { level: 1, name: "beta" })).toBeTruthy();

    // The first route's read resolves late. It must not install itself — and
    // it must not leave the cover blank either. Flush the promise before
    // asserting, or the check runs before the stale write could land.
    slow.resolve(project);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(screen.getByRole("heading", { level: 1, name: "beta" })).toBeTruthy();
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("does not offer a chat without a root", async () => {
    client.getProject.mockResolvedValue({ ...project, roots: [] });
    renderPage();

    const button = await screen.findByRole("button", { name: "New chat" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Link a working directory to this project before starting a chat"),
    ).toBeTruthy();
  });

  it("does not offer a chat when no agent is available", async () => {
    machineState.agents = [];
    renderPage();

    const button = await screen.findByRole("button", { name: "New chat" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("No agent is available to start a chat.")).toBeTruthy();
  });

  it("disables edits and new chats offline", async () => {
    useAppStore.setState({ wsStatus: "disconnected" });
    renderPage();

    expect(await screen.findByText(/Offline — showing the last result/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("paints the cached cover when the daemon cannot answer", async () => {
    writeProjectCover("p1", {
      project,
      pulse: pulse(),
      routines: [routine],
      routinesLoaded: true,
      latest: { key: "newest", at: 30, title: "newest chat", agentId: "kin", remote: false },
      lastImportAt: 20,
      activityLoaded: true,
      savedAt: Date.now() - 60_000,
    });
    useAppStore.setState({ wsStatus: "disconnected" });
    client.getProject.mockRejectedValue(new Error("offline"));
    client.getOnePager.mockRejectedValue(new Error("offline"));
    client.getProjectPulse.mockRejectedValue(new Error("offline"));
    client.listProjectTasks.mockRejectedValue(new Error("offline"));
    client.listRoutines.mockRejectedValue(new Error("offline"));
    renderPage();

    expect(await screen.findByRole("heading", { level: 1, name: "alpha" })).toBeTruthy();
    expect(screen.getByText("/work/alpha")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /newest chat/ })).toBeTruthy();
    expect(screen.getByText("Tidy notes")).toBeTruthy();
  });

  it("returns to the same scroll position after a conversation", async () => {
    const view = renderPage();
    await screen.findByRole("button", { name: /newest chat/ });

    const first = screen.getByTestId("project-scroll");
    first.scrollTop = 480;
    fireEvent.scroll(first);
    view.unmount();

    renderPage();
    await screen.findByRole("button", { name: /newest chat/ });
    await waitFor(() => expect(screen.getByTestId("project-scroll").scrollTop).toBe(480));
  });

  it("waits for the overview blocks before restoring the position", async () => {
    const view = renderPage();
    await screen.findByRole("button", { name: /newest chat/ });
    const first = screen.getByTestId("project-scroll");
    first.scrollTop = 480;
    fireEvent.scroll(first);
    view.unmount();

    const feed = deferred<Task[]>();
    client.listProjectTasks.mockReturnValue(feed.promise);
    renderPage();
    await screen.findByRole("button", { name: /newest chat/ });

    // The activity block still has skeleton height; restoring now would clamp.
    expect(screen.getByTestId("project-scroll").scrollTop).toBe(0);
    feed.resolve([task({ id: "newest", created_at: 30, title: "newest chat" })]);
    await waitFor(() => expect(screen.getByTestId("project-scroll").scrollTop).toBe(480));
  });

  it("asks before leaving a cover with an unsaved draft", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /newest chat/ });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "One-line summary" });
    await user.clear(field);
    await user.type(field, "unsaved line");
    await user.click(screen.getByRole("button", { name: /newest chat/ }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "One-line summary" })).toBeTruthy();
    expect(screen.queryByText("task page")).toBeNull();
    confirm.mockRestore();
  });

  it("does not date a commit in the future", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const date = [
      tomorrow.getFullYear(),
      String(tomorrow.getMonth() + 1).padStart(2, "0"),
      String(tomorrow.getDate()).padStart(2, "0"),
    ].join("-");

    const at = lastCommitAt(pulse({ commit_heat: [{ date, count: 1 }] }));
    expect(at).not.toBeNull();
    expect(at ?? 0).toBeLessThanOrEqual(Date.now());
  });

  it("Esc leaves the cover", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("alpha");

    await user.keyboard("{Escape}");
    expect(await screen.findByText("sessions page")).toBeTruthy();
  });

  it("⌘Enter starts a chat from the cover", async () => {
    renderPage();
    await screen.findByText("alpha");

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(await screen.findByText("new chat page")).toBeTruthy();
  });

  it("puts the page's actions on the facade without changing their names or handlers", async () => {
    const user = userEvent.setup();
    // The routines card only draws its refresh next to a failed read, so the
    // error state is where all three of the page's own actions are on screen.
    client.listRoutines.mockRejectedValue(new Error("routines down"));
    client.refreshProjectPulse.mockResolvedValue({
      pulse: pulse(),
      markdown: onePager.markdown,
      updated_at: onePager.updated_at,
    });
    renderPage();
    await screen.findByText("alpha");

    const back = screen.getByRole("button", { name: "Back" });
    const refresh = screen.getByRole("button", { name: "Refresh" });
    const routinesRefresh = await screen.findByRole("button", { name: "Retry" });

    for (const control of [back, refresh, routinesRefresh]) {
      expect(control.className).toContain("kin-btn");
    }
    // Same accessible names as before the facade: back, the pulse refresh and
    // the routines refresh.
    expect(back.textContent).toContain("Back");
    expect(refresh.textContent).toContain("Refresh");

    await user.click(refresh);
    expect(client.refreshProjectPulse).toHaveBeenCalledTimes(1);

    await user.click(routinesRefresh);
    expect(client.listRoutines).toHaveBeenCalledTimes(2);
  });

  it("offers exactly one filled primary on the project page", async () => {
    const user = userEvent.setup();
    const view = renderPage();
    await screen.findByText("alpha");
    await screen.findByRole("button", { name: "Edit" });

    expect(view.container.querySelectorAll(".kin-btn-primary").length).toBe(1);

    view.unmount();
    sessionStorage.clear();

    // Editing the One-Pager makes Save the screen's one filled action: the
    // New chat call to action (the phone bar at this width) steps aside
    // rather than pairing with it.
    viewport(false);
    const phone = renderPage();
    await screen.findByText("alpha");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(phone.container.querySelector('[data-project-cta="bar"]')).toBeNull();
    expect(phone.container.querySelectorAll(".kin-btn-primary").length).toBe(1);

    phone.unmount();
    sessionStorage.clear();

    // The error state answers with one action too: a retry, never a second
    // filled control competing with it.
    client.getProject.mockRejectedValue(new Error("boom"));
    const failed = renderPage();
    await screen.findByRole("button", { name: "Retry" });
    expect(failed.container.querySelectorAll(".kin-btn-primary").length).toBe(1);
  });

  it("keeps the new-chat call to action a link", async () => {
    viewport(true);
    const wide = renderPage();

    const wideLink = await screen.findByRole("link", { name: "New chat" });
    // A link, so middle-click and open-in-new-tab keep working.
    expect(wideLink.tagName).toBe("A");
    expect(wideLink.getAttribute("href")).toBe("/new?cwd=%2Fwork%2Falpha");
    const recentSection = screen
      .getByRole("heading", { name: "Recent activity" })
      .closest("section")!;
    expect(recentSection.contains(wideLink)).toBe(true);
    expect(wide.container.querySelector('[data-project-cta="bar"]')).toBeNull();

    wide.unmount();

    // A phone gets the same link in a bottom bar instead of at the end of the
    // scroll.
    viewport(false);
    const phone = renderPage();
    const phoneLink = await screen.findByRole("link", { name: "New chat" });
    expect(phoneLink.getAttribute("href")).toBe("/new?cwd=%2Fwork%2Falpha");
    expect(
      screen
        .getByRole("heading", { name: "Recent activity" })
        .closest("section")!
        .contains(phoneLink),
    ).toBe(false);

    const bar = phone.container.querySelector<HTMLElement>('[data-project-cta="bar"]');
    expect(bar).toBeTruthy();
    expect(bar!.className).toContain("sticky");
    expect(bar!.className).toContain("bottom-0");
    expect(bar!.contains(phoneLink)).toBe(true);
    expect(bar!.querySelectorAll(".kin-btn-primary").length).toBe(1);
  });
});

/**
 * KIN-PROJECT-002: the cover shows every working folder, not only the first.
 *
 * The daemon already stores an ordered list (`roots`), and PATCH replaces it as
 * a whole. So the cover has one job here: draw the saved list with its default,
 * and edit it as a draft that only becomes the saved list on a successful
 * save.
 */
const threeRoots = ["/work/alpha", "/work/alpha-config", "/work/shared-lib"];

function withRoots(roots: string[]): Project {
  return { ...project, roots };
}

async function openRootsEditor() {
  const user = userEvent.setup();
  const block = await screen.findByRole("region", { name: "Working folders" });
  await user.click(within(block).getByRole("button", { name: "Edit folders" }));
  const dialog = await screen.findByRole("dialog", { name: "Working folders" });
  return { user, block, dialog };
}

describe("the project's working folders (KIN-PROJECT-002)", () => {
  it("KIN-PROJECT-002 shows every root in saved order and marks only the first default", async () => {
    client.getProject.mockImplementation(async () => withRoots(threeRoots));
    renderPage();

    const block = await screen.findByRole("region", { name: "Working folders" });
    const rows = within(block).getAllByRole("listitem");

    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("/work/alpha");
    expect(rows[1]!.textContent).toContain("/work/alpha-config");
    expect(rows[2]!.textContent).toContain("/work/shared-lib");
    // The first saved folder is the default, and it is the only one that says
    // so: a second badge would make "default" a property of every row.
    expect(within(rows[0]!).getByText("Default")).toBeTruthy();
    expect(within(rows[1]!).queryByText("Default")).toBeNull();
    expect(within(rows[2]!).queryByText("Default")).toBeNull();
    expect(within(block).getByText(/New chats start in the first folder/)).toBeTruthy();
  });

  it("KIN-PROJECT-002 says default once per editor row and explains the intent", async () => {
    client.getProject.mockImplementation(async () => withRoots(threeRoots));
    renderPage();
    const { dialog } = await openRootsEditor();

    // The helper talks about where a new chat starts, not about what the save
    // request carries.
    expect(
      within(dialog).getByText(
        "The first folder is where new chats start; changes apply when you save.",
      ),
    ).toBeTruthy();

    const rows = within(dialog).getAllByRole("listitem");
    // Row 1: the pill is the one statement that this folder is the default;
    // no disabled "already the default" button repeats it.
    expect(within(rows[0]!).getByText("Default")).toBeTruthy();
    expect(within(rows[0]!).queryByText("Already the default")).toBeNull();
    expect(within(rows[0]!).queryByRole("button", { name: "Make default" })).toBeNull();
    // Rows 2..n keep the action that moves the default.
    expect(within(rows[1]!).getByRole("button", { name: "Make default" })).toBeTruthy();
    expect(within(rows[2]!).getByRole("button", { name: "Make default" })).toBeTruthy();
  });

  it("KIN-PROJECT-002 saves the complete ordered list through PATCH roots", async () => {
    client.getProject.mockImplementation(async () => withRoots(threeRoots));
    client.patchProject.mockImplementation(async (_id: string, body: { roots?: string[] }) =>
      withRoots(body.roots ?? []),
    );
    renderPage();
    const { user, block, dialog } = await openRootsEditor();

    await user.click(
      within(within(dialog).getAllByRole("listitem")[1]!).getByRole("button", {
        name: "Make default",
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save folders" }));

    await waitFor(() => expect(client.patchProject).toHaveBeenCalledTimes(1));
    // The whole ordered list, not a delta: the server replaces `roots`.
    expect(client.patchProject).toHaveBeenCalledWith("p1", {
      roots: ["/work/alpha-config", "/work/alpha", "/work/shared-lib"],
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Working folders" })).toBeNull(),
    );

    const updated = within(block).getAllByRole("listitem");
    expect(updated[0]!.textContent).toContain("/work/alpha-config");
    expect(within(updated[0]!).getByText("Default")).toBeTruthy();
    expect(updated[1]!.textContent).toContain("/work/alpha");
  });

  it("KIN-PROJECT-002 keeps the sheet open with the draft and a retry when the save fails", async () => {
    client.getProject.mockImplementation(async () => withRoots(threeRoots));
    client.patchProject.mockRejectedValueOnce(new ApiError(500, "network down"));
    renderPage();
    const { user, dialog } = await openRootsEditor();

    await user.click(
      within(within(dialog).getAllByRole("listitem")[1]!).getByRole("button", {
        name: "Make default",
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save folders" }));

    expect(await screen.findByText("network down")).toBeTruthy();
    // The editor is still there, and the draft — including the attempted
    // reorder — is still the list it shows.
    expect(screen.getByRole("dialog", { name: "Working folders" })).toBeTruthy();
    const rows = within(screen.getByRole("dialog", { name: "Working folders" })).getAllByRole(
      "listitem",
    );
    expect(rows[0]!.textContent).toContain("/work/alpha-config");
    // The cover behind the draft did not move.
    expect(
      within(screen.getByRole("region", { name: "Working folders" })).getAllByRole("listitem")[0]!
        .textContent,
    ).toContain("/work/alpha");
    // Focus is back on Save, so a retry is one Enter away.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(screen.getByRole("dialog", { name: "Working folders" })).getByRole("button", {
          name: "Save folders",
        }),
      ),
    );

    client.patchProject.mockImplementation(async (_id: string, body: { roots?: string[] }) =>
      withRoots(body.roots ?? []),
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(client.patchProject).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Working folders" })).toBeNull(),
    );
  });

  it("KIN-PROJECT-002 confirms before removing a root and says no conversation is deleted", async () => {
    client.getProject.mockImplementation(async () => withRoots(threeRoots));
    renderPage();
    const { user, block, dialog } = await openRootsEditor();

    await user.click(
      within(within(dialog).getAllByRole("listitem")[1]!).getByRole("button", { name: "Remove" }),
    );

    const confirm = await screen.findByRole("group", { name: "Remove /work/alpha-config?" });
    expect(within(confirm).getByText(/no longer appear under this project/)).toBeTruthy();
    expect(within(confirm).getByText(/No conversation is deleted/)).toBeTruthy();
    // The confirmation is a bar in the row, not a second full-screen dialog.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" })),
    );

    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getAllByRole("listitem")).toHaveLength(2),
    );
    expect(within(screen.getByRole("dialog")).queryByText("/work/alpha-config")).toBeNull();
    // Removing from the draft is not removing from the project: nothing is
    // saved and the cover still lists all three.
    expect(client.patchProject).not.toHaveBeenCalled();
    expect(within(block).getAllByRole("listitem")).toHaveLength(3);
  });

  it("KIN-PROJECT-002 adds a picked folder to the draft and reports a duplicate inline", async () => {
    client.getProject.mockImplementation(async () => withRoots(threeRoots));
    renderPage();
    const { user, block, dialog } = await openRootsEditor();

    // The adding row is the new-chat pickers, not a second folder browser:
    // machine first, then the directory, with the type-a-path escape hatch.
    await user.click(within(dialog).getByRole("button", { name: /Add folder/ }));
    await user.click(within(dialog).getByRole("button", { name: "Edit" }));
    const field = await screen.findByRole("combobox");
    await user.type(field, "/work/extra{Enter}");

    const rows = within(dialog).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[3]!.textContent).toContain("/work/extra");
    // Nothing is written until Save, and the cover keeps its saved list.
    expect(client.patchProject).not.toHaveBeenCalled();
    expect(within(block).getAllByRole("listitem")).toHaveLength(3);

    await user.click(within(dialog).getByRole("button", { name: /Add folder/ }));
    await user.click(within(dialog).getByRole("button", { name: "Edit" }));
    const again = await screen.findByRole("combobox");
    await user.type(again, "/work/extra{Enter}");

    // A duplicate is a sentence next to the picker, not a fifth row.
    expect(await screen.findByText("That folder is already in the list.")).toBeTruthy();
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(4);
  });

  it("KIN-PROJECT-002 warns that removing the last root leaves new chats nowhere to land", async () => {
    client.getProject.mockImplementation(async () => withRoots(["/work/alpha"]));
    renderPage();
    const { user, dialog } = await openRootsEditor();

    await user.click(
      within(within(dialog).getAllByRole("listitem")[0]!).getByRole("button", { name: "Remove" }),
    );

    expect(await screen.findByText(/New chats will have nowhere to start/)).toBeTruthy();
    // The warning explains the consequence; it does not forbid the save.
    expect(
      (within(dialog).getByRole("button", { name: "Save folders" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("KIN-PROJECT-002 reopening the editor shows the saved list, not a cancelled draft", async () => {
    client.getProject.mockImplementation(async () => withRoots(threeRoots));
    renderPage();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, block, dialog } = await openRootsEditor();

    await user.click(
      within(within(dialog).getAllByRole("listitem")[1]!).getByRole("button", {
        name: "Make default",
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Working folders" })).toBeNull(),
    );
    // The sheet's history entry is given back asynchronously; reopening before
    // that lands would race the next push against the pending Back.
    await waitFor(() =>
      expect((window.history.state as { kinSheet?: string } | null)?.kinSheet).toBeUndefined(),
    );

    await user.click(within(block).getByRole("button", { name: "Edit folders" }));
    const reopened = await screen.findByRole("dialog", { name: "Working folders" });
    const rows = within(reopened).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("/work/alpha");
    expect(within(rows[0]!).getByText("Default")).toBeTruthy();
    expect(within(reopened).getByText("/work/alpha-config")).toBeTruthy();
    expect(client.patchProject).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("KIN-PROJECT-002 disables editing offline and says why", async () => {
    client.getProject.mockImplementation(async () => withRoots(threeRoots));
    useAppStore.setState({ wsStatus: "disconnected" });
    renderPage();

    const block = await screen.findByRole("region", { name: "Working folders" });
    // The cached/read list stays readable; only the write entry goes away.
    expect(within(block).getAllByRole("listitem")).toHaveLength(3);
    const edit = within(block).getByRole("button", { name: "Edit folders" }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(within(block).getByText(/Offline — folder editing is disabled/)).toBeTruthy();
  });

  it("KIN-PROJECT-002 opens the anchored editor from the empty state on a wide cover", async () => {
    viewport(true);
    client.getProject.mockImplementation(async () => withRoots([]));
    renderPage();

    const user = userEvent.setup();
    const block = await screen.findByRole("region", { name: "Working folders" });
    expect(within(block).getByText("This project has no folders yet.")).toBeTruthy();
    // With nothing saved the header's Edit button is not mounted: the empty
    // state's own button is the trigger, and it must anchor the popover.
    expect(within(block).queryByRole("button", { name: "Edit folders" })).toBeNull();
    const add = within(block).getByRole("button", { name: /Add folder/ });
    expect(add.getAttribute("aria-haspopup")).toBe("dialog");
    expect(add.getAttribute("aria-expanded")).toBe("false");

    await user.click(add);

    const dialog = await screen.findByRole("dialog", { name: "Working folders" });
    expect(within(dialog).getByText("This project has no folders yet.")).toBeTruthy();
    expect(add.getAttribute("aria-expanded")).toBe("true");
  });
});
