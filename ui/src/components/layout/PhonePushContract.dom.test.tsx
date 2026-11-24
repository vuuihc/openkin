// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import AppShell from "./AppShell";
import SessionsPage from "../../pages/SessionsPage";
import RoutinesPage from "../../pages/RoutinesPage";
import { setLocale } from "../../i18n";
import { resetLeaveGuard } from "../../lib/leaveGuard";
import { synthesizePhoneParent } from "../../lib/phoneDeepLinkParent";
import { phonePush } from "../../lib/phoneNavigation";
import type { Task } from "../../api/client";

/**
 * The list is the parent of a conversation on a phone, whichever surface the
 * conversation was opened from. The command palette and the routines page sit
 * on destinations of their own; opening a conversation (or the draft) from one
 * must replace that destination with the list instead of leaving it
 * underneath, or Back lands on the routines page instead of the list. A
 * project has no page of its own since KIN-CONTRACT-001: its name narrows this
 * same entry.
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

describe("a project name on the list", () => {
  it("narrows the one list instead of pushing a page, so Back never lands on a project", async () => {
    const user = userEvent.setup();
    fixtures.tasks = [listTask()];
    browser("/sessions");
    await screen.findByRole("heading", { name: "Chats" });

    // KIN-CONTRACT-001 retired the project cover. The heading is on the list
    // itself: it either narrows this entry by `?project=` or, with no local
    // record to name, folds the bucket. Neither pushes a project page, so the
    // stack is still the list at index 0 and Back has no project to land on.
    await user.click(await screen.findByRole("button", { name: "alpha" }));
    expect(window.location.pathname).toBe("/sessions");
    expect(window.history.state.idx).toBe(0);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
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
