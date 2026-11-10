// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { AgentSession, Task } from "../../api/client";
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

function viewport(wide: boolean, pointer: "fine" | "coarse" = "fine") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query === "(min-width: 768px)"
        ? wide
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

function session(id: string, title: string, device?: string): AgentSession {
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
    ...(device ? { device_id: device } : {}),
  };
}

function sidebar(
  tasks: Task[],
  onImportExternalSessions?: () => void,
  pendingByTask: ReadonlyMap<string, number> = new Map(),
  onDeleteSession?: (task: Task) => void,
  externalSessions: AgentSession[] = [],
) {
  return (
    <MemoryRouter>
      <Sidebar
        tasks={tasks}
        pendingByTask={pendingByTask}
        mobileOpen={false}
        onOpenMobile={() => {}}
        onCloseMobile={() => {}}
        onNewChat={() => {}}
        onImportExternalSessions={onImportExternalSessions}
        onDeleteSession={onDeleteSession}
        externalSessions={externalSessions}
        onOpenExternalSession={() => {}}
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

  it("puts the waiting count on the conversation row that owns it", () => {
    // The number is the point of the mark; a row name that stopped at the
    // title would tell a screen reader nothing is waiting while the badge says
    // otherwise. The row stays one link — the count is not a second target.
    render(sidebar([task("only", "/work/alpha")], undefined, new Map([["only", 3]])));
    expect(
      screen.getByRole("link", { name: "only · 3 waiting for you" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /waiting for you/i })).toBeNull();
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

  it("folds each machine's imported sessions under one trailing count", async () => {
    const sessions = [
      session("imp-1", "Old Claude chat"),
      session("imp-2", "Another imported chat"),
    ];
    const { rerender } = render(
      sidebar([task("native", "/work/alpha")], undefined, new Map(), undefined, sessions),
    );

    // Folded by default: an import is the part a person goes looking for, not
    // a row that competes with the conversations this machine ran.
    const trigger = screen.getByRole("button", { name: "Imported sessions (2)" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Old Claude chat" })).toBeNull();

    // A new import only updates the count; it does not reopen the fold.
    rerender(
      sidebar(
        [task("native", "/work/alpha")],
        undefined,
        new Map(),
        undefined,
        [...sessions, session("imp-3", "Brand new import")],
      ),
    );
    expect(screen.getByRole("button", { name: "Imported sessions (3)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Brand new import" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Imported sessions (3)" }));
    expect(
      screen.getByRole("button", { name: "Imported sessions (3)" }).getAttribute("aria-expanded"),
    ).toBe("true");
    const row = screen.getByRole("button", { name: "Old Claude chat" });
    expect(screen.getByRole("button", { name: "Another imported chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Brand new import" })).toBeTruthy();
    // The row is the native row: the avatar and the title, nothing else. A
    // re-added availability chip or status mark would show up here even though
    // the row's `aria-label` hides it from the accessible name.
    expect(row.textContent).toBe("COld Claude chat");
  });

  it("narrows the imported group with the search instead of leaking the library", () => {
    const sessions = [session("imp-1", "Old Claude chat")];
    const searching = (query: string) => (
      <MemoryRouter>
        <Sidebar
          tasks={[]}
          pendingByTask={new Map()}
          mobileOpen={false}
          onOpenMobile={() => {}}
          onCloseMobile={() => {}}
          onNewChat={() => {}}
          externalSessions={sessions}
          searchQuery={query}
          onSearchQueryChange={() => {}}
        />
      </MemoryRouter>
    );

    const { unmount } = render(searching("claude"));
    expect(screen.getByRole("button", { name: "Imported sessions (1)" })).toBeTruthy();
    // The match is on screen, not behind the fold: a search that finds a row
    // and then hides it reads as "nothing matched".
    expect(screen.getByRole("button", { name: "Old Claude chat" })).toBeTruthy();
    unmount();

    // The device still holds an import, but nothing matches: the page has to
    // say so rather than leave a full group under the device heading.
    render(searching("zzzz"));
    expect(screen.queryByRole("button", { name: /Imported sessions/ })).toBeNull();
    expect(screen.getByText(/No sessions match/)).toBeTruthy();
  });

  it("matches the words the row visibly shows for an opaque title", () => {
    // The provider title is a UUID, so the row draws "Claude Code · Billing ·
    // …"; typing "Billing" has to find it.
    const opaque = {
      ...session("imp-1", "6d8f4e35-3b8f-4a6a-8e1a-7ce0fca2d6f4"),
      project_label: "Billing",
    };
    render(
      <MemoryRouter>
        <Sidebar
          tasks={[]}
          pendingByTask={new Map()}
          mobileOpen={false}
          onOpenMobile={() => {}}
          onCloseMobile={() => {}}
          onNewChat={() => {}}
          externalSessions={[opaque]}
          searchQuery="billing"
          onSearchQueryChange={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: /Claude Code · Billing/ })).toBeTruthy();
  });

  it("remembers a fold the reader opened", async () => {
    const sessions = [session("imp-1", "Old Claude chat")];
    const { unmount } = render(
      sidebar([task("native", "/work/alpha")], undefined, new Map(), undefined, sessions),
    );
    await userEvent.click(screen.getByRole("button", { name: "Imported sessions (1)" }));
    expect(localStorage.getItem("kin_sidebar_open:imports:active:mac-1")).toBe("1");
    unmount();

    render(sidebar([task("native", "/work/alpha")], undefined, new Map(), undefined, sessions));
    expect(
      screen.getByRole("button", { name: "Imported sessions (1)" }).getAttribute("aria-expanded"),
    ).toBe("true");
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

/**
 * An iPad gets the desktop layout at ≥768px, so a width query says "wide"
 * there — but its pointer is a finger. iOS spends the first tap on a row with
 * a `:hover` style applying that style, and a control revealed only by hover
 * is never reached. The split is therefore at the pointer, not the width:
 * wide-and-coarse gets the touch shape, wide-and-fine keeps the hover reveals.
 */
describe("the sidebar's pointer shapes", () => {
  it("gives a coarse pointer the action sheet instead of hover-only controls", () => {
    viewport(true, "coarse");
    render(sidebar([task("one", "/work/alpha")], undefined, new Map(), () => {}));

    expect(screen.queryByRole("button", { name: "One-Pager cover" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pin project" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove from sidebar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete session" })).toBeNull();
    // The touch home is the ⋯ sheet, at desktop width too: the button is in
    // the document for a mouse as well, and `md:hidden` is what keeps it out
    // of the desktop row. A coarse pointer drops that half.
    expect(screen.getByRole("button", { name: "Project actions" }).className).not.toContain(
      "md:hidden",
    );
  });

  it("keeps the hover-revealed controls for a mouse at the same width", () => {
    viewport(true, "fine");
    render(sidebar([task("one", "/work/alpha")], undefined, new Map(), () => {}));

    expect(screen.getByRole("button", { name: "One-Pager cover" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pin project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove from sidebar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete session" })).toBeTruthy();
    // Present in the document either way; `md:hidden` is what keeps the ⋯
    // sheet out of the mouse layout.
    expect(screen.getByRole("button", { name: "Project actions" }).className).toContain(
      "md:hidden",
    );
  });

  it("leaves the conversation row with no hover change for a finger", () => {
    viewport(true, "coarse");
    const { unmount } = render(sidebar([task("one", "/work/alpha")]));
    expect(screen.getByRole("link", { name: "one" }).parentElement?.className).not.toContain(
      "hover:bg-",
    );
    unmount();

    viewport(true, "fine");
    render(sidebar([task("one", "/work/alpha")]));
    expect(screen.getByRole("link", { name: "one" }).parentElement?.className).toContain(
      "hover:bg-[var(--kin-fill)]",
    );
  });
});
