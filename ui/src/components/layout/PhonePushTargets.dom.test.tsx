// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import AppShell from "./AppShell";
import SessionsPage from "../../pages/SessionsPage";
import SessionsRoute from "../../pages/SessionsRoute";
import NewChatPage from "../../pages/NewChatPage";
import AgentsPage from "../../pages/AgentsPage";
import { AgentSessionEntryRedirect } from "../../App";
import { setLocale } from "../../i18n";
import { resetLeaveGuard } from "../../lib/leaveGuard";
import { useLeaveGuard } from "../../hooks/useLeaveGuard";
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
  // The shell's own width (AppShell's `useMinWidth`): which list is drawn.
  wide: false,
  // What `matchMedia` answers: what `phonePush`/`isPhoneLayout` read. Split
  // from `wide` so the one test that widens mid-attach can flip the history
  // decision without swapping the whole route tree (and with it the sheet
  // instance whose attach is still out).
  mediaWide: false,
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
    listAgentSessionsPage: vi.fn(async () => ({
      items: fixtures.sessions,
      next_cursor: undefined,
    })),
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
        model_list_source: "none",
        model_list_status: "available",
        permission_modes: ["default"],
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
      { id: "mac-1", label: "Test node", isSelf: true, online: true, roots: ["/work"], agents: [] },
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

function viewport(mediaWide = fixtures.mediaWide) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? mediaWide : false,
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
      <Jump />
      <AppShell pendingApprovals={[]}>
        <Routes>
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/new" element={<NewChatPage />} />
          <Route path="/agents" element={<Navigate to="/settings?tab=operations" replace />} />
          <Route path="/agent-sessions/:id" element={<AgentSessionEntryRedirect />} />
          <Route path="/settings" element={<SettingsAtTab />} />
          <Route path="/tasks/:id" element={<div>conversation page</div>} />
        </Routes>
      </AppShell>
    </BrowserRouter>,
  );
}

/** A warm stack: the list plus the imported session pushed above it. */
function browserAt(entries: string[]) {
  window.history.replaceState({ idx: 0 }, "", entries[0]);
  entries.slice(1).forEach((url, index) => {
    window.history.pushState({ idx: index + 1 }, "", url);
  });
  return render(
    <BrowserRouter>
      <Jump />
      <AppShell pendingApprovals={[]}>
        <Routes>
          {/* The real `/sessions` route: at a Mac width the sidebar is the
              list and the main area is the draft. Rendering `SessionsPage`
              here would mount a second list — and a second sheet — beside the
              sidebar's, which the product never does. */}
          <Route path="/sessions" element={<SessionsRoute />} />
          <Route path="/new" element={<NewChatPage />} />
          <Route path="/agents" element={<Navigate to="/settings?tab=operations" replace />} />
          <Route path="/agent-sessions/:id" element={<AgentSessionEntryRedirect />} />
          <Route path="/settings" element={<SettingsAtTab />} />
          <Route path="/tasks/:id" element={<div>conversation page</div>} />
        </Routes>
      </AppShell>
    </BrowserRouter>,
  );
}

let jump: ((to: string) => void) | null = null;

function Jump() {
  const navigate = useNavigate();
  jump = (to: string) => navigate(to);
  return null;
}

function DirtySettings() {
  const [text, setText] = useState("");
  useLeaveGuard(
    () => (typeof window.confirm === "function" ? window.confirm("Discard settings draft?") : true),
    text.trim() !== "",
  );
  return (
    <input
      aria-label="settings draft"
      value={text}
      onChange={(event) => setText(event.target.value)}
    />
  );
}

/**
 * E4a: Agent Ops is the operations tab of Settings. The harness serves the
 * destination the way App.tsx does — `/agents` redirects, and the tab decides
 * which body renders.
 */
function SettingsAtTab() {
  const [params] = useSearchParams();
  return params.get("tab") === "operations" ? <AgentsPage /> : <DirtySettings />;
}

/** Whether the current entry is the operations tab, wherever the step began. */
function onOperationsTab(): boolean {
  return (
    window.location.pathname === "/settings" &&
    new URLSearchParams(window.location.search).get("tab") === "operations"
  );
}

async function browserBack(): Promise<void> {
  act(() => window.history.back());
}

async function openDraftFromTheList(user: ReturnType<typeof userEvent.setup>) {
  browser("/sessions");
  // `level: 1` is the page's own title. On a Mac the shell also mounts the
  // conversation column, whose header names the same area — jsdom applies no
  // `md:hidden`, so the phone bar's heading is still in the tree beside it.
  await screen.findByRole("heading", { name: "Chats", level: 1 });
  await user.click(document.querySelector("[data-phone-return='new']") as HTMLElement);
  await waitFor(() => expect(window.location.pathname).toBe("/new"));
}

beforeEach(() => {
  cleanup();
  resetLeaveGuard();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  api.attach.mockClear();
  fixtures.wide = false;
  fixtures.mediaWide = false;
  fixtures.sessions = [];
  fixtures.tasks = [];
  localStorage.setItem("kin_draft_cwd", "/work");
  window.history.replaceState({ idx: 0 }, "", "/");
  jump = null;
  viewport();
});

describe("Agent Ops is a destination, so the draft it opens replaces it", () => {
  it("puts the list under the prefilled draft, not Agent Ops", async () => {
    const user = userEvent.setup();
    browser("/sessions");
    await screen.findByRole("heading", { name: "Chats" });

    await user.click(screen.getByRole("link", { name: "Agent Ops" }));
    await waitFor(() => expect(onOperationsTab()).toBe(true));
    expect(window.history.state.idx).toBe(0);

    const actionsButton = (
      await screen.findAllByRole("button", {
        name: /^Actions — Claude Code$/,
      })
    ).find((button) => button.getAttribute("aria-haspopup") === "dialog");
    expect(actionsButton).toBeTruthy();
    await user.click(actionsButton!);
    const sheet = await screen.findByRole("dialog", { name: "Claude Code" });
    // The shared row's name is its label plus the visible consequence line
    // (the desktop menu already worked this way); match on the label prefix.
    await user.click(within(sheet).getByRole("button", { name: /^Ask default Agent to install/ }));

    // [list, draft], not [list, agents, draft].
    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    // The prefill is consumed: it is in the draft now, not left in the URL to
    // overwrite later edits on reload.
    await waitFor(() => expect(window.location.search).not.toContain("q="));
    expect(screen.getByTestId("composer-value").textContent).toContain(
      "Please install Claude Code",
    );
    expect(window.history.state.idx).toBe(1);

    // Closing the draft is the same one step.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);

    // Reopening the draft brings the same words back from the saved draft.
    await user.click(document.querySelector("[data-phone-return='new']") as HTMLElement);
    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    expect(screen.getByTestId("composer-value").textContent).toContain(
      "Please install Claude Code",
    );
  });

  it("keeps the draft's words when Agent Ops opens from it, then Chats returns", async () => {
    localStorage.setItem("kin_draft_prompt", "unsent words");
    const user = userEvent.setup();
    await openDraftFromTheList(user);
    expect(screen.getByTestId("composer-value").textContent).toBe("unsent words");

    await user.click(screen.getByRole("button", { name: "Manage agents →" }));
    await waitFor(() => expect(onOperationsTab()).toBe(true));

    // Agent Ops is a peer of the list, not a detail over the draft.
    expect(window.history.state.idx).toBe(1);
    await user.click(screen.getByRole("link", { name: "Chats" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

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
    await waitFor(() => expect(onOperationsTab()).toBe(true));

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
  it("opens in the list's sheet, and continuing becomes the conversation above the list", async () => {
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
    // reader reaches one. The field itself is behind the magnifier now
    // (KIN-CONTINUE-004).
    await user.click(screen.getByRole("button", { name: "Search chats" }));
    await user.type(screen.getByRole("searchbox"), "Yesterday");
    await user.click(await screen.findByRole("button", { name: /Yesterday session/ }));

    // The row opens the sheet over the list: no route was pushed, so the
    // reader never left the list they were reading.
    await screen.findByRole("dialog", { name: /Yesterday session/ });
    expect(window.location.pathname).toBe("/sessions");
    expect(window.history.state.idx).toBe(0);

    await user.click(await screen.findByTestId("composer-send"));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    expect(api.attach).toHaveBeenCalledWith("s1", { prompt: "keep going" });

    // [list, conversation]: the sheet's entry is given back before the task
    // is pushed, so one Back reaches the list.
    expect(window.history.state.idx).toBe(1);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });

  it("pushes the conversation on the Mac, so Back returns to the list with the sheet open", async () => {
    fixtures.wide = true;
    fixtures.mediaWide = true;
    viewport(true);
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
    browserAt(["/sessions", "/agent-sessions/s1"]);
    // The old page URL replaces itself with the list narrowed by `?agent=`,
    // and the list opens that session's sheet over it.
    const sheet = await screen.findByRole("dialog", { name: /Yesterday session/ });
    expect(window.location.pathname).toBe("/sessions");
    expect(window.location.search).toBe("?agent=s1");
    expect(window.history.state.idx).toBe(1);

    await user.click(within(sheet).getByTestId("composer-send"));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));

    // The Mac keeps ordinary nested history: the list with the sheet is still
    // one Back away, not replaced by the conversation.
    expect(window.history.state.idx).toBe(2);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.location.search).toBe("?agent=s1");
    await screen.findByRole("dialog", { name: /Yesterday session/ });
    expect(window.history.state.idx).toBe(1);
  });

  it("does not pull the reader out of a dirty Settings when the attach answers", async () => {
    const attach = deferred<{ task: { id: string } }>();
    api.attach.mockImplementationOnce(() => attach.promise);
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
    browserAt(["/sessions", "/agent-sessions/s1"]);
    const sheet = await screen.findByRole("dialog", { name: /Yesterday session/ });
    await user.click(within(sheet).getByTestId("composer-send"));
    expect(api.attach).toHaveBeenCalledWith("s1", { prompt: "keep going" });

    // The reader starts editing another screen while the attach is out.
    act(() => jump!("/settings"));
    const draft = await screen.findByLabelText("settings draft");
    fireEvent.change(draft, { target: { value: "settings words" } });

    await act(async () => {
      attach.resolve({ task: { id: "task-1" } });
      await attach.promise;
    });

    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
    expect((screen.getByLabelText("settings draft") as HTMLInputElement).value).toBe(
      "settings words",
    );
    expect(window.history.state.idx).toBe(2);
  });

  it("keeps the Mac's ordinary push when the window widens while the attach runs", async () => {
    const attach = deferred<{ task: { id: string } }>();
    api.attach.mockImplementationOnce(() => attach.promise);
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
    browserAt(["/sessions", "/agent-sessions/s1"]);
    const sheet = await screen.findByRole("dialog", { name: /Yesterday session/ });
    await user.click(within(sheet).getByTestId("composer-send"));

    // Started as a phone, answered as a Mac. `phonePush` reads the media
    // query, not the shell's width, so flipping it is what makes the landing
    // surface decide the history shape here; a Mac keeps the list and its
    // sheet underneath.
    fixtures.mediaWide = true;
    viewport(true);
    await act(async () => {
      attach.resolve({ task: { id: "task-1" } });
      await attach.promise;
    });

    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    expect(window.history.state.idx).toBe(2);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.location.search).toBe("?agent=s1");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
