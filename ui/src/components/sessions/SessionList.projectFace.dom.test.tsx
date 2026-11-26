// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import { getDraftCwd } from "../../lib/draftChat";
import type { Machine } from "../../lib/devices";
import {
  ensureProject,
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

function list(initial = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
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

/** KIN-CONTINUE-007: the block is one collapsed disclosure line by default. */
async function disclose(scope: HTMLElement = document.body): Promise<HTMLElement> {
  const toggle = await within(scope).findByRole("button", { name: "How to work here" });
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
  return toggle;
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
    // The text is one disclosure click away, not two clamped lines always on.
    await disclose();
    expect(await screen.findByText(/run make check first/)).toBeTruthy();
    expect(screen.getByText("How to work here")).toBeTruthy();
  });

  it("shows the empty sentence and a write launcher when the section is missing", async () => {
    readOnePager.mockResolvedValue(onePager("# Project Alpha\n\n## 摘要\n\nA summary only.\n"));
    list();

    await disclose();
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

    await disclose();
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
    // Both folds stated: KIN-CONTINUE-007's default opens only the newest
    // project, and this test is about which project's answer paints where.
    localStorage.setItem(
      "kin_session_folds",
      JSON.stringify({ "mac-1::/work/alpha": true, "mac-1::/work/beta": false }),
    );
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
    await disclose(bucketSection("Project Beta"));
    await waitFor(() => expect(readOnePager).toHaveBeenCalledWith("p-beta"));
    betaRead.resolve(onePager("## 工作方式\n\n- beta only\n"));
    expect(await screen.findByText(/beta only/)).toBeTruthy();

    // Re-open Alpha: a second read supersedes the first.
    await userEvent.click(screen.getByRole("button", { name: "Expand project Project Alpha" }));
    await disclose(bucketSection("Project Alpha"));
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

    // The remote copy of the same path draws the same heading name, so the
    // local one is looked up inside this machine's section. The pinned bucket
    // is not a project, so the newest real project keeps the default-open fold.
    const thisMachine = screen.getByRole("region", { name: /This machine/ });
    // The heading is named by the project record, which loads after the rows.
    await within(thisMachine).findByRole("button", { name: "Project Alpha" });

    // The local project is the only heading that carries a block and a read.
    await disclose(bucketSection("Project Alpha", thisMachine));
    expect(await screen.findByText(/run make check first/)).toBeTruthy();
    await waitFor(() => expect(readOnePager.mock.calls.map(([id]) => id)).toEqual(["p-alpha"]));
    expect(instructionsRegion(bucketSection("Project Alpha", thisMachine))).toBeTruthy();

    // Pinned and No-project are synthetic buckets: no project record, no block
    // even when opened.
    for (const heading of ["Pinned", "No project"]) {
      const section = bucketSection(heading);
      await userEvent.click(within(section).getByRole("button", { name: /Expand project/ }));
      expect(instructionsRegion(section)).toBeNull();
    }

    // The remote copy of the same path is not this machine's project — opened
    // under Studio's heading, it still carries no block.
    const studio = screen.getByRole("region", { name: /Studio/ });
    await userEvent.click(within(studio).getByRole("button", { name: /Expand project/ }));
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

    await disclose();
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
    await disclose();
    await within(block).findByText(/run make check first/);
    // Reading the text is the promise; changing it happens in a chat.
    expect(within(block).queryByRole("textbox")).toBeNull();
    expect(block.querySelector("textarea")).toBeNull();
    expect(block.querySelector('[contenteditable]:not([contenteditable="false"])')).toBeNull();
  });

  it("keeps the block to one line until it is opened, with no clamp inside", async () => {
    list();

    const block = await screen.findByRole("region", {
      name: "How to work here · Project Alpha",
    });
    // The cover's lead and footnote are page copy: in the list they only
    // repeated each other and pushed the conversations down.
    expect(within(block).queryByText("Kin receives this when a new chat starts")).toBeNull();
    expect(within(block).queryByText("New chats receive this text as written")).toBeNull();
    // Collapsed: one disclosure line, no body copy at all (KIN-CONTINUE-007).
    const toggle = within(block).getByRole("button", { name: "How to work here" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.className).toContain("min-h-11");
    expect(within(block).queryByText(/run make check first/)).toBeNull();
    expect(Array.from(block.querySelectorAll("p"))).toHaveLength(0);

    // Opened: the whole body, with no two-line clamp and no third meta line.
    await userEvent.click(toggle);
    const body = await within(block).findByText(/run make check first/);
    expect(body.className).not.toContain("line-clamp-2");
    expect(Array.from(block.querySelectorAll("p")).map((p) => p.textContent)).toEqual([
      "- run make check first\n- keep commits small",
    ]);
  });

  it("keeps the bucket a leaf section so the project row stays addressable", async () => {
    list();

    const block = await screen.findByRole("region", {
      name: "How to work here · Project Alpha",
    });
    // The row is drawn inside the project bucket's <section>. A nested section
    // stops `section:not(:has(section))` — the journey walker's row selector —
    // from finding the project row, so the block must not be a section itself.
    expect(block.tagName).not.toBe("SECTION");
    expect(bucketSection("Project Alpha").querySelector("section")).toBeNull();
  });

  it("collapses the empty state to one line, without the not-sent footnote", async () => {
    readOnePager.mockResolvedValue(onePager("# Project Alpha\n\n## 摘要\n\nA summary only.\n"));
    list();

    await disclose();
    expect(await screen.findByText("No working instructions yet")).toBeTruthy();
    expect(screen.queryByText("New chats will not receive this section")).toBeNull();
    expect(screen.queryByText("Kin receives this when a new chat starts")).toBeNull();
    expect(screen.getByRole("link", { name: /Ask Kin to write…/ })).toBeTruthy();
  });

  it("offers the disclosure without waiting to measure an overflow", async () => {
    list();

    // The disclosure is part of the block's contract now, not a control that
    // appears only when the body happens to be taller than two clamped lines.
    const toggle = await screen.findByRole("button", { name: "How to work here" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/run make check first/)).toBeNull();

    await userEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const body = await screen.findByText(/run make check first/);
    expect(body.className).not.toContain("line-clamp-2");
  });

  it("keeps the disclosure title and its chevron on one line", async () => {
    list();

    const toggle = await screen.findByRole("button", { name: "How to work here" });
    // The title shares its row with the edit launcher, and at 820 the row is
    // narrower than both labels want. Astryx's content span is a block, so a
    // bare label plus a block SVG stacks the chevron under 工作方式 and adds a
    // line to every expanded project; the label and glyph must ride one
    // nowrap row inside the button, and the glyph must not be squeezed out.
    const row = toggle.querySelector("span.inline-flex");
    expect(row).toBeTruthy();
    expect(row!.className).toContain("items-center");
    expect(row!.className).toContain("whitespace-nowrap");
    const chevron = row!.querySelector("svg");
    expect(chevron).toBeTruthy();
    expect(chevron!.getAttribute("class") ?? "").toContain("shrink-0");
  });
});

describe("the project row's heading (KIN-CONTRACT-001)", () => {
  it("the project name narrows the list to that project instead of leaving the list", async () => {
    const user = userEvent.setup();
    const createProject = vi.mocked(ensureProject);
    createProject.mockClear();

    // The list's own query survives the narrowing: the heading is a filter,
    // not a departure that would drop search / status / scope.
    list("/sessions?search=Alpha");
    const heading = await screen.findByRole("button", { name: "Project Alpha" });
    await user.click(heading);

    await waitFor(() => expect(locationText()).toBe("/sessions?search=Alpha&project=p-alpha"));
    // The list stayed: its conversation row is still on screen under the
    // narrowed heading, and no project was created to get here.
    expect(screen.getByRole("button", { name: /alpha-work/ })).toBeTruthy();
    expect(createProject).not.toHaveBeenCalled();

    // Enter on the heading is the same activation as a press, and the list
    // stays put. (A search hides the fold, so the chevron is read below on an
    // unfiltered list.)
    cleanup();
    list("/sessions");
    const again = await screen.findByRole("button", { name: "Project Alpha" });
    again.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(locationText()).toBe("/sessions?project=p-alpha"));

    // The chevron is its own control on the same row: it folds the project and
    // never navigates.
    await user.click(screen.getByRole("button", { name: "Collapse project Project Alpha" }));
    expect(locationText()).toBe("/sessions?project=p-alpha");
    expect(screen.getByRole("button", { name: "Expand project Project Alpha" })).toBeTruthy();
  });

  it("a bucket with no local project record folds instead of narrowing, and creates nothing", async () => {
    // No project record owns /work/alpha. There is no id to narrow by, so the
    // heading does what its chevron does; it must not write a project to the
    // machine just to have somewhere to go.
    fixtures.projects = [];
    const createProject = vi.mocked(ensureProject);
    createProject.mockClear();
    list();

    const heading = await screen.findByRole("button", { name: "alpha" });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(heading);

    expect(locationText()).toBe("/sessions");
    expect(createProject).not.toHaveBeenCalled();
    // Folded, not dead: the same heading now offers to expand.
    expect(screen.getByRole("button", { name: "Expand project alpha" })).toBeTruthy();
  });
});
