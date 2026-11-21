// @vitest-environment jsdom
import type { ReactNode } from "react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
import AppShell from "../components/layout/AppShell";
import NotificationTaps from "../components/NotificationTaps";
import SessionsPage from "./SessionsPage";
import TaskDetailPage from "./TaskDetailPage";
import { setLocale } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { useLeaveGuard } from "../hooks/useLeaveGuard";
import { NOTIFICATION_EVENT } from "../lib/notificationRoute";
import { synthesizePhoneParent } from "../lib/phoneDeepLinkParent";
import type { Task } from "../api/client";

/**
 * KIN-CONTINUE-002: a conversation's own departures obey the phone's stack.
 *
 * Saving an artifact, forking a conversation and putting a conversation away
 * are pushes like any other. On a phone the list is the conversation's only
 * parent, so the destination replaces the conversation instead of stacking on
 * top of it — Back is one step, and the dead conversation does not sit between
 * the reader and the list.
 *
 * Real `BrowserRouter` history is the point: `window.history.state.idx` is the
 * only place a push and a replace differ.
 */

const fixtures = vi.hoisted(() => ({
  task: null as Task | null,
  task2: null as Task | null,
  missing: false,
}));

vi.mock("../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: fixtures.task && !fixtures.missing ? [fixtures.task] : [],
    loaded: true,
    error: null,
    pageFull: false,
    loading: false,
  }),
  useTaskResource: (id: string) => ({
    loaded: true,
    error: fixtures.missing ? "gone" : null,
    data: {
      task: fixtures.missing
        ? undefined
        : ((id === "task-2" ? fixtures.task2 : fixtures.task) ?? undefined),
      events: [],
      deleted: false,
    },
  }),
  usePendingResources: () => ({
    data: { approvals: [], questions: [] },
    loaded: true,
    error: null,
  }),
}));

const api = vi.hoisted(() => ({
  forkTask: vi.fn(async () => ({ id: "task-9" })),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const pending = () => new Promise<never>(() => {});
  return {
    ...actual,
    isAuthenticated: () => true,
    listAgents: pending,
    getTaskUsage: pending,
    getTaskLimitWait: pending,
    listQueuedPrompts: pending,
    listWorkerSteps: pending,
    followUpPrompt: pending,
    forkTask: api.forkTask,
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));
vi.mock("../hooks/useAgentRoles", () => ({ useAgentRoles: () => [] }));
vi.mock("../hooks/useMinWidth", () => ({ useMinWidth: () => false }));
vi.mock("../hooks/useApprovalDecision", () => ({
  useApprovalDecision: () => ({ busy: {}, decide: vi.fn() }),
}));
vi.mock("../lib/desktop", () => ({ isKinDesktop: () => false }));
vi.mock("../components/layout/SessionTabs", () => ({ default: () => null }));
vi.mock("../components/terminal/TerminalPanel", () => ({ default: () => null }));
vi.mock("../components/mobile/MobileHeader", () => ({
  default: ({
    title,
    leading,
    trailing,
  }: {
    title?: string;
    leading?: ReactNode;
    trailing?: ReactNode;
  }) => (
    <div>
      {leading}
      {title}
      {trailing}
    </div>
  ),
  MobileHeaderButton: ({
    children,
    label,
    onClick,
  }: {
    children?: ReactNode;
    label?: string;
    onClick?: () => void;
  }) => (
    <button type="button" aria-label={label} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("../components/chat/Composer", () => ({ default: () => null }));
vi.mock("../components/chat/ChatStream", () => ({
  default: ({ findOpen, onFork }: { findOpen?: boolean; onFork?: (fromSeq: number) => void }) => (
    <div>
      {findOpen ? <div role="search" aria-label="Find in conversation" /> : null}
      <button type="button" onClick={() => onFork?.(1)}>
        fork conversation
      </button>
    </div>
  ),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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

function task(): Task {
  return {
    id: "task-1",
    title: "A conversation",
    status: "succeeded",
    agent: "kin",
    cwd: "/work",
    prompt: "do it",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
  } as Task;
}

function task2(): Task {
  return { ...task(), id: "task-2", title: "Another conversation" };
}

function app() {
  return (
    <BrowserRouter>
      <NotificationTaps source={null} />
      <AppShell pendingApprovals={[]}>
        <Jump />
        <Routes>
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
          <Route path="/cached/:id" element={<CachedPanes />} />
          <Route path="/settings" element={<DirtySettings />} />
          <Route path="/inbox" element={<div>inbox page</div>} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}

let jump: ((to: string) => void) | null = null;

function Jump() {
  const navigate = useNavigate();
  jump = (to: string) => navigate(to);
  return null;
}

/** Two panes kept alive at once, the way TaskSessionHost caches sessions. */
function CachedPanes() {
  const { id = "" } = useParams();
  return (
    <div>
      <div data-testid="pane-task-1" hidden={id !== "task-1"}>
        <TaskDetailPage taskId="task-1" active={id === "task-1"} />
      </div>
      <div data-testid="pane-task-2" hidden={id !== "task-2"}>
        <TaskDetailPage taskId="task-2" active={id === "task-2"} />
      </div>
    </div>
  );
}

/** A dirty form behind the real leave guard. */
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

function browser(initial: string, options?: { synthesize?: boolean }) {
  window.history.replaceState({ idx: 0 }, "", initial);
  // A cold launch of a pushed screen gets the parent the app itself
  // synthesizes before the router mounts (`main.tsx` → `phoneDeepLinkParent`).
  if (options?.synthesize) synthesizePhoneParent();
  return render(app());
}

/** A real stack, as a warm list plus the screen it opened. */
function browserAt(entries: string[]) {
  window.history.replaceState({ idx: 0 }, "", entries[0]);
  entries.slice(1).forEach((url, index) => {
    window.history.pushState({ idx: index + 1 }, "", url);
  });
  return render(app());
}

async function browserBack(): Promise<void> {
  act(() => window.history.back());
}

async function openConversation(user: ReturnType<typeof userEvent.setup>) {
  browser("/sessions");
  await user.click(await screen.findByRole("button", { name: /A conversation/ }));
  await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
  expect(window.history.state.idx).toBe(1);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetLeaveGuard();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.task = task();
  fixtures.task2 = task2();
  fixtures.missing = false;
  api.forkTask.mockClear();
  window.history.replaceState({ idx: 0 }, "", "/");
  viewport();
});

describe("a conversation's own pushes on a phone", () => {
  it("replaces the conversation when it is forked", async () => {
    const user = userEvent.setup();
    await openConversation(user);

    await user.click(screen.getByRole("button", { name: "fork conversation" }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-9"));
    expect(api.forkTask).toHaveBeenCalledTimes(1);

    // [list, forked conversation], one Back from the list.
    expect(window.history.state.idx).toBe(1);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
  });

  it("returns a missing conversation's Home control to the list", async () => {
    fixtures.missing = true;
    const user = userEvent.setup();
    // A warm list under a conversation that no longer exists: the Home link
    // is the screen's only way out.
    browserAt(["/sessions", "/tasks/task-1"]);
    const [home] = await screen.findAllByRole("link", { name: /Home/ });
    await user.click(home);

    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });

  it("leaves a missing conversation's Home link to the browser on a modified click", async () => {
    fixtures.missing = true;
    browserAt(["/sessions", "/tasks/task-1"]);
    const [home] = await screen.findAllByRole("link", { name: /Home/ });

    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        [modifier]: true,
      });
      expect(home.dispatchEvent(event)).toBe(true);
      expect(window.location.pathname).toBe("/tasks/task-1");
    }
  });
});

describe("late answers belong to the view that asked", () => {
  it("does not push a fork answer over a clean screen opened later", async () => {
    const user = userEvent.setup();
    const fork = deferred<{ id: string }>();
    api.forkTask.mockImplementationOnce(() => fork.promise);

    const view = browserAt(["/sessions", "/cached/task-1"]);
    const pane = await screen.findByTestId("pane-task-1");
    await user.click(await within(pane).findByRole("button", { name: "fork conversation" }));

    act(() => jump!("/settings"));
    expect(await screen.findByLabelText("settings draft")).toBeTruthy();

    await act(async () => {
      fork.resolve({ id: "task-9" });
      await fork.promise;
    });

    // Nothing on the clean Settings asks a question; only the view identity
    // captured when the fork started can keep the stale answer here.
    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
    view.unmount();
  });

  it("does not push a fork answer over a dirty Settings opened later", async () => {
    const user = userEvent.setup();
    const fork = deferred<{ id: string }>();
    api.forkTask.mockImplementationOnce(() => fork.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    const view = browserAt(["/sessions", "/cached/task-1"]);
    const pane = await screen.findByTestId("pane-task-1");
    await user.click(await within(pane).findByRole("button", { name: "fork conversation" }));
    expect(api.forkTask).toHaveBeenCalledTimes(1);

    act(() => jump!("/settings"));
    const draft = await screen.findByLabelText("settings draft");
    fireEvent.change(draft, { target: { value: "unsaved settings words" } });

    await act(async () => {
      fork.resolve({ id: "task-9" });
      await fork.promise;
    });

    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
    expect((screen.getByLabelText("settings draft") as HTMLInputElement).value).toBe(
      "unsaved settings words",
    );
    expect(confirm).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not navigate when another cached conversation is active", async () => {
    const user = userEvent.setup();
    const fork = deferred<{ id: string }>();
    api.forkTask.mockImplementationOnce(() => fork.promise);

    const view = browserAt(["/sessions", "/cached/task-1"]);
    const first = await screen.findByTestId("pane-task-1");
    await user.click(await within(first).findByRole("button", { name: "fork conversation" }));

    act(() => jump!("/cached/task-2"));
    const second = await screen.findByTestId("pane-task-2");
    expect(second.getAttribute("hidden")).toBeNull();
    expect(within(second).getByRole("button", { name: "fork conversation" })).toBeTruthy();

    await act(async () => {
      fork.resolve({ id: "task-9" });
      await fork.promise;
    });

    await waitFor(() => expect(window.location.pathname).toBe("/cached/task-2"));
    view.unmount();
  });

  it("does not push a fork answer after leaving and reopening the same task", async () => {
    const user = userEvent.setup();
    const fork = deferred<{ id: string }>();
    api.forkTask.mockImplementationOnce(() => fork.promise);

    const view = browserAt(["/sessions", "/tasks/task-1"]);
    await user.click(await screen.findByRole("button", { name: "fork conversation" }));
    expect(api.forkTask).toHaveBeenCalledTimes(1);

    act(() => jump!("/settings"));
    await screen.findByLabelText("settings draft");
    act(() => jump!("/tasks/task-1"));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    const reopenedEntry = window.history.state.idx;

    await act(async () => {
      fork.resolve({ id: "task-9" });
      await fork.promise;
    });

    // Reopening `/tasks/task-1` makes a new history entry, even though the id
    // and pathname are the same. The answer belongs to the old visit.
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    expect(window.history.state.idx).toBe(reopenedEntry);
    view.unmount();
  });

  it("does not push a fork answer after Back returns to the original task entry", async () => {
    const user = userEvent.setup();
    const fork = deferred<{ id: string }>();
    api.forkTask.mockImplementationOnce(() => fork.promise);

    const view = browserAt(["/sessions", "/tasks/task-1"]);
    await user.click(await screen.findByRole("button", { name: "fork conversation" }));

    act(() => jump!("/settings"));
    await screen.findByLabelText("settings draft");
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    expect(window.history.state.idx).toBe(1);

    await act(async () => {
      fork.resolve({ id: "task-9" });
      await fork.promise;
    });

    // Back restores the same history entry and the same `location.key`, but it
    // is a new visit: the answer must not replace this conversation.
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    expect(window.history.state.idx).toBe(1);
    view.unmount();
  });
});

describe("the files panel's one close", () => {
  it("returns the phone's back arrow to the list after the files panel is closed", async () => {
    const user = userEvent.setup();
    browserAt(["/sessions", "/tasks/task-1", "/tasks/task-1?panel=files"]);
    await screen.findByRole("button", { name: "Close files panel" });

    await user.click(screen.getByRole("button", { name: "Close files panel" }));

    // Back on the conversation entry itself, not on a fourth entry the close
    // appended: the old push left `?panel=files` directly beneath the reader.
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.history.state.idx).toBe(1);

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });

  it("does not reopen the panel after a cold files deep link is closed", async () => {
    const user = userEvent.setup();
    // A cold launch: the app synthesized [list, conversation, panel] beneath
    // the address before the router mounted.
    browser("/tasks/task-1?panel=files", { synthesize: true });
    expect(window.history.state.idx).toBe(2);
    await screen.findByRole("button", { name: "Close files panel" });

    await user.click(screen.getByRole("button", { name: "Close files panel" }));

    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.history.state.idx).toBe(1);

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });

  it("pops every panel entry the reader opened, not just one", async () => {
    const user = userEvent.setup();
    browserAt([
      "/sessions",
      "/tasks/task-1",
      "/tasks/task-1?panel=files",
      "/tasks/task-1?panel=files&file=notes.md",
    ]);
    await screen.findByRole("button", { name: "Close files panel" });

    await user.click(screen.getByRole("button", { name: "Close files panel" }));

    // The file list and the file are one place the reader is leaving; one
    // close pops both, back to the conversation entry.
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.history.state.idx).toBe(1);

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });
});

describe("a notification closes the conversation's action sheet", () => {
  it("closes a directly hosted conversation's sheet before routing to Inbox", async () => {
    const user = userEvent.setup();
    const view = browser("/sessions");
    await user.click(await screen.findByRole("button", { name: /A conversation/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    await user.click(await screen.findByRole("button", { name: "Session actions" }));
    expect(await screen.findByRole("dialog", { name: "Session actions" })).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent(NOTIFICATION_EVENT, { detail: { url: "/inbox" } }));
    });

    await waitFor(() => expect(window.location.pathname).toBe("/inbox"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Session actions" })).toBeNull(),
    );
    expect(window.history.state.idx).toBe(1);
    view.unmount();
  });

  it("closes a cached pane's sheet before routing to Inbox", async () => {
    const user = userEvent.setup();
    const view = browser("/sessions");
    act(() => jump!("/cached/task-1"));
    const pane = await screen.findByTestId("pane-task-1");
    await user.click(await within(pane).findByRole("button", { name: "Session actions" }));
    expect(await screen.findByRole("dialog", { name: "Session actions" })).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent(NOTIFICATION_EVENT, { detail: { url: "/inbox" } }));
    });

    await waitFor(() => expect(window.location.pathname).toBe("/inbox"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Session actions" })).toBeNull(),
    );
    expect(window.history.state.idx).toBe(1);
    view.unmount();
  });
});

describe("the conversation action sheet opens its nested surfaces", () => {
  it("opens Find after the action sheet has released its history entry", async () => {
    const user = userEvent.setup();
    const view = browser("/sessions");
    await user.click(await screen.findByRole("button", { name: /A conversation/ }));
    await user.click(await screen.findByRole("button", { name: "Session actions" }));
    const actions = await screen.findByRole("dialog", { name: "Session actions" });

    await user.click(within(actions).getByRole("button", { name: "Find" }));
    expect(await screen.findByRole("search", { name: "Find in conversation" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Session actions" })).toBeNull();
    expect(window.history.state.idx).toBe(1);
    view.unmount();
  });

  it("opens Share after the action sheet has released its history entry", async () => {
    const user = userEvent.setup();
    const view = browser("/sessions");
    await user.click(await screen.findByRole("button", { name: /A conversation/ }));
    await user.click(await screen.findByRole("button", { name: "Session actions" }));
    const actions = await screen.findByRole("dialog", { name: "Session actions" });

    await user.click(within(actions).getByRole("button", { name: "Share" }));
    expect(await screen.findByRole("dialog", { name: "Share this conversation" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Session actions" })).toBeNull();
    expect(window.history.state.idx).toBe(1);
    view.unmount();
  });
});
