// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import { clearDraftPrompt, setDraftPrompt } from "../../lib/draftChat";
import {
  listAgentSessionsPage,
  listTasks,
  type AgentSession,
  type Project,
  type Task,
} from "../../api/client";

/**
 * The list's recovery, paging and project controls all answer to the shared
 * `Button` now, while the rows stay rows.
 *
 * The split is the same one `SessionRow` already keeps: a full-width navigation
 * row is not a button-shaped control, but every *action* — retry, load older,
 * restore a project, show all, open the project menu — takes its height,
 * focus ring, disabled and busy states from one component. These tests pin
 * that split, plus the two behaviours built earlier that the migration must not
 * regress: the list's search/filter state lives in the URL, and the rows keep
 * their press surface rather than gaining `kin-btn`.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  error: null as Error | null,
  pageFull: false,
  projects: [] as Project[],
  sessionsReject: false,
  sessionsCalls: 0,
  listTasksImpl: async () => [] as Task[],
}));

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: fixtures.tasks,
    loaded: true,
    error: fixtures.error,
    pageFull: fixtures.pageFull,
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
    listAgentSessionsPage: vi.fn(async () => {
      fixtures.sessionsCalls += 1;
      if (fixtures.sessionsReject) throw new Error("agent sessions unavailable");
      return { items: [] as AgentSession[], next_cursor: undefined };
    }),
    listTasks: vi.fn(() => fixtures.listTasksImpl()),
    listProjects: vi.fn(async () => fixtures.projects),
    ensureProject: vi.fn(async () => ({ id: "p", name: "alpha" })),
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

function viewport(pointer: "fine" | "coarse") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? pointer === "coarse" : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function task(id: string, cwd = "/work/alpha", archivedAt?: number): Task {
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
    ...(archivedAt ? { archived_at: archivedAt } : {}),
  } as Task;
}

function mount(shell: "sidebar" | "page" = "sidebar", path = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionList shell={shell} />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function locationText(): string {
  return screen.getByTestId("location").textContent ?? "";
}

/** Read the built source: every raw button must carry its one-line reason. */
function rawButtonsWithoutReason(source: string): number[] {
  const lines = source.split("\n");
  const bad: number[] = [];
  lines.forEach((line, index) => {
    if (!line.includes("<button")) return;
    const above = lines.slice(Math.max(0, index - 8), index).join("\n");
    if (!above.includes("eslint-disable-next-line kin/no-raw-button")) bad.push(index + 1);
  });
  return bad;
}

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  clearDraftPrompt();
  fixtures.tasks = [];
  fixtures.error = null;
  fixtures.pageFull = false;
  fixtures.projects = [];
  fixtures.sessionsReject = false;
  fixtures.sessionsCalls = 0;
  fixtures.listTasksImpl = async () => [];
  vi.mocked(listTasks).mockClear();
  vi.mocked(listAgentSessionsPage).mockClear();
  viewport("fine");
});

afterEach(() => {
  clearDraftPrompt();
});

describe("the list's recovery and paging controls", () => {
  it("puts the load-older row on the quiet shared Button", async () => {
    fixtures.tasks = [task("alpha-1")];
    fixtures.pageFull = true;
    let resolvePage: (page: Task[]) => void = () => {};
    fixtures.listTasksImpl = () =>
      new Promise<Task[]>((resolve) => {
        resolvePage = resolve;
      });

    mount("sidebar");

    const control = screen.getByRole("button", { name: "Load older chats" });
    expect(control.className).toContain("kin-btn");
    expect(control.className).not.toContain("kin-btn-primary");
    // The quiet variant emits `text-kin-text` after `text-kin-muted`, so the
    // muted weight only survives the cascade with the important marker.
    expect(control.className).toContain("text-kin-muted!");

    await userEvent.click(control);
    await waitFor(() => expect(vi.mocked(listTasks)).toHaveBeenCalledTimes(1));

    const busy = screen.getByRole<HTMLButtonElement>("button", { name: "Loading older chats…" });
    expect(busy.disabled).toBe(true);
    expect(busy.className).toContain("kin-btn");

    resolvePage([]);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Loading older chats…" })).toBeNull(),
    );
    expect(vi.mocked(listTasks)).toHaveBeenCalledTimes(1);
  });

  it("puts both error retries on the shared Button", async () => {
    // The empty state: the list read failed and there are no rows, so Retry is
    // the only action on the screen and takes the one filled weight.
    fixtures.error = new Error("list unavailable");
    const first = mount("sidebar");

    const emptyRetry = screen.getByRole("button", { name: "Retry" });
    expect(emptyRetry.className).toContain("kin-btn");
    expect(emptyRetry.className).toContain("kin-btn-primary");

    const beforeEmpty = vi.mocked(listAgentSessionsPage).mock.calls.length;
    await userEvent.click(emptyRetry);
    await waitFor(() =>
      expect(vi.mocked(listAgentSessionsPage).mock.calls.length).toBe(beforeEmpty + 1),
    );
    first.unmount();

    // The inline notice: rows are on screen but the import index failed, so
    // Retry is a peer action, not the screen's primary.
    fixtures.error = null;
    fixtures.tasks = [task("alpha-1")];
    fixtures.sessionsReject = true;
    const second = mount("sidebar");

    const noticeRetry = await screen.findByRole("button", { name: "Retry" });
    expect(noticeRetry.className).toContain("kin-btn");
    expect(noticeRetry.className).not.toContain("kin-btn-primary");

    const beforeNotice = vi.mocked(listAgentSessionsPage).mock.calls.length;
    await userEvent.click(noticeRetry);
    await waitFor(() =>
      expect(vi.mocked(listAgentSessionsPage).mock.calls.length).toBe(beforeNotice + 1),
    );
    second.unmount();
  });

  it("puts the project controls on the shared Button", async () => {
    // Restore: the archived scope's project heading carries the bordered peer,
    // not the one filled primary.
    fixtures.tasks = [task("alpha-1", "/work/alpha", 99)];
    localStorage.setItem("kin_archived_projects", JSON.stringify(["/work/alpha"]));
    const archived = mount("sidebar", "/sessions?scope=archived");

    const restore = screen.getByRole("button", { name: "Restore alpha" });
    expect(restore.className).toContain("kin-btn");
    expect(restore.className).toContain("kin-btn-secondary");
    archived.unmount();
    localStorage.clear();

    // Show all: a disclosure, so it keeps quiet weight and its aria-expanded.
    const ids = Array.from({ length: 11 }, (_, index) => `alpha-${index + 1}`);
    fixtures.tasks = ids.map((id) => task(id));
    const tall = mount("sidebar");

    const showAll = screen.getByRole("button", { name: "Show all (11)" });
    expect(showAll.className).toContain("kin-btn");
    expect(showAll.className).not.toContain("kin-btn-primary");
    expect(showAll.className).toContain("text-kin-muted!");
    expect(showAll.getAttribute("aria-expanded")).toBe("false");

    const chevron = screen.getByRole("button", { name: "Collapse project alpha" });
    expect(chevron.className).toContain("kin-btn");
    expect(chevron.className).toContain("text-kin-muted!");

    await userEvent.click(showAll);
    const showLess = screen.getByRole("button", { name: "Show less" });
    expect(showLess.getAttribute("aria-expanded")).toBe("true");
    tall.unmount();

    // The touch project menu: same name, same dialog contract, same rows.
    viewport("coarse");
    fixtures.tasks = [task("alpha-1")];
    const page = mount("page");

    const more = screen.getByRole("button", { name: "Project actions" });
    expect(more.className).toContain("kin-btn");
    expect(more.className).toContain("text-kin-muted!");
    expect(more.getAttribute("aria-haspopup")).toBe("dialog");

    await userEvent.click(more);
    expect(await screen.findByRole("button", { name: "New conversation in alpha" })).toBeTruthy();
    page.unmount();
  });

  it("leaves navigation rows as rows, not buttons", () => {
    setDraftPrompt("hello");
    fixtures.tasks = [task("alpha-1")];
    const view = mount("sidebar");

    const draft = screen.getByRole("button", { name: /New chat/ });
    expect(draft.className).toContain("kin-row-press");
    expect(draft.className).not.toContain("kin-btn");

    const conversation = screen.getByRole("button", { name: /alpha-1/ });
    expect(conversation.className).toContain("kin-row-press");
    expect(conversation.className).not.toContain("kin-btn");

    // Every remaining raw button in the two list sources says why in one line.
    expect(rawButtonsWithoutReason(source("./SessionList.tsx"))).toEqual([]);
    expect(rawButtonsWithoutReason(source("../mobile/MobileList.tsx"))).toEqual([]);
    view.unmount();
  });

  it("keeps the search and filter state in the URL across leaving and returning", async () => {
    fixtures.tasks = [task("alpha-1")];
    const first = render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <SessionList shell="sidebar" />
        <LocationProbe />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByRole("searchbox"), "alpha");
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.click(screen.getByRole("button", { name: "Running" }));

    await waitFor(() => expect(locationText()).toContain("search=alpha"));
    expect(locationText()).toContain("status=running");

    // Leaving unmounts the list; the URL is what it comes back to.
    const url = `/sessions${locationText()}`;
    first.unmount();

    render(
      <MemoryRouter initialEntries={[url]}>
        <SessionList shell="sidebar" />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("alpha");
    expect(screen.getByRole("button", { name: /Running/ })).toBeTruthy();
    expect(locationText()).toContain("search=alpha");
    expect(locationText()).toContain("status=running");
  });
});
