// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import AppShell from "./AppShell";
import SessionsPage from "../../pages/SessionsPage";
import NewChatPage from "../../pages/NewChatPage";
import AgentsPage from "../../pages/AgentsPage";
import AgentSessionDetailPage from "../../pages/AgentSessionDetailPage";
import { setLocale } from "../../i18n";
import { resetLeaveGuard } from "../../lib/leaveGuard";
import type { AgentSession, Task } from "../../api/client";

/**
 * KIN-CONTINUE-002: every phone push has the list as its only parent.
 *
 * These are page-internal departures, not the list's own rows: Agent Ops
 * opening the prefilled draft, the draft opening Agent Ops, an imported
 * session continuing into a conversation. Each used a bare `navigate`/`<Link>`,
 * which left the screen it started from underneath: Back went to Agent Ops or
 * to the draft instead of the list, and the stack grew a level per stop.
 *
 * Real `BrowserRouter` and the browser's own history are the only way to see
 * the defect: a MemoryRouter keeps the whole stack out of `window.history`, so
 * a test there cannot tell a replace from a push.
 */

const fixtures = vi.hoisted(() => ({
  wide: false,
  sessions: [] as AgentSession[],
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

const api = vi.hoisted(() => ({
  attach: vi.fn(async () => ({ task: { id: "task-1" } })),
  createTask: vi.fn(async () => ({
    id: "task-2",
    title: "keep going",
    status: "queued",
    agent: "kin",
    cwd: "/work",
    prompt: "keep going",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
  })),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  const pending = () => new Promise<never>(() => {});
  return {
    ...actual,
    isAuthenticated: vi.fn(() => true),
    listAgentSessionsPage: vi.fn(async () => ({ items: fixtures.sessions, next_cursor: undefined })),
    listAgentSessions: vi.fn(async () => fixtures.sessions),
    listProjects: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    listRoutines: vi.fn(async () => ({ routines: [], has_more: false })),
    listRoutineRuns: vi.fn(async () => []),
    getUsageSummary: vi.fn(async () => []),
    getUsageLimits: vi.fn(async () => []),
    listAgents: vi.fn(async () => [
      {
        id: "claude-code",
        name: "Claude Code",
        installed: false,
        available: false,
        default: false,
        models: [],
      },
    ]),
    listAgentManagement: vi.fn(async () => [
      {
        id: "claude-code",
        install_cmd: "npm i -g @anthropic-ai/claude-code",
        update_cmd: "",
      },
    ]),
    getAgentSession: vi.fn(async () => ({
      id: "s1",
      agent_id: "claude-code",
      external_ref: "ref-1",
      title: "Yesterday session",
      cwd: "/work",
      status: "idle",
      first_seen_at: 1,
      last_seen_at: 2,
      updated_at: 2,
      linked: false,
      capabilities: ["session_attach"],
    })),
    getAgentSessionHistory: vi.fn(async () => ({ items: [], prev_cursor: "" })),
    attachAgentSession: api.attach,
    getSettings: vi.fn(async () => null),
    createTask: api.createTask,
    recentCwds: pending,
    getRoutingOptions: pending,
    findProjectByRoot: pending,
    serverVersion: vi.fn().mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" }),
    listMachines: vi.fn(async () => []),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: ["/work"], agents: [] },
    ],
    agents: [
      {
        id: "kin",
        name: "Kin",
        installed: true,
        available: true,
        default: true,
        models: [],
      },
      {
        id: "claude-code",
        name: "Claude Code",
        installed: false,
        available: false,
        default: false,
        models: [],
      },
    ],
    loading: false,
    failed: false,
    refresh: () => {},
  }),
}));

vi.mock("../../hooks/useMinWidth", () => ({
  useMinWidth: () => fixtures.wide,
}));

vi.mock("../../hooks/useAgentRoles", () => ({ useAgentRoles: () => [] }));

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

vi.mock("../chat/ChatStream", () => ({
  default: () => <div data-testid="chat" />,
}));

vi.mock("../chat/Composer", () => ({
  default: ({
    initialValue,
    onSubmit,
    busy,
  }: {
    initialValue?: string;
    onSubmit: (text: string) => Promise<void> | void;
    busy?: boolean;
  }) => (
    <div>
      <span data-testid="composer-value">{initialValue}</span>
      <button
        type="button"
        data-testid="composer-send"
        disabled={busy}
        onClick={() => {
          void Promise.resolve(onSubmit("keep going")).catch(() => {});
        }}
      >
        continue
      </button>
    </div>
  ),
}));

function viewport(wide = fixtures.wide) {
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

/** Start at a cold destination on a real history stack. */
function browser(initial: string) {
  window.history.replaceState({ idx: 0 }, "", initial);
  return render(
    <BrowserRouter>
      <AppShell pendingApprovals={[]}>
        <Routes>
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/new" element={<NewChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agent-sessions/:id" element={<AgentSessionDetailPage />} />
          <Route path="/tasks/:id" element={<div>conversation page</div>} />
        </Routes>
      </AppShell>
    </BrowserRouter>,
  );
}

async function browserBack(): Promise<void> {
  act(() => window.history.back());
}

async function openDraftFromTheList(user: ReturnType<typeof userEvent.setup>) {
  browser("/sessions");
  await screen.findByRole("heading", { name: "Chats" });
  await user.click(document.querySelector("[data-phone-return='new']") as HTMLElement);
  await waitFor(() => expect(window.location.pathname).toBe("/new"));
}

beforeEach(() => {
  resetLeaveGuard();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  api.attach.mockClear();
  fixtures.wide = false;
  fixtures.sessions = [];
  fixtures.tasks = [];
  localStorage.setItem("kin_draft_cwd", "/work");
  window.history.replaceState({ idx: 0 }, "", "/");
  viewport();
});

describe("Agent Ops is a destination, so the draft it opens replaces it", () => {
  it("puts the list under the prefilled draft, not Agent Ops", async () => {
    const user = userEvent.setup();
    browser("/sessions");
    await screen.findByRole("heading", { name: "Chats" });

    await user.click(screen.getByRole("link", { name: "Agent Ops" }));
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
    expect(window.history.state.idx).toBe(1);

    await user.click(await screen.findByRole("button", { name: /^Actions — Claude Code$/ }));
    const sheet = await screen.findByRole("dialog", { name: "Claude Code" });
    await user.click(within(sheet).getByRole("button", { name: "Ask default Agent to install" }));

    // [list, draft], not [list, agents, draft].
    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    expect(window.location.search).toContain("q=");
    expect(window.history.state.idx).toBe(1);

    // Closing the draft is the same one step.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });

  it("keeps the draft's words when Agent Ops opens from it, and Back reaches the list", async () => {
    localStorage.setItem("kin_draft_prompt", "unsent words");
    const user = userEvent.setup();
    await openDraftFromTheList(user);
    expect(screen.getByTestId("composer-value").textContent).toBe("unsent words");

    await user.click(screen.getByRole("button", { name: "Manage agents →" }));
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));

    // The draft's entry was replaced, so the stack is [list, agents].
    expect(window.history.state.idx).toBe(1);
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);

    // The words were never in the replaced entry: they are still recoverable
    // by opening the draft again.
    await user.click(document.querySelector("[data-phone-return='new']") as HTMLElement);
    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    expect(screen.getByTestId("composer-value").textContent).toBe("unsent words");
  });

  it("keeps the draft under Agent Ops on a Mac", async () => {
    fixtures.wide = true;
    viewport(true);
    const user = userEvent.setup();
    await openDraftFromTheList(user);

    await user.click(screen.getByRole("button", { name: "Manage agents →" }));
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));

    // The Mac keeps ordinary nested history: the draft is still one Back away.
    expect(window.history.state.idx).toBe(2);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/new"));
  });
});

describe("starting the conversation from the draft", () => {
  it("replaces the draft with the conversation, keeping the list as its parent", async () => {
    const user = userEvent.setup();
    await openDraftFromTheList(user);

    await user.click(screen.getByTestId("composer-send"));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-2"));
    expect(api.createTask).toHaveBeenCalledTimes(1);

    // [list, conversation]: the draft was the parent's placeholder, and the
    // conversation takes its entry rather than stacking above it.
    expect(window.history.state.idx).toBe(1);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });
});

describe("continuing an imported session", () => {
  it("becomes the conversation in the session's own entry, so Back reaches the list", async () => {
    fixtures.sessions = [
      {
        id: "s1",
        agent_id: "claude-code",
        external_ref: "ref-1",
        title: "Yesterday session",
        cwd: "/work",
        status: "idle",
        first_seen_at: 1,
        last_seen_at: 2,
        updated_at: 2,
        linked: false,
        capabilities: ["session_attach"],
      } as AgentSession,
    ];
    const user = userEvent.setup();
    browser("/sessions");
    await screen.findByRole("heading", { name: "Chats" });

    // Imported sessions live in a folded shelf; searching opens it, the way a
    // reader reaches one.
    await user.type(screen.getByRole("searchbox"), "Yesterday");
    await user.click(await screen.findByRole("button", { name: /Yesterday session/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/agent-sessions/s1"));
    expect(window.history.state.idx).toBe(1);

    await user.click(await screen.findByTestId("composer-send"));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    expect(api.attach).toHaveBeenCalledWith("s1", { prompt: "keep going" });

    // [list, conversation]: the session screen was replaced by the task it
    // continued into, not left underneath it.
    expect(window.history.state.idx).toBe(1);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });
});