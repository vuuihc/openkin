// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type { Machine } from "../../lib/devices";
import {
  type AgentSession,
  type Project,
  type Task,
} from "../../api/client";

/**
 * The imported session row opens the list's own sheet, not the page.
 *
 * Tapping it used to leave `/sessions` for `/agent-sessions/:id`, so coming
 * back walked the back stack and the phone lost the list's place. A real task
 * row still navigates: this is a change to one branch of the row's opening
 * rule, not to the list.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  projects: [] as Project[],
  machines: [] as Machine[],
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
    listProjects: vi.fn(async () => fixtures.projects),
    listTasks: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p", name: "alpha" })),
    getOnePager: vi.fn(async (id: string) => ({
      project_id: id,
      markdown: "# Project Alpha\n",
      updated_at: 1,
    })),
    getAgentSession: vi.fn(async (id: string) => {
      const found = fixtures.sessions.find((candidate) => candidate.id === id);
      if (!found) throw new Error("missing fixture");
      return found;
    }),
    getAgentSessionHistory: vi.fn(async () => ({
      items: [
        {
          agent_id: "claude-code",
          external_ref: "imported-1",
          message_id: "u1",
          kind: "message" as const,
          role: "user" as const,
          text: "the imported question",
          occurred_at: 1,
          source_rev: "rev-1",
        },
        {
          agent_id: "claude-code",
          external_ref: "imported-1",
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
  useMachines: () => ({ machines: fixtures.machines, loading: false, failed: false }),
}));

vi.mock("../../hooks/useAgentRoles", () => ({
  useAgentRoles: () => [],
}));

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

function project(id: string, name: string, root: string): Project {
  return {
    id,
    name,
    mode: "default",
    status: "active",
    created_at: 1,
    updated_at: 1,
    last_active_at: 1,
    roots: [root],
  } as Project;
}

function session(id: string): AgentSession {
  return {
    id,
    agent_id: "codex",
    external_ref: id,
    title: `Imported chat ${id}`,
    cwd: "/work/alpha",
    status: "idle",
    first_seen_at: 0,
    last_seen_at: 0,
    updated_at: 1,
    linked: false,
    capabilities: ["session_attach"],
  } as AgentSession;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function list() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <SessionList shell="page" />
      <LocationProbe />
    </MemoryRouter>,
  );
}

async function openImportedRow(): Promise<HTMLElement> {
  // Imported sessions are an index, collapsed until asked for.
  await userEvent.click(
    await screen.findByRole("button", { name: /Expand project Imported sessions/ }),
  );
  const row = await screen.findByRole("button", { name: /Imported chat imported-1/ });
  await userEvent.click(row);
  return row;
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/sessions");
  fixtures.tasks = [];
  fixtures.projects = [project("p-alpha", "Project Alpha", "/work/alpha")];
  fixtures.machines = [
    { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
  ];
  fixtures.sessions = [session("imported-1")];
  viewport();
});

describe("an imported agent session opens in the list's sheet", () => {
  it("opens an imported agent session in a sheet instead of leaving the list", async () => {
    list();

    const row = await openImportedRow();

    const sheet = await screen.findByRole("dialog", { name: /Imported chat imported-1/ });
    expect(sheet).toBeTruthy();
    // Still the list: the row did not navigate.
    expect(screen.getByTestId("location").textContent).toBe("/sessions");
    // The session's own recent turns are in it.
    expect(await screen.findByText("the imported answer")).toBeTruthy();
    // The row is still behind the sheet, not replaced by a page.
    expect(row).toBeTruthy();
  });

  it("closes back to the row, with focus on it and the list in place", async () => {
    list();
    const row = await openImportedRow();
    await screen.findByRole("dialog", { name: /Imported chat imported-1/ });

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("location").textContent).toBe("/sessions");
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("closes on the phone Back layer", async () => {
    list();
    const row = await openImportedRow();
    await screen.findByRole("dialog", { name: /Imported chat imported-1/ });

    window.history.back();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("location").textContent).toBe("/sessions");
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("the list still opens a real task row as before", async () => {
    fixtures.tasks = [task("real-task", "/work/alpha")];
    list();

    await userEvent.click(await screen.findByRole("button", { name: /real-task/ }));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/tasks/real-task"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
