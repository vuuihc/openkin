// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router-dom";
import AppShell from "./AppShell";
import SessionsPage from "../../pages/SessionsPage";
import ProjectDetailPage from "../../pages/ProjectDetailPage";
import RoutinesPage from "../../pages/RoutinesPage";
import ArtifactsPage from "../../pages/ArtifactsPage";
import ArtifactDetailPage from "../../pages/ArtifactDetailPage";
import { setLocale } from "../../i18n";
import { resetLeaveGuard } from "../../lib/leaveGuard";
import type { Artifact, Task } from "../../api/client";

/**
 * The list is the parent of a conversation on a phone, whichever surface the
 * conversation was opened from. A project's Chats tab, a routine's run row and
 * the command palette all sit on destinations of their own; opening a
 * conversation (or the draft) from one must replace that destination with the
 * list instead of leaving it underneath, or Back lands on the project or the
 * routines page instead of the list.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  projectArtifacts: [] as Artifact[],
  artifacts: [] as Artifact[],
}));

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: fixtures.tasks,
    loaded: true,
    error: null,
    pageFull: false,
    loading: false,
  }),
  useTaskResource: () => ({ data: { task: undefined }, loaded: true, error: null }),
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
    isAuthenticated: vi.fn(() => true),
    listAgentSessionsPage: vi.fn(async () => ({ items: [], next_cursor: undefined })),
    listAgentSessions: vi.fn(async () => []),
    listProjects: vi.fn(async () => [
      {
        id: "p1",
        name: "alpha",
        mode: "ship",
        status: "active",
        roots: ["/work/alpha"],
        created_at: 1,
        updated_at: 2,
        last_active_at: 3,
      },
    ]),
    getProject: vi.fn(async (id: string) => ({
      id,
      name: "alpha",
      mode: "ship",
      status: "active",
      roots: ["/work/alpha"],
      created_at: 1,
      updated_at: 2,
      last_active_at: 3,
    })),
    listProjectTasks: vi.fn(async () => [
      {
        id: "project-chat",
        title: "Project chat",
        cwd: "/work/alpha",
        agent: "kin",
        prompt: "",
        status: "succeeded",
        tokens_in: 0,
        tokens_out: 0,
        event_epoch: 0,
        created_at: 1,
      },
    ]),
    getOnePager: vi.fn(async () => ({ project_id: "p1", markdown: "", updated_at: 1 })),
    listProjectArtifacts: vi.fn(async () => fixtures.projectArtifacts),
    getProjectPulse: vi.fn(async () => null),
    listArtifacts: vi.fn(async () => fixtures.artifacts),
    getArtifact: vi.fn(
      async (id: string) =>
        [...fixtures.artifacts, ...fixtures.projectArtifacts].find((a) => a.id === id) ??
        artifact(id, "Artifact"),
    ),
    getArtifactContent: vi.fn(async () => "# Artifact body"),
    setArtifactStatus: vi.fn(async (id: string, status: string) => ({
      ...artifact(id, "Artifact"),
      status,
    })),
    listRoutines: vi.fn(async () => ({ routines: [], has_more: false })),
    listRoutineRuns: vi.fn(async () => [
      {
        id: "run-1",
        title: "Nightly run",
        cwd: "/work/alpha",
        agent: "kin",
        prompt: "",
        status: "succeeded",
        tokens_in: 0,
        tokens_out: 0,
        event_epoch: 0,
        created_at: 1,
        finished_at: 2,
        routine_id: "routine-1",
        routine_noteworthy: true,
        routine_unread: false,
      } as Task,
    ]),
    listTasks: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p1", name: "alpha" })),
    getSettings: vi.fn(async () => null),
    listAgents: vi.fn(async () => []),
    serverVersion: vi.fn().mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" }),
    listMachines: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    ],
    agents: [],
    loading: false,
    failed: false,
  }),
}));

vi.mock("../../hooks/useMinWidth", () => ({
  useMinWidth: () => false,
}));

vi.mock("../../hooks/useAgentSessionImport", () => ({
  useAgentSessionImport: () => ({
    importing: false,
    importEveryMachine: vi.fn(async () => ({ imported: 0, providers: {} })),
  }),
  importsInFlight: () => false,
}));

vi.mock("../../hooks/useApprovalDecision", () => ({
  useApprovalDecision: () => ({ busy: {}, decide: vi.fn() }),
}));

vi.mock("../../lib/desktop", () => ({
  isKinDesktop: () => false,
}));

vi.mock("../terminal/TerminalPanel", () => ({
  default: () => null,
}));

function viewport(wide = false) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function listTask(): Task {
  return {
    id: "listed-chat",
    title: "listed-chat",
    cwd: "/work/alpha",
    agent: "kin",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
  } as Task;
}

function artifact(id: string, title: string): Artifact {
  return {
    id,
    title,
    kind: "markdown",
    status: "saved",
    size: 12,
    created_at: 1,
  } as Artifact;
}

/** Start at a cold destination on a real history stack. */
function browser(initial: string) {
  window.history.replaceState({ idx: 0 }, "", initial);
  return render(
    <BrowserRouter>
      <AppShell pendingApprovals={[]}>
        <Jump />
        <Routes>
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/routines" element={<RoutinesPage />} />
          <Route path="/artifacts" element={<ArtifactsPage />} />
          <Route path="/artifacts/:id" element={<ArtifactDetailPage />} />
          <Route path="/new" element={<div>draft page</div>} />
          <Route path="/tasks/:id" element={<div>conversation page</div>} />
        </Routes>
      </AppShell>
    </BrowserRouter>,
  );
}

/** An in-app route change from the screen on display, the way a real link
 *  (or a destination's own entry) makes one. */
let jump: ((to: string) => void) | null = null;

function Jump() {
  const navigate = useNavigate();
  jump = (to: string) => navigate(to);
  return null;
}

describe("the archive is a scope, not a second list entry", () => {
  it("rewrites the list entry instead of pushing a copy", async () => {
    const user = userEvent.setup();
    browser("/sessions");
    await screen.findByRole("heading", { name: "Chats" });

    await user.click(screen.getByRole("link", { name: "Archived" }));
    await waitFor(() => expect(window.location.search).toContain("scope=archived"));
    expect(window.location.pathname).toBe("/sessions");
    // Still the first entry: the phone has one list, and Back has nothing
    // extra to walk through (KIN-CONTINUE-002, step 3).
    expect(window.history.state.idx).toBe(0);
  });
});

async function browserBack(): Promise<void> {
  act(() => window.history.back());
}

beforeEach(() => {
  resetLeaveGuard();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [];
  fixtures.projectArtifacts = [];
  fixtures.artifacts = [];
  jump = null;
  window.history.replaceState({ idx: 0 }, "", "/");
  viewport();
});

describe("the list under a conversation", () => {
  it("replaces a project's Chats tab, so Back reaches the list rather than the project", async () => {
    const user = userEvent.setup();
    browser("/projects/p1");
    await screen.findByRole("heading", { name: "alpha" });

    await user.click(screen.getByRole("tab", { name: "Chats" }));
    await user.click(await screen.findByRole("button", { name: /Project chat/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/project-chat"));

    // The browser's own Back is the honest test of what sits underneath: the
    // list, not the project the conversation was opened from.
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("replaces the routines page when a run opens", async () => {
    const user = userEvent.setup();
    browser("/routines");

    await user.click(await screen.findByRole("link", { name: "Nightly run" }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/run-1"));

    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("puts the list under a draft started from the palette on a destination", async () => {
    const user = userEvent.setup();
    browser("/routines");
    expect((await screen.findAllByRole("heading", { name: "Routines" })).length).toBeGreaterThan(0);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await user.click(await screen.findByRole("button", { name: /New chat/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/new"));

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });
});

describe("a warm list under the project it opened", () => {
  async function openProjectFromList(user: ReturnType<typeof userEvent.setup>) {
    fixtures.tasks = [listTask()];
    browser("/sessions");
    await user.click(await screen.findByRole("button", { name: "alpha" }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    await screen.findByRole("heading", { name: "alpha" });
  }

  it("keeps exactly one list below a conversation opened from the project", async () => {
    const user = userEvent.setup();
    await openProjectFromList(user);

    await user.click(screen.getByRole("tab", { name: "Chats" }));
    await user.click(await screen.findByRole("button", { name: /Project chat/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/project-chat"));

    // The project entry was replaced, not stacked under a second list: the
    // stack is [list, conversation], so one Back reaches the list.
    expect(window.history.state.idx).toBe(1);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("returns the draft to the list once, not to the project", async () => {
    const user = userEvent.setup();
    await openProjectFromList(user);

    await user.click(screen.getByRole("tab", { name: "Chats" }));
    await user.click(await screen.findByRole("link", { name: "New chat" }));
    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    expect(window.history.state.idx).toBe(1);

    // Closing the draft pops the one entry the project used to hold. The list
    // is both the in-app target and the browser's Back target.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });

  it("keeps the project in a Mac's ordinary history", async () => {
    viewport(true);
    const user = userEvent.setup();
    fixtures.tasks = [listTask()];
    browser("/sessions");

    await user.click(await screen.findByRole("button", { name: "alpha" }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    await user.click(screen.getByRole("tab", { name: "Chats" }));
    await user.click(await screen.findByRole("button", { name: /Project chat/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/project-chat"));

    // On the Mac the project is not replaced: Back returns to it.
    expect(window.history.state.idx).toBe(2);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
  });
});

/**
 * The same rule for the screens a project or the artifact library opens: an
 * artifact is a push, and on a phone the list is its only parent. The project
 * (or the library) underneath is replaced, not stacked, so one Back reaches
 * the list (KIN-CONTINUE-002).
 */
describe("artifact pushes under a phone", () => {
  async function openProjectFromList(user: ReturnType<typeof userEvent.setup>) {
    fixtures.tasks = [listTask()];
    browser("/sessions");
    await user.click(await screen.findByRole("button", { name: "alpha" }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    await screen.findByRole("heading", { name: "alpha" });
  }

  it("opens a project's related artifact with the list as its parent", async () => {
    fixtures.projectArtifacts = [artifact("a1", "Release notes")];
    const user = userEvent.setup();
    await openProjectFromList(user);

    await user.click(await screen.findByRole("link", { name: /Release notes/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/artifacts/a1"));

    // [list, artifact]: the project was replaced, not left underneath.
    expect(window.history.state.idx).toBe(1);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });

  it("returns from the artifact to the library without stacking the artifact", async () => {
    fixtures.projectArtifacts = [artifact("a1", "Release notes")];
    const user = userEvent.setup();
    await openProjectFromList(user);
    await user.click(await screen.findByRole("link", { name: /Release notes/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/artifacts/a1"));

    await user.click(screen.getByRole("button", { name: "Back to library" }));
    await waitFor(() => expect(window.location.pathname).toBe("/artifacts"));

    // [list, library], not [list, artifact, library].
    expect(window.history.state.idx).toBe(1);
  });

  it("opens a library row with the list as its parent, from a pointer or the keyboard", async () => {
    fixtures.artifacts = [artifact("a1", "Release notes")];
    browser("/sessions");
    await screen.findByRole("heading", { name: "Chats" });
    expect(jump).toBeTruthy();
    act(() => jump?.("/artifacts"));
    await screen.findByRole("heading", { name: "Artifacts" });
    expect(window.history.state.idx).toBe(1);

    // The row is a button, and Enter is the same push a click makes.
    const row = screen.getByRole("button", { name: /Release notes/ });
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(window.location.pathname).toBe("/artifacts/a1"));
    expect(window.history.state.idx).toBe(1);

    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
  });

  it("asks a dirty project once before its related-artifact link leaves it", async () => {
    fixtures.projectArtifacts = [artifact("a1", "Release notes")];
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await openProjectFromList(user);
      await user.click(screen.getByRole("button", { name: "Edit One-Pager" }));
      await user.type(screen.getByRole("textbox"), "changed");

      const link = screen.getByRole("link", { name: /Release notes/ });
      await user.click(link);
      expect(confirm).toHaveBeenCalledTimes(1);
      // Refused: still the project, with the edit intact.
      expect(window.location.pathname).toBe("/projects/p1");

      confirm.mockReturnValue(true);
      await user.click(link);
      await waitFor(() => expect(window.location.pathname).toBe("/artifacts/a1"));
      // One question, then one push: the project is replaced by the artifact.
      expect(window.history.state.idx).toBe(1);
    } finally {
      confirm.mockRestore();
    }
  });

  it("keeps the project under an artifact in a Mac's ordinary history", async () => {
    viewport(true);
    fixtures.projectArtifacts = [artifact("a1", "Release notes")];
    const user = userEvent.setup();
    await openProjectFromList(user);

    await user.click(await screen.findByRole("link", { name: /Release notes/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/artifacts/a1"));

    expect(window.history.state.idx).toBe(2);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
  });
});
