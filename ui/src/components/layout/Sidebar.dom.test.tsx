// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { listAgentSessionsPage } from "../../api/client";
import type { AgentSession, Project, Task } from "../../api/client";
import Sidebar from "./Sidebar";
import { setLocale } from "../../i18n";

/**
 * KIN-CONTINUE-001: the Mac sidebar draws the one conversation list.
 *
 * The list's internals are shared with the phone page (`SessionList`), so this
 * suite pins only what the sidebar adds around it: one search field, the
 * machine → project → conversation tree from the common model, the project
 * heading as the way into its cover, and a footer whose archive icon opens the
 * archive filter of the same list.
 *
 * KIN-CONTINUE-002: the phone's drawer and dock are gone. The Mac column is
 * still the only list at this width, and it must not grow a phone drawer or a
 * second navigation surface.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  sessions: [] as AgentSession[],
  projects: [] as Project[],
  pending: [] as { task_id: string }[],
  error: null as string | null,
}));

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: fixtures.tasks,
    loaded: true,
    error: fixtures.error,
    pageFull: false,
    loading: false,
  }),
  usePendingResources: () => ({
    data: { approvals: fixtures.pending, questions: [] },
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
    ensureProject: vi.fn(async () => ({ id: "project-1", name: "alpha" })),
    serverVersion: vi.fn().mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" }),
    listMachines: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
      { id: "nas-1", label: "Studio", isSelf: false, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
}));

function viewport(pointer: "fine" | "coarse" = "fine") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query === "(min-width: 768px)"
        ? true
        : query === "(pointer: coarse)"
          ? pointer === "coarse"
          : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function task(id: string, cwd: string, device?: string): Task {
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
    ...(device ? { executing_device_id: device } : {}),
  } as Task;
}

function session(id: string, title: string): AgentSession {
  return {
    id,
    agent_id: "claude-code",
    external_ref: id,
    title,
    cwd: "/work/alpha",
    status: "idle",
    first_seen_at: 0,
    last_seen_at: 0,
    updated_at: 1,
    linked: false,
  } as AgentSession;
}

function project(id: string, name: string, root: string): Project {
  return {
    id,
    name,
    status: "active",
    created_at: 1,
    updated_at: 1,
    last_active_at: 0,
    roots: [root],
  } as unknown as Project;
}

/** The list owns the URL, so a probe reads what it wrote. */
function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function sidebar(
  initialEntries: string[] = ["/"],
  onNewChat: () => void = () => {},
  pendingCount = 0,
) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <LocationProbe />
      <Sidebar
        pendingCount={pendingCount}
        onNewChat={onNewChat}
        onImportExternalSessions={() => {}}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  fixtures.tasks = [];
  fixtures.sessions = [];
  fixtures.projects = [];
  fixtures.pending = [];
  fixtures.error = null;
  viewport();
});

describe("the Mac sidebar list", () => {
  it("has exactly one list search field", () => {
    fixtures.tasks = [task("here", "/work/alpha")];
    render(sidebar());
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
  });

  it("keeps the one sidebar list", () => {
    // KIN-CONTINUE-007 gave the row a second line; it did not give the column
    // a second list. One search field, one row per conversation, and every row
    // is the same two-line `SessionList` row.
    fixtures.tasks = [task("one", "/work/alpha"), task("two", "/work/alpha")];
    render(sidebar());

    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-session-row]"));
    expect(rows.map((row) => row.dataset.sessionRow).sort()).toEqual(["one", "two"]);
    for (const row of rows) {
      expect(row.querySelector("[data-session-title]")).not.toBeNull();
      expect(row.querySelector("[data-session-meta]")).not.toBeNull();
    }
  });

  it("draws machine → project → conversation from the shared model", async () => {
    fixtures.tasks = [task("local-work", "/work/alpha"), task("remote-work", "/srv/beta", "nas-1")];
    render(sidebar());

    const self = screen.getByRole("heading", { name: /This machine/ }).closest("section");
    const remote = screen.getByRole("heading", { name: /Studio/ }).closest("section");

    expect(self?.textContent).toContain("alpha");
    expect(self?.textContent).toContain("local-work");
    expect(self?.textContent).not.toContain("remote-work");

    // KIN-CONTINUE-007 opens only the newest project; the other is a heading
    // with its rows one click away.
    expect(remote?.textContent).toContain("beta");
    expect(remote?.textContent).not.toContain("remote-work");
    await userEvent.click(
      within(remote as HTMLElement).getByRole("button", { name: /Expand project/ }),
    );
    expect(remote?.textContent).toContain("remote-work");
  });

  it("steps the three levels in, and lets size and weight descend with depth", () => {
    fixtures.tasks = [task("local-work", "/work/alpha")];
    render(sidebar());

    // #47: the deepest level used to be the machine, because the project row
    // wore the section-heading style and its gutter matched the conversation's.
    // One step in per level, and type weight descending, makes the tree read as
    // depth. The fine pointer's conversation step is the scale's 12px one since
    // the density pass; the project step is untouched and still 16px.
    // `data-sidebar-indent` names the step without measuring layout.
    const machine = screen.getByRole("heading", { name: /This machine/ });
    expect(machine.className).toContain("text-body");
    expect(machine.className).toContain("font-semibold");

    const projectStep = document.querySelector('[data-sidebar-indent="project"]');
    expect(projectStep).not.toBeNull();
    expect(projectStep?.className).toContain("pl-4");

    const sessionStep = document.querySelector('[data-sidebar-indent="session"]');
    expect(sessionStep).not.toBeNull();
    expect(sessionStep?.className).toContain("pl-3");

    const projectHeading = screen.getByRole("button", { name: "alpha" });
    const projectLabel = Array.from(projectHeading.querySelectorAll("span")).find(
      (node) => node.textContent === "alpha",
    );
    expect(projectLabel?.className).toContain("font-medium");

    const row = document.querySelector('[data-session-row="local-work"]');
    const rowLabel = Array.from(row?.querySelectorAll("span") ?? []).find(
      (node) => node.textContent === "local-work",
    );
    expect(rowLabel?.className).toContain("text-body");
    expect(rowLabel?.className).toContain("font-normal");
  });

  it("draws a project with no loaded conversation as a heading with count 0", async () => {
    fixtures.projects = [project("p-empty", "Empty project", "/work/empty")];
    render(sidebar());

    const heading = await screen.findByRole("button", { name: "Empty project" });
    expect(heading.textContent).toContain("0");
    // The heading is still the way into the project's cover.
    expect(heading).toBeTruthy();
  });

  it("does not resurrect a project archived on this node", async () => {
    // `listProjects` still answers for an archived project; seeding headings
    // from it has to respect the archived list, or archiving one would bring
    // it back on the next page load with no way to tell why.
    fixtures.projects = [
      project("p-live", "Live project", "/work/live"),
      project("p-gone", "Gone project", "/work/gone"),
    ];
    localStorage.setItem("kin_archived_projects", JSON.stringify(["/work/gone"]));
    render(sidebar());

    expect(await screen.findByRole("button", { name: "Live project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Gone project" })).toBeNull();
  });

  it("does not seed headings while a status filter narrows the list", async () => {
    // A status filter asks the daemon for a subset, so a project heading seeded
    // from the unfiltered project records would claim the project has no
    // matching conversation when it may have many outside this page.
    fixtures.projects = [project("p-empty", "Empty project", "/work/empty")];
    render(sidebar(["/sessions?status=failed"]));

    expect(screen.getByRole("button", { name: /Failed/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Empty project" })).toBeNull());
  });

  it("does not seed headings over a failed list load", async () => {
    // A failed feed means the daemon did not answer; empty headings next to
    // the error would look like projects that lost their conversations.
    fixtures.projects = [project("p-empty", "Empty project", "/work/empty")];
    fixtures.error = "boom";
    render(sidebar());

    expect(await screen.findByText("Could not load chats")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Empty project" })).toBeNull();
  });

  it("writes the list search to its own param, leaving prefill and find seed alone", async () => {
    // The list is mounted on `/new` (the sidebar) and beside the open
    // conversation. `?q=` is the composer's prefill and `?find=` is the
    // transcript's find seed, so the list needs a name of its own.
    render(sidebar(["/new?q=draft&find=seed"]));

    await userEvent.type(screen.getByRole("searchbox"), "alpha");

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain("search=alpha"),
    );
    // The writer copies the route's other params: the composer's prefill and
    // the transcript's find seed belong to the page being read, not to this
    // list, and a rebuild from scratch would silently delete them.
    expect(screen.getByTestId("location").textContent).toContain("q=draft");
    expect(screen.getByTestId("location").textContent).toContain("find=seed");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("alpha");
  });

  it("re-reads imported sessions when another surface changes them", async () => {
    // Importing lives in the footer, in settings, and on an imported session's
    // own page. The list no longer receives a snapshot from the shell, so the
    // event those surfaces publish is the only thing that refreshes the fold.
    render(sidebar());

    const calls = vi.mocked(listAgentSessionsPage);
    await waitFor(() => expect(calls.mock.calls.length).toBeGreaterThan(0));
    const before = calls.mock.calls.length;
    window.dispatchEvent(new Event("kin:agent-sessions-changed"));
    await waitFor(() => expect(calls.mock.calls.length).toBeGreaterThan(before));
  });

  it("ignores an imported-session read that lands after a newer one", async () => {
    // A manual import publishes `changed` while the first read is still out.
    // The pre-import answer must not overwrite the list the import refreshed.
    const pending: Array<(page: { items: AgentSession[]; next_cursor?: string }) => void> = [];
    vi.mocked(listAgentSessionsPage).mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    try {
      render(sidebar());
      await waitFor(() => expect(pending).toHaveLength(1));

      window.dispatchEvent(new Event("kin:agent-sessions-changed"));
      await waitFor(() => expect(pending).toHaveLength(2));

      await act(async () => {
        pending[1]?.({
          items: [session("new-1", "New one"), session("new-2", "New two")],
          next_cursor: undefined,
        });
      });
      expect(
        await screen.findAllByRole("button", { name: /Imported sessions \(2\)/ }),
      ).toHaveLength(2);

      await act(async () => {
        pending[0]?.({ items: [session("old", "Old")], next_cursor: undefined });
      });
      expect(screen.getAllByRole("button", { name: /Imported sessions \(2\)/ })).toHaveLength(2);
    } finally {
      vi.mocked(listAgentSessionsPage)
        .mockReset()
        .mockImplementation(async () => ({
          items: fixtures.sessions,
          next_cursor: undefined,
        }));
    }
  });

  it("keeps the list's search and filters when a conversation opens", async () => {
    // The sidebar is mounted for the whole session, but it reads its state
    // from the current route. Navigating with a bare pathname cleared the
    // search, so finding a second match meant retyping it.
    fixtures.tasks = [task("only", "/work/alpha")];
    render(sidebar(["/sessions?search=onl&status=succeeded&scope=active&find=seed&q=draft"]));

    await userEvent.click(screen.getByRole("button", { name: /^only ·/ }));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain("/tasks/only"),
    );
    const location = screen.getByTestId("location").textContent ?? "";
    expect(location).toContain("search=onl");
    expect(location).toContain("status=succeeded");
    expect(location).toContain("scope=active");
    expect(location).not.toContain("find=");
    expect(location).not.toContain("q=");
  });

  it("keeps the inbox reachable and shows how much is waiting there", () => {
    // The Mac sidebar must not lose the one destination that finds an agent
    // blocked on a person. The count is the badge, and the accessible name
    // includes it so the number is not sight-only.
    render(sidebar(["/"], () => {}, 3));
    const inbox = screen.getByRole("link", { name: "Inbox (3)" });
    expect(inbox.getAttribute("href")).toBe("/inbox");
    expect(inbox.textContent).toContain("3");
  });

  it("keeps two machines' copies of the same path apart", async () => {
    // Two machines can work in /work/shared. The Hub's project record, its pin
    // and its archive are this machine's filesystem facts, so the remote copy
    // must not be treated as the local project — while "new session" in it must
    // still aim the draft at the remote machine. The record is also what lets
    // the local heading narrow the list, so the fixture carries one.
    fixtures.projects = [project("p-shared", "shared", "/work/shared")];
    fixtures.tasks = [
      task("local-work", "/work/shared"),
      task("remote-work", "/work/shared", "nas-1"),
    ];
    render(sidebar());

    expect(screen.getAllByRole("button", { name: "shared" })).toHaveLength(2);
    const self = screen
      .getByRole("heading", { name: /This machine/ })
      .closest("section") as HTMLElement;
    const remote = screen
      .getByRole("heading", { name: /Studio/ })
      .closest("section") as HTMLElement;

    // The narrowing control needs the local project record, which loads on a
    // live read after the first paint.
    expect(
      await within(self).findByRole("button", { name: "Show only this project" }),
    ).toBeTruthy();
    expect(within(self).getByRole("button", { name: "Pin project" })).toBeTruthy();
    expect(within(remote).queryByRole("button", { name: "Show only this project" })).toBeNull();
    expect(
      (
        within(remote).getByRole("button", {
          name: "Show only this project (this machine only)",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(within(remote).queryByRole("button", { name: "Pin project" })).toBeNull();

    // The remote heading folds its project instead of opening the local cover.
    await userEvent.click(within(remote).getByRole("button", { name: "shared" }));
    expect(screen.getByTestId("location").textContent).toBe("/");

    await userEvent.click(
      within(remote).getByRole("button", { name: "New conversation in shared" }),
    );
    await waitFor(() => expect(localStorage.getItem("kin_draft_cwd")).toBe("/work/shared"));
    expect(localStorage.getItem("kin_draft_machine")).toBe("nas-1");

    // The local copy is the same path with no machine: an empty value clears
    // whatever remote choice came before it.
    const remoteSection = screen
      .getByRole("heading", { name: /Studio/ })
      .closest("section") as HTMLElement;
    await userEvent.click(
      within(remoteSection).getByRole("button", { name: /New conversation in shared/ }),
    );
    const localSection = screen
      .getByRole("heading", { name: /This machine/ })
      .closest("section") as HTMLElement;
    await userEvent.click(
      within(localSection).getByRole("button", { name: "New conversation in shared" }),
    );
    await waitFor(() => expect(localStorage.getItem("kin_draft_machine")).toBeNull());
    expect(localStorage.getItem("kin_draft_cwd")).toBe("/work/shared");
  });

  it("keeps the list's search when a project heading narrows the list", async () => {
    // The heading is a navigation too, and it goes through the same helper:
    // a bare path there would clear the query just like a row tap did. It now
    // narrows this one list (`?project=`) instead of opening the retired cover.
    fixtures.projects = [project("p-cover", "Cover project", "/work/cover")];
    fixtures.tasks = [task("cov-chat", "/work/cover")];
    render(sidebar(["/sessions?search=cov"]));

    await userEvent.click(await screen.findByRole("button", { name: "cover" }));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain("project=p-cover"),
    );
    const location = screen.getByTestId("location").textContent ?? "";
    expect(location).toContain("/sessions");
    expect(location).toContain("search=cov");
  });

  it("puts the waiting count on the conversation row that owns it", () => {
    fixtures.tasks = [task("only", "/work/alpha")];
    fixtures.pending = [{ task_id: "only" }, { task_id: "only" }, { task_id: "only" }];
    render(sidebar());
    expect(screen.getByRole("button", { name: /only · .*3 awaiting approval/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^3 awaiting approval$/ })).toBeNull();
  });

  it("remembers a project fold by machine and project", async () => {
    fixtures.tasks = [task("only", "/work/alpha")];
    const { unmount } = render(sidebar());

    await userEvent.click(screen.getByRole("button", { name: /Collapse project/ }));
    expect(screen.queryByRole("button", { name: /only ·/ })).toBeNull();
    expect(localStorage.getItem("kin_session_folds")).toContain('"mac-1::/work/alpha":false');
    unmount();

    render(sidebar());
    expect(screen.getByRole("button", { name: /Expand project/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /only ·/ })).toBeNull();
  });

  it("folds each machine's imported sessions under one trailing count", async () => {
    fixtures.tasks = [task("native", "/work/alpha")];
    fixtures.sessions = [session("imp-1", "Old Claude chat"), session("imp-2", "Another chat")];
    render(sidebar());

    const trigger = await screen.findByRole("button", { name: "Imported sessions (2)" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Old Claude chat/ })).toBeNull();

    await userEvent.click(trigger);
    expect(await screen.findByRole("button", { name: /Old Claude chat/ })).toBeTruthy();
  });

  it("names the column and keeps new chat in its header", () => {
    // The prototype's column starts with 对话 beside 新建, not with a
    // full-width button. The heading is what tells the 304px column what it is
    // in an area whose name already sits on the rail.
    render(sidebar());

    const heading = screen.getByRole("heading", { name: "Chats" });
    const newChat = screen.getByRole("button", { name: /New chat/ });
    expect(heading.parentElement).toBe(newChat.parentElement);
    expect(newChat.textContent).toContain("⌘N");
  });

  it("labels the footer's list utilities instead of leaving icons alone", () => {
    render(sidebar(["/"], () => {}, 3));

    for (const name of ["Inbox (3)", "Archived"]) {
      const link = screen.getByRole("link", { name });
      expect(link.textContent).toContain(name.replace(" (3)", ""));
    }
    const importButton = screen.getByRole("button", { name: /Import Agent sessions/i });
    expect(importButton.textContent).toContain("Import Agent sessions");
  });

  it("floats a project's hover actions so the title keeps the row's width", () => {
    // Four 24px buttons held a column of their own at rest, so every 304px
    // sidebar row truncated to the same “[seed] Projec… 0”. Out of the flow,
    // the title and its count get the width; hover or focus brings them back
    // over the row's tail.
    fixtures.tasks = [task("one", "/work/alpha")];
    render(sidebar());

    const pin = screen.getByRole("button", { name: "Pin project" });
    const actions = pin.parentElement as HTMLElement;
    expect(actions.className).toContain("absolute");
    expect(actions.className).toContain("opacity-0");
    expect(actions.className).toContain("group-hover/proj:opacity-100");
    expect(actions.className).toContain("focus-within:opacity-100");
    // The wrapper alone hides and reveals the bar. A button that also faded
    // itself in on focus drew an opaque box over the count while its siblings
    // stayed invisible; revealing the wrapper shows every action at once.
    expect(pin.className).not.toContain("opacity-0");
    expect(pin.className).not.toContain("focus:opacity-100");
    expect(pin.className).not.toContain("group-hover/proj:opacity-100");
  });

  it("keeps the phone's drawer and dock off the Mac column", () => {
    // KIN-CONTINUE-002: one navigation surface per width. The Mac column has
    // its list and footer; a menu trigger or the phone's footer would be a
    // second surface in the same window.
    fixtures.tasks = [task("only", "/work/alpha")];
    render(sidebar());

    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    expect(document.querySelector("[data-phone-footer]")).toBeNull();
    expect(document.querySelector("[data-kin-edge-back]")).toBeNull();
  });

  it("keeps import and the archive in one row under the list", () => {
    fixtures.tasks = [task("only", "/work/alpha")];
    render(sidebar());

    const importButton = screen.getByRole("button", { name: /Import Agent sessions/i });
    expect(importButton.closest("[data-sidebar-footer]")).not.toBeNull();

    const archived = screen.getByRole("link", { name: "Archived" });
    expect(archived.getAttribute("href")).toBe("/sessions?scope=archived");
    // The row is the list's own foot: the area destinations moved to the rail,
    // and what stays here is what filters or feeds this list.
    expect(archived.closest("[data-sidebar-footer]")).toBe(
      importButton.closest("[data-sidebar-footer]"),
    );
  });

  it("adds no per-device new action in the Mac sidebar", () => {
    // KIN-CONTINUE-004 gives each machine heading a new-chat action and orders
    // machines by last activity on the phone. Neither belongs here: the column
    // keeps its header's New chat, its always-visible search field, and its
    // own order (this machine first) even when the remote machine was used
    // more recently.
    fixtures.tasks = [
      { ...task("local-old", "/work/alpha"), created_at: 1 },
      { ...task("remote-new", "/srv/beta", "nas-1"), created_at: 500 },
    ];
    render(sidebar());

    expect(screen.queryByRole("button", { name: /New chat on/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Search chats" })).toBeNull();
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    const headings = screen
      .getAllByRole("heading", { level: 2, name: /This machine|Studio/ })
      .map((node) => node.textContent);
    expect(headings[0]).toContain("This machine");
    expect(headings[1]).toContain("Studio");
  });
});

/**
 * An iPad gets the desktop layout at ≥768px, so a width query says "wide"
 * there — but its pointer is a finger. The overflow is therefore keyed on the
 * pointer, not the width: a wide touch screen gets the project action sheet,
 * a mouse keeps the hover-revealed controls.
 */
describe("the sidebar's pointer shapes", () => {
  it("gives a coarse pointer the action sheet instead of hover-only controls", () => {
    viewport("coarse");
    fixtures.tasks = [task("one", "/work/alpha")];
    render(sidebar());

    expect(screen.queryByRole("button", { name: "One-Pager cover" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pin project" })).toBeNull();
    expect(screen.getByRole("button", { name: "Project actions" })).toBeTruthy();
  });

  it("gives the fold chevron a finger-sized target", () => {
    viewport("coarse");
    fixtures.tasks = [task("one", "/work/alpha")];
    render(sidebar());

    const chevron = screen.getByRole("button", { name: "Collapse project alpha" });
    expect(chevron.className).toContain("min-h-11 w-11");
  });

  it("keeps the hover-revealed controls for a mouse at the same width", async () => {
    viewport("fine");
    fixtures.projects = [project("p-alpha", "alpha", "/work/alpha")];
    fixtures.tasks = [task("one", "/work/alpha")];
    render(sidebar());

    expect(await screen.findByRole("button", { name: "Show only this project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pin project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove from sidebar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Project actions" })).toBeNull();
  });

  it("gives the list column's own controls a 44px target on a coarse pointer", () => {
    // The 820px iPad draws the desktop shell, so the width says "Mac" while
    // the pointer is a thumb. The pointer decides the density of the column's
    // own controls, not the width.
    viewport("coarse");
    fixtures.tasks = [task("one", "/work/alpha")];
    const { unmount } = render(sidebar());

    const controls = () => [
      screen.getByRole("button", { name: /New chat/ }),
      screen.getByRole("button", { name: "Import Agent sessions" }),
      screen.getByRole("link", { name: "Inbox" }),
      screen.getByRole("link", { name: "Archived" }),
    ];
    for (const control of controls()) {
      expect(control.className).toContain("h-11");
      expect(control.className).toContain("min-h-11");
    }

    // A mouse at the same desktop width keeps today's 32px density.
    unmount();
    viewport("fine");
    render(sidebar());
    for (const control of controls()) {
      expect(control.className).toContain("h-8");
      expect(control.className).not.toContain("h-11");
    }
  });

  it("starts a new chat without handing the shell a click event", async () => {
    // The shell's entry point reads a literal `true` as "the page was already
    // asked"; a click event passed straight through would skip the guard.
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    render(sidebar(["/"], onNewChat));

    await user.click(screen.getByRole("button", { name: /New chat/ }));

    expect(onNewChat.mock.calls).toEqual([[]]);
  });
});
