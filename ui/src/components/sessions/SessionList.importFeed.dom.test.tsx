// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import { listAgentSessionsPage, type AgentSession, type Task } from "../../api/client";
import { useAppStore } from "../../store/appStore";
import { setSessionFold } from "../../lib/sessionFolds";
import { IMPORTED_BUCKET_PREFIX } from "../../lib/phoneSessionBuckets";
import { setLocale } from "../../i18n";

/**
 * The imported half of the list has its own index, cursor and first-page
 * refresh. These tests pin two failures a UI-only reading cannot see:
 *
 * - a first-page refresh (import, unlink, reconnect) and an older page share
 *   one generation, so a stale page cannot re-add rows or move the cursor back;
 * - a failed index read is recoverable from the page itself, with rows or
 *   without them, and a reconnect retries it.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
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
    listAgentSessionsPage: vi.fn(),
    listTasks: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p", name: "p" })),
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

function viewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? false : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
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

function page() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <SessionList shell="page" />
    </MemoryRouter>,
  );
}

async function showImportedRows(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const heading = await screen.findByRole("button", { name: /^Imported sessions/ });
  if (heading.getAttribute("aria-expanded") === "false") await user.click(heading);
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [];
  viewport();
  useAppStore.setState({ reconnectGen: 0 });
  vi.mocked(listAgentSessionsPage).mockReset();
  // Imported groups are folded until opened; these tests are about their rows.
  setSessionFold(`mac-1::${IMPORTED_BUCKET_PREFIX}mac-1`, true);
});

describe("the imported index and the older-page cursor", () => {
  it("does not page from a cursor a first-page refresh has already replaced", async () => {
    const user = userEvent.setup();
    const first = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    const refreshed = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    const older = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    let firstPageReads = 0;
    vi.mocked(listAgentSessionsPage).mockImplementation(async (params) => {
      if (params?.before === "cursor-1") return older.promise;
      if (params?.before === "cursor-2") {
        return { items: [session("older-2")], next_cursor: undefined };
      }
      firstPageReads += 1;
      return firstPageReads === 1 ? first.promise : refreshed.promise;
    });

    page();
    await act(async () => {
      first.resolve({ items: [session("before-refresh")], next_cursor: "cursor-1" });
    });
    await showImportedRows(user);
    expect(await screen.findByRole("button", { name: /before-refresh/ })).toBeTruthy();

    // The refresh starts and the old Load older control is still on screen
    // until React commits the cleared cursor. The click in that window must
    // not page from the cursor the refresh has just invalidated — the answer
    // would append rows from the previous list and move the cursor back.
    const loadOlder = screen.getByRole("button", { name: /Load older/ });
    act(() => {
      window.dispatchEvent(new Event("kin:agent-sessions-sync"));
      loadOlder.click();
    });
    expect(
      vi
        .mocked(listAgentSessionsPage)
        .mock.calls.filter(([params]) => params?.before === "cursor-1"),
    ).toHaveLength(0);

    await act(async () => {
      refreshed.resolve({ items: [session("after-refresh")], next_cursor: "cursor-2" });
    });
    await showImportedRows(user);
    expect(await screen.findByRole("button", { name: /after-refresh/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /before-refresh/ })).toBeNull();

    // The next older page starts from the refreshed cursor, not the old one.
    await user.click(screen.getByRole("button", { name: /Load older/ }));
    expect(await screen.findByRole("button", { name: /older-2/ })).toBeTruthy();
    expect(vi.mocked(listAgentSessionsPage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: "cursor-2" }),
    );
  });

  it("drops an older page that arrives after a first-page refresh", async () => {
    const user = userEvent.setup();
    const first = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    const older = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    const refreshed = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    let firstPageReads = 0;
    vi.mocked(listAgentSessionsPage).mockImplementation((params) => {
      if (params?.before) return older.promise;
      firstPageReads += 1;
      return firstPageReads === 1 ? first.promise : refreshed.promise;
    });

    page();
    await act(async () => {
      first.resolve({ items: [session("before-import")], next_cursor: "cursor-1" });
    });
    await showImportedRows(user);
    expect(await screen.findByRole("button", { name: /before-import/ })).toBeTruthy();

    // The older page is in flight when an import replaces the first page.
    await user.click(screen.getByRole("button", { name: /Load older/ }));
    act(() => {
      window.dispatchEvent(new Event("kin:agent-sessions-sync"));
    });
    await act(async () => {
      refreshed.resolve({ items: [session("after-import")], next_cursor: undefined });
    });
    await showImportedRows(user);
    expect(await screen.findByRole("button", { name: /after-import/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /before-import/ })).toBeNull();

    // Resolve the stale older page last. It must not put the removed row back,
    // and its cursor must not revive "Load older" after the refresh ended it.
    await act(async () => {
      older.resolve({ items: [session("stale-page")], next_cursor: "cursor-old" });
      await older.promise;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: /stale-page/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Load older/ })).toBeNull();
  });
});

describe("a first-page refresh and the rows already on screen", () => {
  it("replaces the rows only when the refreshed page succeeds", async () => {
    const user = userEvent.setup();
    const first = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    const refreshed = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    let firstPageReads = 0;
    vi.mocked(listAgentSessionsPage).mockImplementation(async (params) => {
      if (params?.before) return { items: [session("older")], next_cursor: undefined };
      firstPageReads += 1;
      return firstPageReads === 1 ? first.promise : refreshed.promise;
    });

    page();
    await act(async () => {
      first.resolve({ items: [session("before")], next_cursor: "cursor-1" });
    });
    await showImportedRows(user);
    expect(await screen.findByRole("button", { name: /before/ })).toBeTruthy();

    act(() => window.dispatchEvent(new Event("kin:agent-sessions-sync")));

    // The answer is still out: what the reader is looking at must not blink
    // away, and its cursor is not offered to a page read.
    expect(screen.getByRole("button", { name: /before/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Load older/ })).toBeTruthy();
    screen.getByRole("button", { name: /Load older/ }).click();
    expect(
      vi
        .mocked(listAgentSessionsPage)
        .mock.calls.filter(([params]) => params?.before === "cursor-1"),
    ).toHaveLength(0);

    await act(async () => {
      refreshed.resolve({ items: [session("after")], next_cursor: "cursor-2" });
    });
    await showImportedRows(user);
    expect(await screen.findByRole("button", { name: /after/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /before/ })).toBeNull();
  });

  it("keeps the old rows, cursor and paging when the refresh fails", async () => {
    const user = userEvent.setup();
    const first = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    const refreshed = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    let firstPageReads = 0;
    vi.mocked(listAgentSessionsPage).mockImplementation(async (params) => {
      if (params?.before === "cursor-1") {
        return { items: [session("older-1")], next_cursor: undefined };
      }
      firstPageReads += 1;
      return firstPageReads === 1 ? first.promise : refreshed.promise;
    });

    page();
    await act(async () => {
      first.resolve({ items: [session("before")], next_cursor: "cursor-1" });
    });
    await showImportedRows(user);
    expect(await screen.findByRole("button", { name: /before/ })).toBeTruthy();

    act(() => window.dispatchEvent(new Event("kin:agent-sessions-sync")));
    await act(async () => {
      refreshed.reject(new Error("offline"));
    });
    // The failure is still surfaced — the soft notice keeps the rows visible
    // instead of replacing them with the hard empty state.
    await waitFor(() =>
      expect(
        screen.getByText(
          "Local agent sessions could not be read right now. Kin's own sessions are still listed above.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Could not load imported sessions")).toBeNull();

    // The failed read did not replace anything: the row, its cursor and the
    // control that pages from it are all still here.
    expect(screen.getByRole("button", { name: /before/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Load older/ }));
    expect(await screen.findByRole("button", { name: /older-1/ })).toBeTruthy();
    expect(vi.mocked(listAgentSessionsPage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: "cursor-1" }),
    );
  });

  it("does not leave paging disabled when an older page never answers", async () => {
    const user = userEvent.setup();
    const first = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    const refreshed = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    const hung = deferred<{ items: AgentSession[]; next_cursor?: string }>();
    let firstPageReads = 0;
    vi.mocked(listAgentSessionsPage).mockImplementation(async (params) => {
      if (params?.before === "cursor-1") return hung.promise;
      if (params?.before === "cursor-2") {
        return { items: [session("older-2")], next_cursor: undefined };
      }
      firstPageReads += 1;
      return firstPageReads === 1 ? first.promise : refreshed.promise;
    });

    page();
    await act(async () => {
      first.resolve({ items: [session("before")], next_cursor: "cursor-1" });
    });
    await showImportedRows(user);
    expect(await screen.findByRole("button", { name: /before/ })).toBeTruthy();

    // The older page is out and never answers; a refresh then replaces the
    // list. Its loading state belongs to the retired list and must be cleared,
    // or the control stays disabled for the rest of the session.
    await user.click(screen.getByRole("button", { name: /Load older/ }));
    act(() => window.dispatchEvent(new Event("kin:agent-sessions-sync")));
    await act(async () => {
      refreshed.resolve({ items: [session("after")], next_cursor: "cursor-2" });
    });
    await showImportedRows(user);
    expect(await screen.findByRole("button", { name: /after/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Load older/ }));
    expect(await screen.findByRole("button", { name: /older-2/ })).toBeTruthy();
    expect(vi.mocked(listAgentSessionsPage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: "cursor-2" }),
    );
  });
});

describe("a failed imported index", () => {
  it("shows an actionable error even when it is the only feed, and Retry recovers", async () => {
    const user = userEvent.setup();
    vi.mocked(listAgentSessionsPage)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [session("recovered")], next_cursor: undefined });

    page();

    expect(await screen.findByText("Could not load imported sessions")).toBeTruthy();
    // Not the generic "No chats yet" empty state: something failed and there
    // is a control that answers it.
    expect(screen.queryByText("No chats yet")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /recovered/ })).toBeTruthy();
    expect(screen.queryByText("Could not load imported sessions")).toBeNull();
  });

  it("retries the index when the connection comes back", async () => {
    const user = userEvent.setup();
    vi.mocked(listAgentSessionsPage)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [session("after-reconnect")], next_cursor: undefined });

    page();
    expect(await screen.findByText("Could not load imported sessions")).toBeTruthy();

    act(() => {
      useAppStore.setState({ reconnectGen: 1 });
    });

    await showImportedRows(user);
    expect(await screen.findByRole("button", { name: /after-reconnect/ })).toBeTruthy();
  });
});
