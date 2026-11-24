// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type {
  AgentSession,
  AgentSessionBinding,
  Task,
} from "../../api/client";

/**
 * KIN-CONTRACT-001: `/agent-sessions/:id` retires into the list.
 *
 * A notification, bookmark or cross-device link that names an imported session
 * used to replace the whole screen with the session's own page. The list is
 * where the product shows that session, so the URL now lands on
 * `/sessions?agent=<id>`: the list stays mounted, the session's sheet opens
 * over it, and closing gives the list back with the parameter gone.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  sessions: [] as AgentSession[],
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
    isAuthenticated: () => true,
    listAgentSessionsPage: vi.fn(async () => ({
      items: fixtures.sessions,
      next_cursor: undefined,
    })),
    listProjects: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    getAgentSession: vi.fn(),
    getAgentSessionHistory: vi.fn(async () => ({
      items: [
        {
          agent_id: "claude-code",
          external_ref: "ref-1",
          message_id: "u1",
          kind: "message" as const,
          role: "user" as const,
          text: "the imported question",
          occurred_at: 1,
          source_rev: "rev-1",
        },
        {
          agent_id: "claude-code",
          external_ref: "ref-1",
          message_id: "a1",
          kind: "message" as const,
          role: "assistant" as const,
          text: "the imported answer",
          occurred_at: 2,
          source_rev: "rev-1",
        },
      ],
      prev_cursor: "",
    })),
    attachAgentSession: vi.fn(),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
}));

vi.mock("../../hooks/useAgentRoles", () => ({
  useAgentRoles: () => [],
}));

import { attachAgentSession, getAgentSession } from "../../api/client";

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

function task(id: string, cwd: string): Task {
  return {
    id,
    title: id,
    cwd,
    agent: "kin",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
  } as Task;
}

function session(id: string): AgentSession {
  return {
    id,
    agent_id: "claude-code",
    external_ref: `ref-${id}`,
    title: `Imported chat ${id}`,
    cwd: "/work/project",
    status: "idle",
    first_seen_at: 1,
    last_seen_at: 2,
    updated_at: 2,
    linked: false,
    capabilities: ["session_attach"],
  };
}

let go: ((to: string) => void) | null = null;

function Jump() {
  const navigate = useNavigate();
  go = (to: string) => navigate(to);
  return null;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function list(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Jump />
      <LocationProbe />
      <Routes>
        <Route path="/sessions" element={<SessionList shell="page" />} />
        <Route path="/tasks/:id" element={<div>task screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  // The sheet owns one real history entry; index zero is the list entry the
  // deep link replaced, and it must be the entry left behind on close.
  window.history.replaceState({ idx: 0 }, "", "/sessions");
  fixtures.tasks = [task("real-task", "/work/project")];
  fixtures.sessions = [];
  go = null;
  viewport();
  vi.mocked(getAgentSession).mockReset();
  vi.mocked(getAgentSession).mockImplementation(async (id: string) => session(id));
  vi.mocked(attachAgentSession).mockReset();
});

describe("a deep-linked imported agent session", () => {
  it("KIN-CONTRACT-001: /sessions?agent=s1 opens that session's sheet over the list", async () => {
    list("/sessions?agent=s1");

    // The sheet opens from the URL's own read, and it names the session.
    const sheet = await screen.findByRole("dialog", { name: /Imported chat s1/ });
    expect(sheet).toBeTruthy();
    expect(getAgentSession).toHaveBeenCalledWith("s1");
    // The list is still the screen underneath: its own row is on page.
    expect(screen.getByRole("button", { name: /real-task/ })).toBeTruthy();
  });

  it("KIN-CONTRACT-001: closing the deep-linked sheet drops ?agent= and leaves the list in place", async () => {
    list("/sessions?agent=s1");
    await screen.findByRole("dialog", { name: /Imported chat s1/ });

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The parameter is gone and the list is still the page.
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/sessions"),
    );
    expect(screen.getByRole("button", { name: /real-task/ })).toBeTruthy();
    // The entry was given back, not stacked: Back cannot reopen the sheet.
    expect(window.history.state.idx).toBe(0);
  });

  it("KIN-CONTRACT-001: continuing from a deep-linked sheet attaches the session and lands on /tasks/:id", async () => {
    vi.mocked(attachAgentSession).mockResolvedValue({
      task: { id: "task-42", title: "carried on" } as Task,
      binding: { id: "b1" } as AgentSessionBinding,
    });

    list("/sessions?agent=s1");

    const box = await screen.findByRole("textbox");
    await userEvent.type(box, "carry on");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(attachAgentSession).toHaveBeenCalledWith("s1", { prompt: "carry on" }),
    );
    // The signed exit row: the source session attaches and the reader lands on
    // the new task, with the sheet and its parameter behind them.
    await screen.findByText("task screen");
    expect(screen.getByTestId("location").textContent).toBe("/tasks/task-42");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a failed ?agent= read keeps the list readable and offers a retry", async () => {
    vi.mocked(getAgentSession).mockRejectedValue(new Error("read failed"));

    list("/sessions?agent=s1");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not open that imported session");
    // The list's own rows are untouched by the failed entry read.
    expect(screen.getByRole("button", { name: /real-task/ })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The parameter stays, so a reload retries the same entry.
    expect(screen.getByTestId("location").textContent).toBe("/sessions?agent=s1");

    // The retry re-reads; the second answer opens the sheet.
    vi.mocked(getAgentSession).mockImplementation(async (id: string) => session(id));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("dialog", { name: /Imported chat s1/ }),
    ).toBeTruthy();
  });

  it("a late answer for a replaced agent id never opens the wrong sheet", async () => {
    let resolveA!: (value: AgentSession) => void;
    const answerA = new Promise<AgentSession>((resolve) => {
      resolveA = resolve;
    });
    vi.mocked(getAgentSession).mockImplementation((id: string) =>
      id === "a" ? answerA : Promise.resolve(session(id)),
    );

    list("/sessions?agent=a");
    await waitFor(() => expect(getAgentSession).toHaveBeenCalledWith("a"));

    // The reader moved to another session before a's answer was out.
    act(() => go!("/sessions?agent=b"));
    await screen.findByRole("dialog", { name: /Imported chat b/ });

    await act(async () => {
      resolveA(session("a"));
      await answerA;
    });

    // The stale answer is dropped; the sheet still belongs to b.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Imported chat a/ })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: /Imported chat b/ })).toBeTruthy();
  });
});
