// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppShell from "./AppShell";
import SessionsPage from "../../pages/SessionsPage";
import { setLocale } from "../../i18n";
import { useLeaveGuard } from "../../hooks/useLeaveGuard";
import { resetLeaveGuard } from "../../lib/leaveGuard";
import type { AgentSession, Project, Task } from "../../api/client";

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
 * - Routines, Agent Ops and settings push over the list and return in one
 *   step, with focus back on the entry that opened them.
 * - A conversation pushes over the list; the edge swipe returns, with focus
 *   back on the row.
 * - A cold deep link synthesizes the list as its parent, so Back cannot strand
 *   the reader or leave the app.
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
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
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
function GuardedPage({ canLeave }: { canLeave: () => boolean }) {
  useLeaveGuard(canLeave);
  return <div>guarded page</div>;
}

function routes() {
  return (
    <Routes>
      <Route path="/sessions" element={<SessionsPage />} />
      <Route path="/new" element={<div>draft page</div>} />
      <Route path="/routines" element={<div>routines page</div>} />
      <Route path="/agents" element={<div>agents page</div>} />
      <Route path="/settings" element={<div>settings page</div>} />
      <Route path="/tasks/:id" element={<div>conversation page</div>} />
      <Route path="/projects/:id" element={<div>project page</div>} />
      <Route path="/guarded" element={<GuardedPage canLeave={guard.current} />} />
    </Routes>
  );
}

function shell(initialEntries: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AppShell pendingApprovals={[]}>{routes()}</AppShell>
    </MemoryRouter>,
  );
}

function pointer(node: Element, type: string, clientX: number) {
  fireEvent(
    node,
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: 20,
      button: 0,
    }),
  );
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

describe("the phone's one navigation surface", () => {
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

    const archived = screen.getByRole("link", { name: "Archived" });
    expect(archived.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector("[data-phone-footer]")).toBeTruthy();
    // Same page: the header's search and the list are still here.
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  it("keeps the reader's search when switching to the archive scope", () => {
    shell(["/sessions?search=alpha"]);

    const href = screen.getByRole("link", { name: "Archived" }).getAttribute("href") ?? "";
    expect(href).toContain("scope=archived");
    expect(href).toContain("search=alpha");
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

      await user.click(screen.getByRole("button", { name: "Back" }));
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
    it(`synthesizes the list as the parent of a cold ${path}`, async () => {
      const user = userEvent.setup();
      shell([path]);
      expect(screen.getByText(text)).toBeTruthy();

      await user.click(screen.getByRole("button", { name: "Back" }));
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

  it("leaves the project page its own, guarded back control", () => {
    // The project page's back link is the only one that asks before discarding
    // an edited summary. A shell back above it would leave silently, so the
    // shell draws no bar on that route (KIN-CONTINUE-002, blocker fix).
    shell(["/projects/p1"]);
    expect(screen.getByText("project page")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
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

  it("synthesizes the list as the parent of a cold conversation", async () => {
    shell(["/tasks/x"]);
    expect(screen.getByText("conversation page")).toBeTruthy();

    edgeBack();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy());
    expect(document.querySelector("[data-phone-footer]")).toBeTruthy();
  });
});
