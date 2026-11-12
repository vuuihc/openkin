// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { setLocale } from "../i18n";
import { liveResources } from "../api/liveResources";
import { archiveProject } from "../lib/projectSidebar";
import SessionsPage from "./SessionsPage";
import SessionsRoute from "./SessionsRoute";
import type { AgentSession, Project, Task } from "../api/client";

/**
 * KIN-CONTINUE-001: one list per width.
 *
 * On a Mac `/sessions` is the draft, because the sidebar already holds the only
 * conversation list. On a phone the page *is* the list.
 *
 * KIN-CONTINUE-002: the phone page is also the only navigation surface. Its
 * footer is outside the list's scroll body, so a failed read cannot take the
 * destinations away; an empty list still points at the new-chat button.
 */

vi.mock("./NewChatPage", () => ({
  default: () => <div>draft page</div>,
}));

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  sessions: [] as AgentSession[],
  projects: [] as Project[],
  loaded: true,
  error: null as string | null,
  machinesLoading: false,
}));

vi.mock("../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: fixtures.tasks,
    loaded: fixtures.loaded,
    error: fixtures.error,
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

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    listAgentSessionsPage: vi.fn(async () => ({
      items: fixtures.sessions,
      next_cursor: undefined,
    })),
    listProjects: vi.fn(async () => fixtures.projects),
    ensureProject: vi.fn(async () => ({ id: "project-1", name: "alpha" })),
    serverVersion: vi.fn().mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" }),
    listMachines: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: fixtures.machinesLoading,
    failed: false,
  }),
}));

function viewport(wide: boolean) {
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

function task(id: string, title: string): Task {
  return {
    id,
    title,
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

function phonePage(path = "/sessions") {
  return (
    <MemoryRouter initialEntries={[path]}>
      <SessionsPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [];
  fixtures.sessions = [];
  fixtures.projects = [];
  fixtures.loaded = true;
  fixtures.error = null;
  fixtures.machinesLoading = false;
  viewport(false);
});

describe("the /sessions route", () => {
  it("shows the draft on a Mac, not a second list", () => {
    viewport(true);
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <SessionsRoute />
      </MemoryRouter>,
    );
    expect(screen.getByText("draft page")).toBeTruthy();
    expect(document.querySelector("[data-phone-footer]")).toBeNull();
  });

  it("shows the list page on a phone", () => {
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <SessionsRoute />
      </MemoryRouter>,
    );
    expect(document.querySelector("[data-phone-footer]")).toBeTruthy();
    expect(screen.queryByText("draft page")).toBeNull();
  });

  it("keeps one list on a Mac when an archived address is opened", () => {
    // `?scope=archived` selects the sidebar's archived section; it must not
    // bring a second list and a second search field back into the main area.
    viewport(true);
    render(
      <MemoryRouter initialEntries={["/sessions?scope=archived"]}>
        <SessionsRoute />
      </MemoryRouter>,
    );
    expect(screen.getByText("draft page")).toBeTruthy();
    expect(document.querySelector("[data-phone-footer]")).toBeNull();
  });
});

describe("the phone page's states", () => {
  it("keeps the footer when the list read fails", async () => {
    fixtures.error = "boom";
    render(phonePage());

    expect(await screen.findByText("Could not load chats")).toBeTruthy();
    expect(document.querySelector("[data-phone-footer]")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Archived" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
  });

  it("offers a retry that refetches the list", async () => {
    fixtures.error = "boom";
    const refresh = vi.spyOn(liveResources, "refreshTaskList").mockResolvedValue();
    render(phonePage());

    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockRestore();
  });

  it("retries the archive scope too", async () => {
    fixtures.error = "boom";
    const refresh = vi.spyOn(liveResources, "refreshTaskList").mockResolvedValue();
    render(phonePage("/sessions?scope=archived"));

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    const calls = refresh.mock.calls as unknown as [ { archived?: boolean } ][];
    expect(calls.some(([params]) => params.archived === true)).toBe(true);
    refresh.mockRestore();
  });

  it("reopens where the reader left the list", () => {
    sessionStorage.setItem("kin.listScroll", "180");
    render(phonePage());
    expect(document.querySelector("[data-phone-scroll]")?.scrollTop).toBe(180);
  });

  it("restores the position once the rows arrive", () => {
    // On a phone the first restore lands while the list is still short, so the
    // browser clamps it; the retry has to run when the rows land, not when the
    // scroll container's own box changes (it never does).
    sessionStorage.setItem("kin.listScroll", "180");
    fixtures.loaded = false;
    const view = render(phonePage());
    const scroller = document.querySelector("[data-phone-scroll]") as HTMLElement;
    expect(scroller.scrollTop).toBe(180);

    scroller.scrollTop = 0; // the clamp a short list would have produced
    fixtures.loaded = true;
    fixtures.tasks = [task("only", "Yesterday chat")];
    view.rerender(phonePage());

    expect(scroller.scrollTop).toBe(180);
  });

  it("restores the position in the archive scope when its rows arrive", () => {
    // The archive scope draws a heading for each archived project before any of
    // its tasks are known, so the heading count is already final at the first
    // frame. The retry has to key on the row count or this case never fires.
    archiveProject("/work/alpha");
    sessionStorage.setItem("kin.listScroll", "180");
    // Already loaded: no loading line to move the signal, so only the row
    // count can retry the restore when the archived task arrives.
    const view = render(phonePage("/sessions?scope=archived"));
    const scroller = document.querySelector("[data-phone-scroll]") as HTMLElement;
    expect(scroller.scrollTop).toBe(180);

    scroller.scrollTop = 0; // the clamp a short list would have produced
    fixtures.tasks = [task("archived-only", "Old chat")];
    view.rerender(phonePage("/sessions?scope=archived"));

    expect(scroller.scrollTop).toBe(180);
  });

  it("restores after a cold reload once the machine list stops loading", () => {
    // The body is the loading line while the machine list resolves, even when
    // every row is already known. The position must be retried when the rows
    // actually paint, not only when the row count changes.
    sessionStorage.setItem("kin.listScroll", "180");
    fixtures.tasks = [task("only", "Yesterday chat")];
    fixtures.machinesLoading = true;
    const view = render(phonePage());
    const scroller = document.querySelector("[data-phone-scroll]") as HTMLElement;
    expect(scroller.scrollTop).toBe(180);

    scroller.scrollTop = 0;
    fixtures.machinesLoading = false;
    view.rerender(phonePage());

    expect(scroller.scrollTop).toBe(180);
  });

  it("records where the reader was when the page goes away", () => {
    // The restore half is worthless without a writer; the first delivery had
    // only the reader, so a fresh tab always remembered "top".
    const { unmount } = render(phonePage());
    const scroller = document.querySelector("[data-phone-scroll]") as HTMLElement;
    scroller.scrollTop = 240;
    fireEvent.scroll(scroller);
    unmount();
    expect(sessionStorage.getItem("kin.listScroll")).toBe("240");
  });

  it("points an empty list at the new-chat button", async () => {
    fixtures.tasks = [];
    render(phonePage());

    expect(await screen.findByText("No chats yet")).toBeTruthy();
    expect(screen.getByText(/bottom right/)).toBeTruthy();
    expect(document.querySelector("[data-phone-return='new']")).toBeTruthy();
  });

  it("keeps the four footer destinations on the page", () => {
    render(phonePage());
    const footer = document.querySelector("[data-phone-footer]");
    expect(footer).toBeTruthy();
    const links = footer?.querySelectorAll("a") ?? [];
    expect(links).toHaveLength(4);
    expect(Array.from(links).map((link) => link.textContent)).toEqual([
      "Archived",
      "Routines",
      "Agent Ops",
      "Settings",
    ]);
    expect(screen.queryByText("Import Agent sessions")).toBeNull();
  });

  it("waits for the list before declaring it empty", () => {
    fixtures.loaded = false;
    fixtures.tasks = [];
    render(phonePage());
    expect(screen.queryByText("No chats yet")).toBeNull();
    expect(document.querySelector("[data-phone-footer]")).toBeTruthy();
  });

  it("draws a conversation row from the shared list", async () => {
    fixtures.tasks = [task("only", "Yesterday chat")];
    render(phonePage());
    expect(await screen.findByRole("button", { name: /Yesterday chat/ })).toBeTruthy();
    await waitFor(() => expect(document.querySelector("[data-session-row='only']")).toBeTruthy());
  });
});
