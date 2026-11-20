// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import AppShell from "./AppShell";
import Sheet from "../mobile/Sheet";
import SessionsPage from "../../pages/SessionsPage";
import ProjectDetailPage from "../../pages/ProjectDetailPage";
import { setLocale } from "../../i18n";
import { useLeaveGuard } from "../../hooks/useLeaveGuard";
import { resetLeaveGuard } from "../../lib/leaveGuard";
import type { AgentSession, Approval, Project, Task, UserQuestion } from "../../api/client";

/**
 * KIN-CONTINUE-002: the phone has one navigation surface.
 *
 * KIN-CONTINUE-003 rows 3, 4, 6: the four phone stacks, archived inside
 * Conversations, and returns across areas.
 *
 * The real shell, the real list page and the real footer are rendered at phone
 * width. These tests pin what the story promised and a unit test of any one
 * component cannot see:
 *
 * - `/sessions` carries search, the list, four footer entries and the new-chat
 *   button; there is no drawer trigger, no drawer, and no dock.
 * - Archive is a scope of the same page, not a second screen.
 * - Routines, Agent Ops and settings replace the peer root. Chats returns the
 *   step, with focus back on the entry that opened them.
 * - A conversation pushes over the list; the edge swipe returns, with focus
 *   back on the row.
 * - A cold detail deep link gets a list parent; a cold root is already a peer.
 */

const guard = vi.hoisted(() => ({ current: (() => true) as () => boolean }));

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  sessions: [] as AgentSession[],
  projects: [] as Project[],
  pending: { approvals: [] as Approval[], questions: [] as UserQuestion[] },
  loaded: true,
  error: null as string | null,
}));

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: fixtures.tasks,
    loaded: fixtures.loaded,
    error: fixtures.error,
    pageFull: false,
    loading: false,
  }),
  useTaskResource: () => ({ data: { task: undefined }, loaded: true, error: null }),
  usePendingResources: () => ({
    data: fixtures.pending,
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
    getProject: vi.fn(async (id: string) => ({
      id,
      name: "alpha",
      mode: "ship",
      status: "active",
      roots: ["/work/alpha"],
      created_at: 1,
      updated_at: 2,
      last_active_at: 3,
    })),
    getOnePager: vi.fn(async (id: string) => ({
      project_id: id,
      markdown: "Original summary",
      updated_at: 1,
    })),
    listProjectArtifacts: vi.fn(async () => []),
    getProjectPulse: vi.fn(async () => null),
    listRoutines: vi.fn(async () => ({ routines: [] })),
    isAuthenticated: vi.fn(() => true),
    listProjects: vi.fn(async () => fixtures.projects),
    ensureProject: vi.fn(async () => ({ id: "project-1", name: "alpha" })),
    getSettings: vi.fn(async () => null),
    getUsageSummary: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    serverVersion: vi.fn().mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" }),
    listMachines: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "Test node", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
}));

vi.mock("../../hooks/useMinWidth", () => ({
  useMinWidth: () => false,
}));

vi.mock("../../hooks/useAgentSessionImport", () => ({
  useAgentSessionImport: () => ({
    importing: false,
    importEveryMachine: vi.fn(async () => ({ imported: 0, providers: {} })),
  }),
  importsInFlight: () => false,
}));

vi.mock("../../hooks/useApprovalDecision", () => ({
  useApprovalDecision: () => ({ busy: {}, decide: vi.fn() }),
}));

vi.mock("../../lib/desktop", () => ({
  isKinDesktop: () => false,
}));

vi.mock("../terminal/TerminalPanel", () => ({
  default: () => null,
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

/** A screen that refuses to be left, the way a dirty form or summary does. */
function GuardedPage({ label = "guarded page" }: { label?: string }) {
  useLeaveGuard(() => guard.current(), true);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open tab modal
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Tab modal">
        sheet content
      </Sheet>
      <div data-phone-tabs tabIndex={0}>
        horizontal scroller
      </div>
      {label}
    </div>
  );
}

/** The conversation's own link to another destination, which has no footer. */

/** The route's own address, so a tab return can be asserted with its params. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="phone-location">{`${location.pathname}${location.search}`}</div>;
}

function routes() {
  return (
    <>
      <Routes>
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/new" element={<div>draft page</div>} />
        <Route path="/routines" element={<GuardedPage label="routines page" />} />
        <Route path="/guarded-tab" element={<GuardedPage />} />
        <Route path="/agents" element={<div>agents page</div>} />
        <Route path="/settings" element={<div>settings page</div>} />
        <Route path="/inbox" element={<div>inbox page</div>} />
        <Route path="/tasks/:id" element={<div>conversation page</div>} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/guarded" element={<GuardedPage />} />
      </Routes>
      <LocationProbe />
    </>
  );
}

function shell(initialEntries: string[], pendingApprovals: Approval[] = []) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AppShell pendingApprovals={pendingApprovals}>{routes()}</AppShell>
    </MemoryRouter>,
  );
}

function approval(id: string, taskId: string): Approval {
  return {
    id,
    task_id: taskId,
    kind: "tool",
    payload: {},
    decision: "pending",
    created_at: 1,
  };
}

function question(id: string, taskId: string): UserQuestion {
  return {
    id,
    task_id: taskId,
    payload: { question: "Which way?", options: [{ label: "A" }, { label: "B" }] },
    status: "pending",
    created_at: 1,
  } as UserQuestion;
}

/** A finger travelling sideways across `target`, the gesture tab swipe used. */
function drag(target: Element, start = 200, end = 90): void {
  pointer(target, "pointerdown", start);
  pointer(target, "pointermove", end);
  pointer(target, "pointerup", end);
}

function pointer(node: Element, type: string, clientX: number, clientY = 20, timeStamp?: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  });
  Object.assign(event, { pointerId: 1, pointerType: "touch", isPrimary: true });
  if (timeStamp !== undefined) {
    Object.defineProperty(event, "timeStamp", { configurable: true, value: timeStamp });
  }
  fireEvent(node, event);
}

function edgeBack(): void {
  const edge = document.querySelector("[data-kin-edge-back]");
  expect(edge).toBeTruthy();
  pointer(edge as Element, "pointerdown", 5);
  pointer(edge as Element, "pointermove", 90);
  pointer(edge as Element, "pointerup", 90);
}

beforeEach(() => {
  resetLeaveGuard();
  guard.current = () => true;
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [];
  fixtures.sessions = [];
  fixtures.projects = [];
  fixtures.pending = { approvals: [], questions: [] };
  fixtures.loaded = true;
  fixtures.error = null;
  viewport();
});

describe("no horizontal tab switching", () => {
  it("a horizontal drag on an area root changes no screen", () => {
    shell(["/sessions"]);
    drag(document.querySelector("main") as HTMLElement, 200, 90);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    expect(screen.queryByText("routines page")).toBeNull();

    cleanup();
    shell(["/routines"]);
    drag(document.querySelector("main") as HTMLElement, 200, 90);
    expect(screen.getByText("routines page")).toBeTruthy();
    expect(screen.queryByText("agents page")).toBeNull();
  });

  it("a horizontal drag never opens a neighbouring area", () => {
    shell(["/routines"]);
    const main = document.querySelector("main") as HTMLElement;
    // Right-to-left would have opened Agent Ops.
    drag(main, 200, 90);
    expect(screen.getByText("routines page")).toBeTruthy();
    expect(screen.queryByText("agents page")).toBeNull();
    // Left-to-right would have opened Chats.
    drag(main, 90, 200);
    expect(screen.getByText("routines page")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Chats" })).toBeNull();
  });

  it("leaves vertical pan and pinch-zoom to the browser, never a horizontal page", () => {
    shell(["/sessions"]);
    const main = document.querySelector("main") as HTMLElement;
    expect(main.style.touchAction).toContain("pan-y");
    expect(main.style.touchAction).toContain("pinch-zoom");
    expect(main.style.touchAction).not.toContain("pan-x");
  });
});

describe("the Chats tab's waiting count", () => {
  it("carries how many things wait on the reader", () => {
    fixtures.pending = {
      approvals: [approval("a1", "t1"), approval("a2", "t2")],
      questions: [question("q1", "t1")],
    };
    shell(["/sessions"]);
    const chats = screen.getByRole("link", { name: /Chats/ });
    expect(chats.textContent).toContain("3");
    expect(within(chats).getByText("3 waiting for you")).toBeTruthy();
    // The count is a mark inside the link, not a second control.
    expect(chats.querySelectorAll("button")).toHaveLength(0);
  });

  it("carries no badge when nothing waits", () => {
    shell(["/sessions"]);
    const chats = screen.getByRole("link", { name: "Chats" });
    expect(chats.textContent).not.toContain("waiting for you");
  });

  it("the tab bar stays on area roots only", () => {
    shell(["/sessions", "/tasks/x"]);
    expect(screen.getByText("conversation page")).toBeTruthy();
    expect(document.querySelector("[data-phone-footer]")).toBeNull();
  });
});

describe("the four equal phone tabs", () => {
  it("keeps Chats, Routines, Agent Ops and Settings on every root page", () => {
    shell(["/routines"]);
    const footer = document.querySelector("[data-phone-footer]");
    expect(footer).toBeTruthy();
    expect(screen.getByRole("link", { name: "Chats" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Routines" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Agent Ops" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Archived" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(document.querySelector("[data-kin-edge-back]")).toBeNull();
  });

  for (const [path, text, current] of [
    // E4a: Agent Ops is a tab of Settings now, not a root of its own.
    ["/settings?tab=operations", "settings page", "Agent Ops"],
    ["/settings", "settings page", "Settings"],
  ] as const) {
    it(`keeps the tabs on ${path}`, () => {
      shell([path]);
      expect(screen.getByText(text)).toBeTruthy();
      expect(document.querySelector("[data-phone-footer]")?.querySelectorAll("a")).toHaveLength(4);
      // The highlighted tab follows the tab= param, not only the pathname.
      const marked = document.querySelectorAll("[data-phone-footer] a[aria-current='page']");
      expect(marked).toHaveLength(1);
      expect(marked[0].textContent).toContain(current);
    });
  }
});
describe("each tab returns to its own last view", () => {
  it("returns each tab to where the reader last was in that area", async () => {
    const user = userEvent.setup();
    shell(["/settings?tab=operations"]);
    expect(screen.getByTestId("phone-location").textContent).toBe("/settings?tab=operations");

    await user.click(screen.getByRole("link", { name: "Routines" }));
    await waitFor(() => expect(screen.getByText("routines page")).toBeTruthy());

    // Agent Ops is a peer entry, not a view of Settings: clicking Settings
    // must land on Settings, not reopen the operations panel, and the clicked
    // tab must be the only current one.
    await user.click(screen.getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(screen.getByTestId("phone-location").textContent).toBe("/settings"));
    let current = document.querySelectorAll("[data-phone-footer] a[aria-current='page']");
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Settings");

    // The operations URL is still Agent Ops' own memory, not Settings'.
    await user.click(screen.getByRole("link", { name: "Agent Ops" }));
    await waitFor(() =>
      expect(screen.getByTestId("phone-location").textContent).toBe("/settings?tab=operations"),
    );
    current = document.querySelectorAll("[data-phone-footer] a[aria-current='page']");
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Agent Ops");

    // The same journey from the other direction: the machine selected on
    // Routines survives a trip through Settings.
    cleanup();
    sessionStorage.clear();
    const second = userEvent.setup();
    shell(["/routines?device=m2"]);
    expect(screen.getByTestId("phone-location").textContent).toBe("/routines?device=m2");

    await second.click(screen.getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(screen.getByText("settings page")).toBeTruthy());

    await second.click(screen.getByRole("link", { name: "Routines" }));
    await waitFor(() =>
      expect(screen.getByTestId("phone-location").textContent).toBe("/routines?device=m2"),
    );
  });

  it("draws one heading per phone root", () => {
    for (const [path, name] of [
      ["/sessions", "Chats"],
      ["/routines", "Routines"],
      ["/agents", "Agent Ops"],
      ["/settings", "Settings"],
    ] as const) {
      cleanup();
      shell([path]);
      const headings = screen.getAllByRole("heading", { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0].textContent).toBe(name);
    }
    cleanup();
  });
});

describe("list roots and destinations", () => {
  it("keeps New chat in the list header as a secondary action", () => {
    shell(["/sessions"]);

    const button = screen.getByRole("button", { name: "New chat" });
    expect(button.closest("header")).toBeTruthy();
    expect(button.getAttribute("data-phone-return")).toBe("new");
    expect(button.className).toContain("kin-btn-secondary");
    expect(button.className).not.toContain("kin-btn-primary");
    expect(button.className).not.toContain("bg-kin-text");
    expect(button.className).not.toContain("bg-kin-blue");

    // One entry only: the list no longer floats a second copy over the footer.
    expect(document.querySelectorAll("[data-phone-return='new']")).toHaveLength(1);
  });

  it("is the list page: search, four entries, new chat; no drawer or dock", () => {
    shell(["/sessions"]);

    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    // KIN-CONTINUE-004: the search field is disclosed by the magnifier, which
    // is the page's search marker while the field is closed.
    expect(screen.getByRole("button", { name: "Search chats" })).toBeTruthy();
    const footer = document.querySelector("[data-phone-footer]");
    expect(footer).toBeTruthy();
    expect(footer?.querySelectorAll("a")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    expect(document.querySelector("[data-phone-dock]")).toBeNull();
    expect(screen.queryByText("Import Agent sessions")).toBeNull();
    expect(document.querySelector("[data-phone-return='new']")).toBeTruthy();
  });

  it("treats archive as a scope of the same page", () => {
    shell(["/sessions?scope=archived"]);

    expect(screen.getByRole("link", { name: "Chats" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Chats" }).getAttribute("href")).toContain(
      "scope=archived",
    );
    expect(document.querySelector("[data-phone-footer]")).toBeTruthy();
    // Same page: the header's search magnifier and the list are still here.
    expect(screen.getByRole("button", { name: "Search chats" })).toBeTruthy();
  });

  it("keeps the reader's search when switching to the archive scope", () => {
    shell(["/sessions?search=alpha"]);

    const entry = screen.getByRole("link", { name: "Chats" });
    expect(entry.getAttribute("aria-current")).toBe("page");
    expect(entry.getAttribute("href")).toContain("search=alpha");
    expect(screen.queryByRole("link", { name: "Archived" })).toBeNull();
  });
});

describe("destinations and back", () => {
  for (const [label, text] of [
    ["Routines", "routines page"],
    // Agent Ops opens the operations tab inside Settings (E4a).
    ["Agent Ops", "settings page"],
    ["Settings", "settings page"],
  ] as const) {
    it(`returns from ${label} to the list with focus on its entry`, async () => {
      const user = userEvent.setup();
      shell(["/sessions"]);

      await user.click(screen.getByRole("link", { name: label }));
      expect(screen.getByText(text)).toBeTruthy();

      await user.click(screen.getByRole("link", { name: "Chats" }));
      await waitFor(() => expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy());
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("link", { name: label })),
      );
    });
  }

  it("returns from a conversation with the row focused", async () => {
    const user = userEvent.setup();
    fixtures.tasks = [task("only", "Yesterday chat")];
    shell(["/sessions"]);

    const row = await screen.findByRole("button", { name: /Yesterday chat/ });
    await user.click(row);
    expect(screen.getByText("conversation page")).toBeTruthy();

    edgeBack();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /Yesterday chat/ })),
    );
  });

  for (const [path, text] of [
    ["/routines", "routines page"],
    ["/settings?tab=operations", "settings page"],
    ["/settings", "settings page"],
  ] as const) {
    it(`opens a cold ${path} with a direct way to the list`, async () => {
      const user = userEvent.setup();
      shell([path]);
      expect(screen.getByText(text)).toBeTruthy();

      await user.click(screen.getByRole("link", { name: "Chats" }));
      await waitFor(() => expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy());
      expect(document.querySelector("[data-phone-footer]")).toBeTruthy();
    });
  }

  it("closes the draft onto the list, not onto the conversation behind it", async () => {
    const user = userEvent.setup();
    // The draft's parent is the list even when a conversation sits behind it.
    // Closing must land on the list, not skip over it into the conversation.
    shell(["/tasks/x", "/new"]);
    expect(screen.getByText("draft page")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy());
    expect(screen.queryByText("conversation page")).toBeNull();
  });

  it("returns focus to the new-chat button when a draft is closed", async () => {
    const user = userEvent.setup();
    shell(["/sessions"]);

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByText("draft page")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector("[data-phone-return='new']")),
    );
  });

  it("leaves the project page its own, guarded back control", async () => {
    // The project page's back link is the only one that asks before discarding
    // an edited summary. A shell back above it would leave silently, so the
    // shell draws no bar on that route (KIN-CONTINUE-002, blocker fix).
    shell(["/sessions", "/projects/p1"]);
    expect(await screen.findByRole("heading", { name: "alpha" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Back" })).toHaveLength(1);
  });

  it("asks before the project page's own back discards an edited One-Pager", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      shell(["/sessions", "/projects/p1"]);
      await screen.findByRole("heading", { name: "alpha" });

      await user.click(screen.getByRole("button", { name: "Edit" }));
      const editor = screen.getByRole("textbox");
      await user.clear(editor);
      await user.type(editor, "Changed but unsaved");

      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(confirm).toHaveBeenCalledWith("Your summary is unsaved. Leave anyway?");
      expect(screen.getByRole("heading", { name: "alpha" })).toBeTruthy();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "Changed but unsaved",
      );

      confirm.mockReturnValue(true);
      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy());
    } finally {
      confirm.mockRestore();
    }
  });

  it("asks the real project page before its edge swipe and ⌘N leave it", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      shell(["/sessions", "/projects/p1"]);
      await screen.findByRole("heading", { name: "alpha" });
      await user.click(screen.getByRole("button", { name: "Edit" }));
      await user.type(screen.getByRole("textbox"), "!");

      edgeBack();
      expect(confirm).toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "alpha" })).toBeTruthy();

      fireEvent.keyDown(window, { key: "n", metaKey: true });
      expect(confirm.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByRole("heading", { name: "alpha" })).toBeTruthy();
      expect(screen.queryByText("draft page")).toBeNull();
    } finally {
      confirm.mockRestore();
    }
  });

  it("asks the page before the header's back leaves it", async () => {
    const user = userEvent.setup();
    const canLeave = vi.fn(() => false);
    guard.current = canLeave;
    shell(["/sessions", "/guarded"]);
    expect(screen.getByText("guarded page")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(canLeave).toHaveBeenCalled();
    expect(screen.getByText("guarded page")).toBeTruthy();
  });

  it("asks the page before the new-chat shortcut leaves it", () => {
    const canLeave = vi.fn(() => false);
    guard.current = canLeave;
    shell(["/sessions", "/guarded"]);

    fireEvent.keyDown(window, { key: "n", metaKey: true });

    expect(canLeave).toHaveBeenCalled();
    expect(screen.getByText("guarded page")).toBeTruthy();
  });

  it("asks the page once when the palette starts a new chat", async () => {
    // The palette row asks before closing, and the shell's new-chat entry
    // point has its own guard for ⌘N and the list's empty state. One
    // departure must be one question: a page guarding with `window.confirm`
    // would otherwise show the same dialog twice (KIN-CONTINUE-002 review).
    const user = userEvent.setup();
    const canLeave = vi.fn(() => true);
    guard.current = canLeave;
    shell(["/sessions", "/guarded"]);
    expect(screen.getByText("guarded page")).toBeTruthy();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await user.click(await screen.findByRole("button", { name: /New chat/ }));

    expect(canLeave).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("draft page")).toBeTruthy());
  });

  it("asks the page before the edge swipe leaves it", () => {
    const canLeave = vi.fn(() => false);
    guard.current = canLeave;
    shell(["/sessions", "/guarded"]);

    edgeBack();

    expect(canLeave).toHaveBeenCalled();
    expect(screen.getByText("guarded page")).toBeTruthy();
  });

  it("does not draw the floating approval over the inbox", () => {
    shell(["/inbox"], [approval("a1", "task-1")]);
    expect(screen.getByText("inbox page")).toBeTruthy();
    // The inbox is the full queue; a floating copy would be the same
    // approvals twice, with the page's own list underneath.
    expect(screen.queryByLabelText("Waiting")).toBeNull();
  });

  it("still floats a waiting approval on every other screen", () => {
    shell(["/settings"], [approval("a1", "task-1")]);
    expect(screen.getByText("settings page")).toBeTruthy();
    expect(screen.getByLabelText("Waiting")).toBeTruthy();
  });

  it("synthesizes the list as the parent of a cold conversation", async () => {
    shell(["/tasks/x"]);
    expect(screen.getByText("conversation page")).toBeTruthy();

    edgeBack();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy());
    expect(document.querySelector("[data-phone-footer]")).toBeTruthy();
  });
});
