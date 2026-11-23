// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import AppShell from "./AppShell";
import SessionsPage from "../../pages/SessionsPage";
import ProjectDetailPage from "../../pages/ProjectDetailPage";
import RoutinesPage from "../../pages/RoutinesPage";
import { setLocale } from "../../i18n";
import { resetLeaveGuard } from "../../lib/leaveGuard";
import { synthesizePhoneParent } from "../../lib/phoneDeepLinkParent";
import { phonePush } from "../../lib/phoneNavigation";
import type { Task } from "../../api/client";

/**
 * The list is the parent of a conversation on a phone, whichever surface the
 * conversation was opened from. A project's Chats tab and the command palette
 * sit on destinations of their own; opening a conversation (or the draft) from
 * one must replace that destination with the list instead of leaving it
 * underneath, or Back lands on the project or the routines page instead of the
 * list.
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
    getProjectPulse: vi.fn(async () => null),
    listRoutines: vi.fn(async () => ({ routines: [], has_more: false })),
    listRoutineRuns: vi.fn(async () => ({
      routines: [],
      runs: [
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
      ],
      has_more: false,
    })),
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
      {
        id: "mac-1",
        label: "MacBook",
        isSelf: true,
        online: true,
        roots: ["/work"],
        agents: [{ id: "kin", name: "Kin", available: true }],
      },
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

/** A conversation's destination action uses the same shared root contract. */
function ConversationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <div>conversation page</div>
      <button type="button" onClick={() => phonePush(navigate, location, "/routines")}>
        Open routines
      </button>
    </>
  );
}

/** Start at a cold destination on a real history stack. */
function browser(initial: string, options?: { synthesize?: boolean }) {
  window.history.replaceState({ idx: 0 }, "", initial);
  if (options?.synthesize) synthesizePhoneParent();
  return render(
    <BrowserRouter>
      <AppShell pendingApprovals={[]}>
        <Routes>
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/routines" element={<RoutinesPage />} />
          <Route path="/agents" element={<div>agent operations</div>} />
          <Route path="/new" element={<div>draft page</div>} />
          <Route path="/tasks/:id" element={<ConversationPage />} />
        </Routes>
      </AppShell>
    </BrowserRouter>,
  );
}

describe("the archive is a scope, not a second list entry", () => {
  it("rewrites the list entry instead of pushing a copy", async () => {
    const user = userEvent.setup();
    browser("/sessions");
    await screen.findByRole("heading", { name: "Chats" });

    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(screen.getByRole("button", { name: "Archived" }));
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
  cleanup();
  resetLeaveGuard();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [];
  window.history.replaceState({ idx: 0 }, "", "/");
  viewport();
});

describe("the four roots on real history", () => {
  it("returns to the one real list beneath a peer root", async () => {
    const user = userEvent.setup();
    fixtures.tasks = [listTask()];
    browser("/sessions");
    await user.click(await screen.findByRole("button", { name: /listed-chat/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/listed-chat"));
    expect(window.history.state.idx).toBe(1);

    // Routines replaces the conversation at depth 1; the list is still its
    // proven parent at depth 0. The Chats tab must pop rather than replace the
    // root with a second list at depth 1. The tab bar is the only way between
    // areas on a phone; a sideways drag no longer switches.
    await user.click(screen.getByRole("button", { name: "Open routines" }));
    await waitFor(() => expect(window.location.pathname).toBe("/routines"));
    expect(window.history.state.idx).toBe(1);
    await user.click(screen.getByRole("link", { name: "Chats" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
    await screen.findByRole("heading", { name: "Chats" });
  });

  it("replaces a peer root and carries the remembered archive scope back", async () => {
    const user = userEvent.setup();
    browser("/sessions?search=alpha&scope=archived");
    await user.click(await screen.findByRole("link", { name: "Routines" }));
    await waitFor(() => expect(window.location.pathname).toBe("/routines"));
    expect(window.history.state.idx).toBe(0);
    expect(screen.getByRole("link", { name: "Routines" }).getAttribute("aria-current")).toBe(
      "page",
    );

    await user.click(screen.getByRole("link", { name: "Chats" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.location.search).toContain("search=alpha");
    expect(window.location.search).toContain("scope=archived");
    expect(window.history.state.idx).toBe(0);
  });
});

describe("the list under a conversation", () => {
  it("replaces a project's Chats tab, so Back reaches the list rather than the project", async () => {
    const user = userEvent.setup();
    browser("/projects/p1");
    await screen.findByRole("heading", { name: "alpha" });

    await user.click(await screen.findByRole("button", { name: /Project chat/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/project-chat"));

    // The browser's own Back is the honest test of what sits underneath: the
    // list, not the project the conversation was opened from.
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

    await user.click(await screen.findByRole("link", { name: "New chat" }));
    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    expect(window.history.state.idx).toBe(1);

    // Closing the draft pops the one entry the project used to hold. The list
    // is both the in-app target and the browser's Back target.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });

  it("treats project routines as a peer root, after the summary's guard", async () => {
    const user = userEvent.setup();
    window.history.replaceState({ idx: 0 }, "", "/sessions");
    render(
      <BrowserRouter>
        <AppShell pendingApprovals={[]}>
          <Routes>
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
            <Route path="/routines" element={<div>routines root</div>} />
            <Route path="/agents" element={<div>agents root</div>} />
            <Route path="/settings" element={<div>settings root</div>} />
          </Routes>
        </AppShell>
      </BrowserRouter>,
    );
    await user.click(await screen.findByRole("button", { name: "alpha" }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    await screen.findByRole("heading", { name: "alpha" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.type(screen.getByRole("textbox", { name: "One-line summary" }), "Unsaved");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await user.click(screen.getByRole("link", { name: /Go to routines/ }));
      await waitFor(() => expect(confirm).toHaveBeenCalled());
      expect(window.location.pathname).toBe("/projects/p1");
      confirm.mockReturnValue(true);
      await user.click(screen.getByRole("link", { name: /Go to routines/ }));
      await waitFor(() => expect(window.location.pathname).toBe("/routines"));
      expect(window.history.state.idx).toBe(1);
      await user.click(screen.getByRole("link", { name: "Chats" }));
      await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
      // Routines replaced the project detail, while the original list remains
      // beneath it. Chats must pop to that real parent, not replace it with a
      // second list entry. A cold root with a non-list parent is covered in
      // phoneNavigation.test.tsx: a positive idx alone is not parent evidence.
      expect(window.history.state.idx).toBe(0);
      expect(screen.queryByRole("heading", { name: "routines root" })).toBeNull();
      // The direct list → detail Back return is covered below and by
      // `goBackToList`; this root switch was the behavior under test here.
    } finally {
      confirm.mockRestore();
    }
  });

  it("asks before the browser Back discards a project summary draft", async () => {
    const user = userEvent.setup();
    await openProjectFromList(user);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const summary = screen.getByRole("textbox", { name: "One-line summary" });
    await user.type(summary, "Unsaved");
    await waitFor(() => expect(window.history.state?.kinLeaveGuard).toEqual(expect.any(String)));

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await browserBack();
      await waitFor(() =>
        expect(confirm).toHaveBeenCalledWith("Your summary is unsaved. Leave anyway?"),
      );
      expect(window.location.pathname).toBe("/projects/p1");
      expect(
        (screen.getByRole("textbox", { name: "One-line summary" }) as HTMLTextAreaElement).value,
      ).toBe("Unsaved");
    } finally {
      confirm.mockRestore();
    }
  });

  it("keeps the project in a Mac's ordinary history", async () => {
    viewport(true);
    const user = userEvent.setup();
    fixtures.tasks = [listTask()];
    browser("/sessions");

    await user.click(await screen.findByRole("button", { name: "alpha" }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    await user.click(await screen.findByRole("button", { name: /Project chat/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/project-chat"));

    // On the Mac the project is not replaced: Back returns to it.
    expect(window.history.state.idx).toBe(2);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
  });
});

describe("a cold files deep link", () => {
  it("Back from the file list reaches the conversation, not the session list", async () => {
    fixtures.tasks = [listTask()];
    // The reader opened the file list from a conversation on a cold launch:
    // the address names only the list, so the conversation and the list parent
    // have to be synthesized beneath it before the router mounts.
    browser("/tasks/listed-chat?panel=files", { synthesize: true });
    expect(window.history.state.idx).toBe(2);
    expect(screen.getByText("conversation page")).toBeTruthy();

    // The first Back is the file list's parent: the conversation the file came
    // from, still a real route (the same URL with no panel and no file). The
    // query is what moved — the pathname alone is the same at both depths.
    await browserBack();
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.pathname).toBe("/tasks/listed-chat");
    expect(window.history.state.idx).toBe(1);
    expect(screen.getByText("conversation page")).toBeTruthy();

    // Only then the list. The old single-parent synthesis made the first Back
    // land here, skipping the conversation entirely.
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
    expect(await screen.findByRole("heading", { name: "Chats" })).toBeTruthy();
  });
});
