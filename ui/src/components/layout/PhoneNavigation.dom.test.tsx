// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppShell from "./AppShell";
import Sheet from "../mobile/Sheet";
import SessionsPage from "../../pages/SessionsPage";
import ProjectDetailPage from "../../pages/ProjectDetailPage";
import { setLocale } from "../../i18n";
import { useLeaveGuard } from "../../hooks/useLeaveGuard";
import { resetLeaveGuard } from "../../lib/leaveGuard";
import type { AgentSession, Approval, Project, Task } from "../../api/client";

/**
 * KIN-CONTINUE-002: the phone has one navigation surface.
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

function routes() {
  return (
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

function tabSwipe(
  start = 200,
  end = 90,
  target = document.querySelector("main") as HTMLElement,
) {
  // The fling contract is instant velocity, so a synthetic move needs a
  // deliberate sample interval. Otherwise an unrelated async list render can
  // turn a 20px "not a swipe" sample into a fast fling on a loaded machine.
  pointer(target, "pointerdown", start, 20, 1000);
  pointer(target, "pointermove", end, 20, 1100);
  pointer(target, "pointerup", end, 20, 1100);
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
  fixtures.loaded = true;
  fixtures.error = null;
  viewport();
});

describe("horizontal tab switching", () => {
  it("moves both ways through the four roots without stacking detail entries", () => {
    shell(["/sessions"]);
    tabSwipe();
    expect(screen.getByText("routines page")).toBeTruthy();
    tabSwipe();
    expect(screen.getByText("agents page")).toBeTruthy();
    tabSwipe();
    expect(screen.getByText("settings page")).toBeTruthy();
    tabSwipe();
    expect(screen.getByText("settings page")).toBeTruthy(); // last tab: no neighbor
    tabSwipe(window.innerWidth - 20, window.innerWidth + 110);
    expect(screen.getByText("agents page")).toBeTruthy();
    tabSwipe(window.innerWidth - 20, window.innerWidth + 110);
    expect(screen.getByText("routines page")).toBeTruthy();
    tabSwipe(window.innerWidth - 20, window.innerWidth + 110);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    tabSwipe(window.innerWidth - 20, window.innerWidth + 110);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("rejects a short move, a vertical scroll and a cancelled gesture", async () => {
    shell(["/sessions"]);
    await waitFor(() => expect(screen.getByRole("searchbox")).toBeTruthy());
    const main = document.querySelector("main") as HTMLElement;
    tabSwipe(200, 180, main);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    pointer(main, "pointerdown", 200, 20);
    pointer(main, "pointermove", 180, 80);
    pointer(main, "pointerup", 180, 80);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    pointer(main, "pointerdown", 200);
    pointer(main, "pointermove", 50);
    pointer(main, "pointercancel", 50);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    // Cancellation leaves the list alone; a direct keyboard activation still
    // follows the link through the separate, accessible footer path.
    await userEvent.click(screen.getByRole("link", { name: "Routines" }));
    expect(screen.getByText("routines page")).toBeTruthy();
  });

  it("does not commit a short horizontal sample as a fling", () => {
    shell(["/sessions"]);
    const main = document.querySelector("main") as HTMLElement;
    pointer(main, "pointerdown", 200, 20, 1000);
    pointer(main, "pointermove", 180, 20, 1200);
    pointer(main, "pointerup", 180, 20, 1200);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("does not let a short diagonal scroll turn into a fling", () => {
    shell(["/sessions"]);
    const main = document.querySelector("main") as HTMLElement;
    pointer(main, "pointerdown", 200, 20, 1000);
    pointer(main, "pointermove", 40, 220, 1100);
    pointer(main, "pointerup", 40, 220, 1100);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("commits a genuinely fast short horizontal sample", () => {
    shell(["/sessions"]);
    const main = document.querySelector("main") as HTMLElement;
    pointer(main, "pointerdown", 200, 20, 1300);
    pointer(main, "pointermove", 180, 20, 1320);
    pointer(main, "pointerup", 180, 20, 1320);
    expect(screen.getByText("routines page")).toBeTruthy();
  });

  it("does not let a conversation row's own swipe change the tab", async () => {
    fixtures.tasks = [task("row", "Row swipe")];
    shell(["/sessions"]);
    const row = await screen.findByRole("button", { name: /Row swipe/ });
    tabSwipe(200, 50, row);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("keeps a swipe that starts on the floating approval card with the card", () => {
    shell(["/sessions"], [approval("a1", "t1")]);
    const card = document.querySelector('aside [role="status"]') as HTMLElement;
    expect(card).toBeTruthy();
    const main = document.querySelector("main") as HTMLElement;
    // The card is the pane's sibling, not its descendant: pointer events only
    // bubble through ancestors, so a gesture here never reaches the tab-swipe
    // listener. This assertion guards that layout, which is the actual
    // protection — `data-phone-swipe` on the pill is only a second net in case
    // the card ever moves inside the pane.
    expect(main.contains(card)).toBe(false);
    tabSwipe(200, 50, card);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
  });

  it("leaves pinch-zoom to the browser while owning single-finger pans", () => {
    shell(["/sessions"]);
    const main = document.querySelector("main") as HTMLElement;
    expect(main.style.touchAction).toContain("pan-y");
    expect(main.style.touchAction).toContain("pinch-zoom");
  });

  it("keeps horizontal scrollers, sheets, secondary fingers and controls with their owners", async () => {
    shell(["/sessions"]);
    const main = document.querySelector("main") as HTMLElement;
    for (const target of main.querySelectorAll("button, input, [data-phone-tabs]")) {
      tabSwipe(280, 100, target as HTMLElement);
      expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    }
    const scroller = document.createElement("div");
    scroller.style.overflowX = "scroll";
    Object.defineProperties(scroller, {
      scrollWidth: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 100 },
    });
    scroller.append(document.createTextNode("native horizontal content"));
    main.append(scroller);
    tabSwipe(300, 110, scroller);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    scroller.remove();
    const footer = document.querySelector("[data-phone-footer]") as HTMLElement;
    tabSwipe(280, 100, footer);
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    tabSwipe();
    expect(screen.getByText("routines page")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open tab modal" }));
    const sheet = await screen.findByRole("dialog", { name: "Tab modal" });
    tabSwipe(300, 110, sheet);
    expect(screen.getByText("routines page")).toBeTruthy();
    // The scrim is portaled outside <main>, not under its role=dialog panel.
    // It must own the touch too, without closing the sheet or switching roots.
    tabSwipe(300, 110, document.querySelector("[data-kin-sheet] .kin-scrim-enter") as HTMLElement);
    expect(screen.getByRole("dialog", { name: "Tab modal" })).toBeTruthy();
    expect(screen.getByText("routines page")).toBeTruthy();
    // The gesture may have started in the background before the Sheet opened.
    // Its whole lifecycle belongs to the overlay stack, even when later moves
    // stay on the underlying <main> rather than in the portaled panel.
    tabSwipe(300, 110, main);
    expect(screen.getByRole("dialog", { name: "Tab modal" })).toBeTruthy();
    expect(screen.getByText("routines page")).toBeTruthy();
    // Once the finger is down on blank content, a second finger must not
    // replace its pointer identity or turn it into a two-finger navigation.
    pointer(main, "pointerdown", 260, 20);
    const second = new MouseEvent("pointerdown", { bubbles: true, clientX: 140, clientY: 20 });
    Object.assign(second, { pointerId: 2, pointerType: "touch", isPrimary: false });
    fireEvent(main, second);
    pointer(main, "pointermove", 80, 20);
    pointer(main, "pointerup", 80, 20);
    expect(screen.getByText("routines page")).toBeTruthy();
    // But the sheet still owns its dismissal, and once it closes the blank
    // root is navigable again.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tab modal" })).toBeNull());
    tabSwipe();
    expect(screen.getByText("agents page")).toBeTruthy();
  });

  it("asks a dirty root before swiping away", () => {
    const canLeave = vi.fn(() => false);
    guard.current = canLeave;
    shell(["/routines"]);
    // The root fixture registers the same canLeave question as the real form.
    tabSwipe();
    expect(canLeave).toHaveBeenCalled();
    expect(screen.getByText("routines page")).toBeTruthy();
    guard.current = () => true;
    tabSwipe();
    expect(screen.getByText("agents page")).toBeTruthy();
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

  for (const [path, text] of [
    ["/agents", "agents page"],
    ["/settings", "settings page"],
  ] as const) {
    it(`keeps the tabs on ${path}`, () => {
      shell([path]);
      expect(screen.getByText(text)).toBeTruthy();
      expect(document.querySelector("[data-phone-footer]")?.querySelectorAll("a")).toHaveLength(4);
    });
  }
});
describe("list roots and destinations", () => {
  it("is the list page: search, four entries, new chat; no drawer or dock", () => {
    shell(["/sessions"]);

    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    expect(screen.getByRole("searchbox")).toBeTruthy();
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
    // Same page: the header's search and the list are still here.
    expect(screen.getByRole("searchbox")).toBeTruthy();
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
    ["Agent Ops", "agents page"],
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
    ["/agents", "agents page"],
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
