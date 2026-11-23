// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type { Machine } from "../../lib/devices";
import {
  getOnePager,
  type AgentSession,
  type OnePager,
  type Project,
  type Task,
} from "../../api/client";

/**
 * A project link lands on the conversation list, narrowed.
 *
 * `/projects/:id` is retired as a page entry (KIN-CONTRACT-001): a bookmark, a
 * task header's project label and the list's own project heading all land on
 * `?project=<id>`, the list keeps only that project's conversations, and a
 * chip names it with a clear control that returns to the full list in the same
 * history entry.
 *
 * The narrowing is honest about paging: with unread pages still out, an empty
 * screen is not evidence the project has no conversations, so the list keeps
 * "Load older chats" instead of claiming the filter matched nothing.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  projects: [] as Project[],
  machines: [] as Machine[],
  sessions: [] as AgentSession[],
  sessionCursor: undefined as string | undefined,
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
    listAgentSessionsPage: vi.fn(async () => ({
      items: fixtures.sessions,
      next_cursor: fixtures.sessionCursor,
    })),
    listProjects: vi.fn(async () => fixtures.projects),
    listTasks: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p-alpha", name: "Project Alpha" })),
    getOnePager: vi.fn(async () => ({ project_id: "p-alpha", markdown: "", updated_at: 1 })),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({ machines: fixtures.machines, loading: false, failed: false }),
}));

const readOnePager = vi.mocked(getOnePager);

function pointer(kind: "fine" | "coarse") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? kind === "coarse" : false,
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

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      back
    </button>
  );
}

function list(entry: string, entries?: string[]) {
  return render(
    <MemoryRouter initialEntries={entries ?? [entry]}>
      <SessionList shell="page" />
      <LocationProbe />
      <BackButton />
    </MemoryRouter>,
  );
}

function locationText(): string {
  return screen.getByTestId("location").textContent ?? "";
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  readOnePager.mockResolvedValue({
    project_id: "p-alpha",
    markdown: "",
    updated_at: 1,
  } as OnePager);
  fixtures.tasks = [task("alpha-work", "/work/alpha"), task("beta-work", "/work/beta")];
  fixtures.projects = [
    project("p-alpha", "Project Alpha", "/work/alpha"),
    project("p-beta", "Project Beta", "/work/beta"),
  ];
  fixtures.machines = [
    { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
  ];
  fixtures.sessions = [];
  fixtures.sessionCursor = undefined;
  pointer("fine");
});

describe("a project link narrows the conversation list", () => {
  it("narrows the list to the project named in ?project= and shows its name in a chip", async () => {
    list("/sessions?project=p-alpha");

    expect(await screen.findByRole("button", { name: "Project Alpha" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Project Beta" })).toBeNull();
    expect(screen.getByText("Project: Project Alpha")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear project filter" })).toBeTruthy();
  });

  it("keeps the project's own conversation rows and drops another project's rows", async () => {
    // "Project Alpha" also names a different project on a different folder.
    // The id, not the name, is the filter: a name match would pull gamma's
    // conversations in beside the real project's.
    fixtures.tasks = [
      task("alpha-work", "/work/alpha"),
      task("beta-work", "/work/beta"),
      task("gamma-work", "/work/gamma"),
    ];
    fixtures.projects = [
      project("p-alpha", "Project Alpha", "/work/alpha"),
      project("p-beta", "Project Beta", "/work/beta"),
      project("p-gamma", "Project Alpha", "/work/gamma"),
    ];
    list("/sessions?project=p-alpha");

    expect(await screen.findByRole("button", { name: /alpha-work/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /beta-work/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /gamma-work/ })).toBeNull();
  });

  it("clearing the project chip returns to the same list entry without a new history entry", async () => {
    list("/sessions", ["/sessions", "/sessions?project=p-alpha"]);

    await screen.findByRole("button", { name: "Clear project filter" });
    await userEvent.click(screen.getByRole("button", { name: "Clear project filter" }));

    // The chip is gone and the full list is back in this entry.
    expect(screen.queryByRole("button", { name: "Clear project filter" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Project Beta" })).toBeTruthy();
    expect(locationText()).toBe("/sessions");

    // Back goes to the entry before the project link, not to the cleared list:
    // clearing replaced the narrowed entry instead of stacking a second one.
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() => expect(locationText()).toBe("/sessions"));
    expect(screen.queryByRole("button", { name: "Clear project filter" })).toBeNull();
  });

  it("an unknown project id keeps the chip and shows the filter-empty sentence after the last page", async () => {
    list("/sessions?project=missing-project");

    expect(await screen.findByText("No chats match this filter")).toBeTruthy();
    expect(screen.getByText("Project: missing-project")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear project filter" })).toBeTruthy();
  });

  it("a narrowed list with unread pages does not claim the project is empty", async () => {
    // The project's record and its conversations may both be on a page that
    // has not been read yet. The loaded page is empty, but that is not the
    // project's answer while older pages are still out.
    fixtures.tasks = [];
    fixtures.projects = [];
    fixtures.sessionCursor = "cursor-1";
    list("/sessions?project=p-alpha");

    expect(await screen.findByRole("button", { name: "Load older chats" })).toBeTruthy();
    expect(screen.queryByText("No chats match this filter")).toBeNull();
    expect(screen.queryByText("No chats yet")).toBeNull();
  });

  it("the project chip's clear control takes the 44px floor on a coarse pointer", async () => {
    pointer("coarse");
    const first = list("/sessions?project=p-alpha");

    const coarseClear = await screen.findByRole("button", { name: "Clear project filter" });
    expect(coarseClear.className).toContain("h-11");
    expect(coarseClear.className).toContain("w-11");

    first.unmount();
    pointer("fine");
    list("/sessions?project=p-alpha");

    const mouseClear = await screen.findByRole("button", { name: "Clear project filter" });
    expect(mouseClear.className).toContain("h-9");
    expect(mouseClear.className).toContain("w-9");
  });
});
