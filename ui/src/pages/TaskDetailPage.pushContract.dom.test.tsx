// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import AppShell from "../components/layout/AppShell";
import SessionsPage from "./SessionsPage";
import TaskDetailPage from "./TaskDetailPage";
import { setLocale } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
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
  useTaskResource: () => ({
    loaded: true,
    error: fixtures.missing ? "gone" : null,
    data: {
      task: fixtures.missing ? undefined : (fixtures.task ?? undefined),
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
  createArtifact: vi.fn(async () => ({ id: "art-9", title: "Saved" })),
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
    createArtifact: api.createArtifact,
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
  default: ({ title }: { title?: string }) => <div>{title}</div>,
  MobileHeaderButton: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("../components/chat/Composer", () => ({ default: () => null }));
vi.mock("../components/chat/ChatStream", () => ({
  default: ({
    onSaveArtifact,
    onFork,
  }: {
    onSaveArtifact?: (text: string) => void;
    onFork?: (fromSeq: number) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onSaveArtifact?.("the reply")}>
        save artifact
      </button>
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

function app() {
  return (
    <BrowserRouter>
      <AppShell pendingApprovals={[]}>
        <Routes>
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
          <Route path="/artifacts/:id" element={<div>artifact page</div>} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}

function browser(initial: string) {
  window.history.replaceState({ idx: 0 }, "", initial);
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

beforeEach(() => {
  resetLeaveGuard();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.task = task();
  fixtures.missing = false;
  api.createArtifact.mockClear();
  api.forkTask.mockClear();
  window.history.replaceState({ idx: 0 }, "", "/");
  viewport();
});

describe("a conversation's own pushes on a phone", () => {
  it("replaces the conversation when an artifact is saved from it", async () => {
    const user = userEvent.setup();
    await openConversation(user);

    await user.click(screen.getByRole("button", { name: "save artifact" }));
    await waitFor(() => expect(window.location.pathname).toBe("/artifacts/art-9"));
    expect(api.createArtifact).toHaveBeenCalledTimes(1);

    // [list, artifact]: the conversation is not left under the delivery.
    expect(window.history.state.idx).toBe(1);
    await browserBack();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });

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
});
