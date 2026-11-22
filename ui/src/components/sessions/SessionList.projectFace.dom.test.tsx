// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import { getDraftCwd } from "../../lib/draftChat";
import type { Machine } from "../../lib/devices";
import {
  getOnePager,
  type AgentSession,
  type OnePager,
  type Project,
  type Task,
} from "../../api/client";

/**
 * The project row carries the project's 工作方式.
 *
 * A project's work instructions live in ONE_PAGER.md and a new chat receives
 * them. Until now they could only be read by opening the project cover; the
 * list is where a person chooses a project, so the expanded row has to show
 * the same text before its conversations. The read is lazy (collapsed rows
 * issue none), per project (a late answer never paints under another heading),
 * and the only action is the existing "ask Kin to edit" draft.
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
    listAgentSessionsPage: vi.fn(async () => ({
      items: fixtures.sessions,
      next_cursor: undefined,
    })),
    listProjects: vi.fn(async () => fixtures.projects),
    listTasks: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p", name: "alpha" })),
    getOnePager: vi.fn(),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({ machines: fixtures.machines, loading: false, failed: false }),
}));

const readOnePager = vi.mocked(getOnePager);

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

function task(id: string, cwd: string, options: { device?: string } = {}): Task {
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
    ...(options.device ? { executing_device_id: options.device } : {}),
  } as Task;
}

function project(id: string, name: string, root: string | string[]): Project {
  return {
    id,
    name,
    mode: "default",
    status: "active",
    created_at: 1,
    updated_at: 1,
    last_active_at: 1,
    roots: Array.isArray(root) ? root : [root],
  } as Project;
}

function session(id: string): AgentSession {
  return {
    id,
    agent_id: "claude-code",
    external_ref: id,
    title: `Chat ${id}`,
    cwd: "/work/alpha",
    status: "idle",
    first_seen_at: 0,
    last_seen_at: 0,
    updated_at: 1,
    linked: false,
  } as AgentSession;
}

function onePager(markdown: string): OnePager {
  return { project_id: "p-alpha", markdown, updated_at: 1 };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

function list() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <SessionList shell="page" />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function locationText(): string {
  return screen.getByTestId("location").textContent ?? "";
}

/** The fold key the self machine's bucket answers to. */
function collapseProject(cwd: string): void {
  localStorage.setItem(
    "kin_session_folds",
    JSON.stringify({ [`mac-1::${cwd.toLowerCase()}`]: false }),
  );
}

function bucketSection(heading: string, scope: HTMLElement | null = null): HTMLElement {
  const button = (scope ? within(scope) : screen).getByRole("button", { name: heading });
  return button.closest("section")!;
}

function instructionsRegion(scope: HTMLElement = document.body): HTMLElement | null {
  return within(scope).queryByRole("region", { name: /^How to work here/ });
}

/**
 * Make the list's clamped preview measure as overflowing. jsdom lays nothing
 * out, so without this the two-line clamp is 0px tall and the disclosure is
 * (correctly) never offered. Only the clamped paragraph answers; every other
 * element keeps jsdom's own zero.
 */
function stubPreviewOverflow(): () => void {
  const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const overflowing = function (this: HTMLElement): number {
    return this.classList?.contains("line-clamp-2") ? 100 : 0;
  };
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: overflowing,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains("line-clamp-2") ? 40 : 0;
    },
  });
  return () => {
    if (scroll) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scroll);
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    if (client) Object.defineProperty(HTMLElement.prototype, "clientHeight", client);
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  };
}

const INSTRUCTIONS =
  "# Project Alpha\n\n## 工作方式\n\n- run make check first\n- keep commits small\n";

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  readOnePager.mockReset();
  readOnePager.mockResolvedValue(onePager(INSTRUCTIONS));
  fixtures.tasks = [task("alpha-work", "/work/alpha")];
  fixtures.projects = [project("p-alpha", "Project Alpha", "/work/alpha")];
  fixtures.machines = [
    { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
  ];
  fixtures.sessions = [];
  viewport();
});

describe("a project's work instructions in the conversation list", () => {
  it("shows the work instructions when a project row is expanded, and reads them only then", async () => {
    collapseProject("/work/alpha");
    list();

    // Collapsed at mount: the row is on screen and nothing has been read.
    await screen.findByRole("button", { name: "Project Alpha" });
    expect(readOnePager).not.toHaveBeenCalled();
    expect(instructionsRegion()).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Expand project Project Alpha" }));

    // The read starts with the expand, not with the list's mount.
    await waitFor(() => expect(readOnePager).toHaveBeenCalledWith("p-alpha"));
    expect(readOnePager).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/run make check first/)).toBeTruthy();
    expect(screen.getByText("How to work here")).toBeTruthy();
  });

  it("shows the empty sentence and a write launcher when the section is missing", async () => {
    readOnePager.mockResolvedValue(onePager("# Project Alpha\n\n## 摘要\n\nA summary only.\n"));
    list();

    expect(await screen.findByText("No working instructions yet")).toBeTruthy();
    const launcher = screen.getByRole("link", { name: /Ask Kin to write…/ });
    const href = launcher.getAttribute("href") ?? "";
    expect(href).toContain("q=");
    // The launcher carries the same edit request the cover offers.
    expect(decodeURIComponent(href)).toContain(
      "Read the “How to work here” section of ONE_PAGER.md",
    );
  });

  it("keeps the conversations and offers Retry when the one-pager read fails", async () => {
    readOnePager
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(onePager(INSTRUCTIONS));
    list();

    expect(await screen.findByText("The summary is unavailable right now")).toBeTruthy();
    // A failed instructions read never costs the project its conversations.
    expect(screen.getByRole("button", { name: /alpha-work/ })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/run make check first/)).toBeTruthy();
    expect(readOnePager).toHaveBeenCalledTimes(2);
  });

  it("a late answer for one project never paints under another", async () => {
    fixtures.tasks = [task("alpha-work", "/work/alpha"), task("beta-work", "/work/beta")];
    fixtures.projects = [
      project("p-alpha", "Project Alpha", "/work/alpha"),
      project("p-beta", "Project Beta", "/work/beta"),
    ];
    collapseProject("/work/beta");
    const alphaReads: Deferred<OnePager>[] = [];
    const betaRead = deferred<OnePager>();
    readOnePager.mockImplementation((id: string) => {
      if (id === "p-alpha") {
        const read = deferred<OnePager>();
        alphaReads.push(read);
        return read.promise;
      }
      return betaRead.promise;
    });
    list();

    // Alpha is expanded at mount; its first read is out.
    await waitFor(() => expect(alphaReads).toHaveLength(1));

    // Leave Alpha and open Beta: Beta's block paints its own text.
    await userEvent.click(screen.getByRole("button", { name: "Collapse project Project Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "Expand project Project Beta" }));
    await waitFor(() => expect(readOnePager).toHaveBeenCalledWith("p-beta"));
    betaRead.resolve(onePager("## 工作方式\n\n- beta only\n"));
    expect(await screen.findByText(/beta only/)).toBeTruthy();

    // Re-open Alpha: a second read supersedes the first.
    await userEvent.click(screen.getByRole("button", { name: "Expand project Project Alpha" }));
    await waitFor(() => expect(alphaReads).toHaveLength(2));
    alphaReads[1].resolve(onePager("## 工作方式\n\n- alpha newest\n"));
    expect(await screen.findByText(/alpha newest/)).toBeTruthy();

    // The first, superseded answer lands last and must not replace it.
    alphaReads[0].resolve(onePager("## 工作方式\n\n- alpha stale\n"));
    await waitFor(() => expect(screen.queryByText(/alpha stale/)).toBeNull());
    expect(screen.getByText(/alpha newest/)).toBeTruthy();
    expect(screen.getByText(/beta only/)).toBeTruthy();
  });

  it("the block is not drawn for synthetic, imported or remote buckets", async () => {
    localStorage.setItem("kin_pinned_tasks", JSON.stringify(["pinned-chat"]));
    fixtures.tasks = [
      task("alpha-work", "/work/alpha"),
      task("alpha-remote", "/work/alpha", { device: "nas-1" }),
      task("pinned-chat", "/work/alpha"),
      task("loose-chat", ""),
    ];
    fixtures.sessions = [session("imported-1")];
    fixtures.machines = [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
      { id: "nas-1", label: "Studio", isSelf: false, online: true, roots: [], agents: [] },
    ];
    list();

    // The local project is the only heading that carries a block and a read.
    expect(await screen.findByText(/run make check first/)).toBeTruthy();
    await waitFor(() => expect(readOnePager.mock.calls.map(([id]) => id)).toEqual(["p-alpha"]));
    // The remote copy of the same path draws the same heading name, so the
    // local one is looked up inside this machine's section.
    const thisMachine = screen.getByRole("region", { name: /This machine/ });
    expect(instructionsRegion(bucketSection("Project Alpha", thisMachine))).toBeTruthy();

    // Pinned and No-project are synthetic buckets: no project record, no block.
    expect(instructionsRegion(bucketSection("Pinned"))).toBeNull();
    expect(instructionsRegion(bucketSection("No project"))).toBeNull();

    // The remote copy of the same path is not this machine's project.
    const studio = screen.getByRole("region", { name: /Studio/ });
    expect(instructionsRegion(studio)).toBeNull();

    // The imported index is not a project either, even when opened.
    await userEvent.click(
      screen.getByRole("button", { name: "Expand project Imported sessions (1)" }),
    );
    expect(instructionsRegion(bucketSection("Imported sessions (1)"))).toBeNull();
    expect(readOnePager.mock.calls.map(([id]) => id)).toEqual(["p-alpha"]);
  });

  it("the launcher opens a new-chat draft with the edit request prefilled", async () => {
    list();

    await userEvent.click(await screen.findByRole("link", { name: /Ask Kin to edit…/ }));

    // The same draft "New conversation in Project Alpha" opens, with the
    // request in the URL so a fresh tab still receives it.
    await waitFor(() => expect(locationText()).toContain("/new"));
    expect(getDraftCwd()).toBe("/work/alpha");
    expect(locationText()).toContain("cwd=%2Fwork%2Falpha");
    const search = decodeURIComponent(locationText());
    expect(search).toContain("q=");
    expect(search).toContain("Read the “How to work here” section of ONE_PAGER.md");
  });

  it("the expanded block has no editable control", async () => {
    list();

    const block = await screen.findByRole("region", { name: /^How to work here/ });
    await within(block).findByText(/run make check first/);
    // Reading the text is the promise; changing it happens in a chat.
    expect(within(block).queryByRole("textbox")).toBeNull();
    expect(block.querySelector("textarea")).toBeNull();
    expect(block.querySelector('[contenteditable]:not([contenteditable="false"])')).toBeNull();
  });

  it("keeps the list compact: one caption, a clamped preview and the project in the region name", async () => {
    list();

    const block = await screen.findByRole("region", {
      name: "How to work here · Project Alpha",
    });
    // The cover's lead and footnote are page copy: in the list they only
    // repeated each other and pushed the conversations down.
    expect(within(block).queryByText("Kin receives this when a new chat starts")).toBeNull();
    expect(within(block).queryByText("New chats receive this text as written")).toBeNull();
    const body = await within(block).findByText(/run make check first/);
    expect(body.className).toContain("line-clamp-2");
    // Two lines of body, one launcher, one title row — no third meta line.
    expect(Array.from(block.querySelectorAll("p")).map((p) => p.textContent)).toEqual([
      "- run make check first\n- keep commits small",
    ]);
  });

  it("collapses the empty state to one line, without the not-sent footnote", async () => {
    readOnePager.mockResolvedValue(onePager("# Project Alpha\n\n## 摘要\n\nA summary only.\n"));
    list();

    expect(await screen.findByText("No working instructions yet")).toBeTruthy();
    expect(screen.queryByText("New chats will not receive this section")).toBeNull();
    expect(screen.queryByText("Kin receives this when a new chat starts")).toBeNull();
    expect(screen.getByRole("link", { name: /Ask Kin to write…/ })).toBeTruthy();
  });

  it("the title discloses the clamped body once it is measured to overflow", async () => {
    const restore = stubPreviewOverflow();
    try {
      list();

      const toggle = await screen.findByRole("button", { name: "How to work here" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      const body = await screen.findByText(/run make check first/);
      expect(body.className).toContain("line-clamp-2");

      await userEvent.click(toggle);

      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(body.className).not.toContain("line-clamp-2");
    } finally {
      restore();
    }
  });
});
