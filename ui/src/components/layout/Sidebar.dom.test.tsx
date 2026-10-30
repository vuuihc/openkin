// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "../../api/client";
import Sidebar from "./Sidebar";
import { setLocale } from "../../i18n";

/**
 * KIN-CONTINUE-001: the Mac sidebar is the window's only conversation list.
 *
 * It is one piece — search, the device → project → conversation tree, and one
 * row of destination icons at the bottom — and the tree names every machine,
 * including a console that has only its own. The old panel hid that heading
 * when there was one machine, which made the top level of the list invisible
 * exactly when a person had nothing else to compare it with.
 */

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

function sidebar(
  tasks: Task[],
  onImportExternalSessions?: () => void,
  pendingCount = 0,
) {
  return (
    <MemoryRouter>
      <Sidebar
        tasks={tasks}
        pendingCount={pendingCount}
        mobileOpen={false}
        onCloseMobile={() => {}}
        onNewChat={() => {}}
        onImportExternalSessions={onImportExternalSessions}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  viewport(true);
});

describe("the Mac sidebar list", () => {
  it("has exactly one list search field", () => {
    render(sidebar([task("here", "/work/alpha")]));
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
  });

  it("draws machine → project → conversation", () => {
    render(sidebar([task("local-work", "/work/alpha"), task("remote-work", "/srv/beta", "nas-1")]));

    const self = screen.getByRole("button", { name: /This machine/ });
    const remote = screen.getByRole("button", { name: /Studio/ });

    // Each heading owns its own projects and conversations: the remote
    // machine's task is not under this machine's heading.
    expect(self.parentElement?.textContent).toContain("alpha");
    expect(self.parentElement?.textContent).toContain("local-work");
    expect(self.parentElement?.textContent).not.toContain("remote-work");
    expect(remote.parentElement?.textContent).toContain("beta");
    expect(remote.parentElement?.textContent).toContain("remote-work");
  });

  it("still names this machine when it is the only one", () => {
    render(sidebar([task("only", "/work/alpha")]));
    expect(screen.getByRole("button", { name: /This machine/ })).toBeTruthy();
  });

  it("puts a footer badge into the icon's accessible name", () => {
    // The number is the point of the badge; a name that stops at "Inbox"
    // tells a screen reader nothing is waiting while the dot says otherwise.
    render(sidebar([task("only", "/work/alpha")], undefined, 3));
    expect(screen.getByRole("link", { name: "Inbox (3)" })).toBeTruthy();
  });

  it("opens import as a disclosure of plain buttons, not a menu", async () => {
    render(sidebar([task("only", "/work/alpha")], () => {}));
    const trigger = screen.getByRole("button", { name: /Import Agent sessions/i });
    await userEvent.click(trigger);

    // `role="menu"` promises arrow-key navigation this popup does not have;
    // the rows are ordinary buttons reached by Tab.
    const popup = screen.getByRole("group", { name: "Import Agent sessions" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(popup).getAllByRole("button").length).toBeGreaterThan(0);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Import Agent sessions" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps import in the footer icon row, not as a second block above the list", () => {
    render(sidebar([task("only", "/work/alpha")], () => {}));
    const button = screen.getByRole("button", { name: /Import Agent sessions/i });

    // One row of destinations at the bottom is the whole secondary navigation;
    // a full-width import button between the header and the list made the rail
    // two pieces again.
    expect(button.closest("[data-sidebar-footer]")).not.toBeNull();
    expect(button.textContent).toBe("");
  });
});
