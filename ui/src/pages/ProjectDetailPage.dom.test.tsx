// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Link } from "react-router-dom";
import type { OnePager, Project, ProjectPulse, Routine, Task } from "../api/client";
import { setLocale } from "../i18n";
import { useAppStore } from "../store/appStore";
import { writeProjectCover } from "../lib/projectCoverCache";

/**
 * KIN-PROJECT-001: the project cover is one surface, not a second list.
 *
 * The page has no tabs and one conversation row — the newest. The pulse, the
 * activity feed and the routines each fail inside their own block, because a
 * cover that blanks itself when one feed is down cannot answer the question it
 * exists for. The summary edits the One-Pager's Current Focus in place.
 */

const machineState = vi.hoisted(() => ({
  agents: [{ id: "kin", installed: true, available: true }],
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
    machines: [
      {
        id: "mac-1",
        label: "MacBook Pro",
        isSelf: true,
        online: true,
        roots: [],
        agents: machineState.agents,
      },
    ],
    loading: false,
    failed: false,
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

beforeEach(() => {
  setLocale("en");
  sessionStorage.clear();
  useAppStore.setState({ wsStatus: "connected", reconnectGen: 0 });
  machineState.agents = [{ id: "kin", installed: true, available: true }];
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

    for (const name of ["One-line summary", "Recent activity", "Last two weeks", "Routines in this project"]) {
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
    expect(await screen.findByText("Nothing yet — say in one line what this project is doing.")).toBeTruthy();
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
    client.getOnePager
      .mockResolvedValueOnce(onePager)
      .mockResolvedValueOnce(theirs);
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
});
