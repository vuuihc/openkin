// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import { clearDraftPrompt } from "../../lib/draftChat";
import { listUrlFor } from "../../lib/phoneNavigation";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * A routine run is a task row like any other, and it must read as a run.
 *
 * The list already draws runs (the tasks endpoint holds them); what is missing
 * is the source marker, the `?routine=` narrowing and the chip that makes the
 * narrowing visible and reversible. The server filter is covered by
 * `sessionListParams`; these tests pin the browser's half: the page the hook
 * already handed over is narrowed locally too, so a stale page cannot sit
 * under the filter for a round trip.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  agentSessions: [] as AgentSession[],
  taskListCalls: [] as Array<{ limit?: number; routineId?: string }>,
}));

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: (params?: { routineId?: string }) => {
    fixtures.taskListCalls.push(params ?? {});
    return {
      data: fixtures.tasks,
      loaded: true,
      error: null,
      pageFull: false,
      loading: false,
    };
  },
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
      items: fixtures.agentSessions,
      // Another imported page so the list-level paging control is live; the
      // tests below decide whether a narrowing is allowed to offer it.
      next_cursor: "next",
    })),
    listTasks: vi.fn(async () => [] as Task[]),
    listProjects: vi.fn(async () => [] as Project[]),
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

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    cwd: "/work/alpha",
    agent: "kin",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
    ...extra,
  } as Task;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function mount(path = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionList shell="sidebar" />
      <LocationProbe />
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
  clearDraftPrompt();
  fixtures.tasks = [];
  fixtures.agentSessions = [];
  fixtures.taskListCalls = [];
});

describe("routine runs in the conversation list", () => {
  it("marks a routine run and leaves a conversation unmarked", () => {
    fixtures.tasks = [
      task("c1", { title: "Afternoon chat" }),
      task("run-1", { title: "Morning brief", routine_id: "r1" }),
    ];
    mount();

    const run = screen.getByRole("button", { name: /Morning brief/ });
    expect(run.textContent).toContain("Routine");
    // The marker is the row's one status slot now, not a separate chip: the
    // name says this row is a run, and that is the status it reports.
    expect(run.getAttribute("aria-label")).toContain("Routine");
    expect(run.getAttribute("aria-label")).not.toContain("Done");

    const chat = screen.getByRole("button", { name: /Afternoon chat/ });
    expect(chat.textContent).not.toContain("Routine");
  });

  it("narrows to one routine under ?routine=", () => {
    fixtures.tasks = [
      task("c1", { title: "Afternoon chat" }),
      task("run-1", { title: "Morning brief", routine_id: "r1" }),
      task("run-2", { title: "Evening brief", routine_id: "r2" }),
    ];
    mount("/sessions?routine=r1");

    expect(screen.getByRole("button", { name: /Morning brief/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Evening brief/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Afternoon chat/ })).toBeNull();
    // The narrowing is not only a browser pass over the loaded page: the URL
    // parameter reaches the list request, so a routine with no run on the
    // first page is not reported as "no runs".
    // The archived list is read on every mount and carries the filter too, so
    // an objectContaining match would also accept that call; this exact shape
    // is the live read only (the archived one adds `archived: true`).
    expect(fixtures.taskListCalls).toContainEqual({ limit: 100, routineId: "r1" });
  });

  it("keeps routine in the list URL a return carries", () => {
    // Back from a task, a draft return and a device-new return all rebuild the
    // list URL from this key list; a missing key would quietly drop the filter
    // and land the reader on the full list.
    expect(listUrlFor("?q=prefill&routine=r1&scope=archived&status=running&search=note")).toBe(
      "/sessions?search=note&status=running&scope=archived&routine=r1",
    );
  });

  it("hides the imported sessions group while a routine is filtered", async () => {
    // Imported agent sessions have no routine at all, so they cannot be one
    // routine's runs; the group and its paging disappear with the filter the
    // same way they do under `?status=`.
    fixtures.tasks = [task("run-1", { title: "Morning brief", routine_id: "r1" })];
    fixtures.agentSessions = [
      {
        id: "sess-1",
        agent_id: "claude-code",
        external_ref: "claude-session-1",
        title: "Imported chat",
        cwd: "/work/alpha",
        status: "idle",
        first_seen_at: 1,
        last_seen_at: 1,
        updated_at: 1,
        linked: false,
      },
    ];

    const all = mount("/sessions");
    expect(await screen.findByText(/Imported sessions/)).toBeTruthy();
    // The fixture has another imported page, so an unfiltered list offers it.
    expect(screen.getByRole("button", { name: "Load older chats" })).toBeTruthy();
    all.unmount();

    mount("/sessions?routine=r1");
    await waitFor(() => expect(screen.getByRole("button", { name: /Morning brief/ })).toBeTruthy());
    expect(screen.queryByText(/Imported sessions/)).toBeNull();
    // Let the imported next-page answer land before judging the control: the
    // cursor is real, and only the filter is allowed to keep it off screen.
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Load older chats" })).toBeNull();
  });

  it("shows the filter empty state and clears the chip", async () => {
    fixtures.tasks = [task("c1", { title: "Afternoon chat" })];
    mount("/sessions?routine=r9");

    expect(screen.getByText("No chats match this filter")).toBeTruthy();

    const chip = screen.getByText("Routine runs");
    expect(chip).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Clear routine filter" }));

    expect(locationText()).not.toContain("routine=");
    expect(screen.getByRole("button", { name: /Afternoon chat/ })).toBeTruthy();
  });
});
