// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, MemoryRouter, Route, Routes } from "react-router-dom";
import AppShell from "./AppShell";
import SessionsPage from "../../pages/SessionsPage";
import { setLocale } from "../../i18n";
import { resetLeaveGuard } from "../../lib/leaveGuard";

/**
 * Closing the draft is a return, not a new visit: the list comes back exactly
 * as it was left — search, status and scope included — and the history stack
 * does not gain a second copy of it. A cold `/new` has no list behind it, so
 * its close has to synthesize one instead of leaving the app.
 */

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: [],
    loaded: true,
    error: null,
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
    isAuthenticated: vi.fn(() => true),
    listAgentSessionsPage: vi.fn(async () => ({ items: [], next_cursor: undefined })),
    listAgentSessions: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
    listRoutines: vi.fn(async () => ({ routines: [], has_more: false })),
    listRoutineRuns: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p1", name: "alpha" })),
    getSettings: vi.fn(async () => null),
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
    agents: [],
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

function routes() {
  return (
    <Routes>
      <Route path="/sessions" element={<SessionsPage />} />
      <Route path="/new" element={<div>draft page</div>} />
    </Routes>
  );
}

function memoryShell(initialEntries: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AppShell pendingApprovals={[]}>{routes()}</AppShell>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetLeaveGuard();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  viewport();
});

describe("closing the draft returns to the list that was left", () => {
  it("restores the search and archive scope instead of a bare list", async () => {
    const user = userEvent.setup();
    memoryShell(["/sessions?search=alpha&scope=archived"]);
    const search = await screen.findByRole("searchbox");
    expect((search as HTMLInputElement).value).toBe("alpha");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByText("draft page")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy());
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("alpha");
    expect(screen.getByRole("link", { name: "Chats" }).getAttribute("href")).toContain(
      "scope=archived",
    );
  });

  it("synthesizes the list for a cold /new", async () => {
    const user = userEvent.setup();
    memoryShell(["/new"]);
    expect(screen.getByText("draft page")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy());
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  it("returns with history.back, so the list is not pushed twice", async () => {
    // A real browser history is what the phone's Back and the close control
    // share; MemoryRouter would hide whether close pushed a replacement list
    // entry or actually went back.
    const user = userEvent.setup();
    window.history.replaceState({ idx: 0 }, "", "/sessions?search=alpha&scope=archived");
    render(
      <BrowserRouter>
        <AppShell pendingApprovals={[]}>{routes()}</AppShell>
      </BrowserRouter>,
    );
    await screen.findByRole("searchbox");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    const draftIdx = (window.history.state as { idx: number }).idx;

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.location.search).toBe("?search=alpha&scope=archived");
    // Back, not a new entry: the list sits at the same stack index as before
    // it was left, so a second Back leaves the list rather than showing it again.
    expect((window.history.state as { idx: number }).idx).toBeLessThan(draftIdx);
  });
});
