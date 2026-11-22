// @vitest-environment jsdom
// KIN-ROUTINE-001: the routine page owns machine choice, form state and run
// history without rendering the conversation itself.
// KIN-NOTIFY-001: a notification on an already-open routines page changes the
// machine, and a manual switch writes the same URL, so a second tap of the same
// notification is a real navigation again.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import RoutinesPage from "./RoutinesPage";
import { setLocale } from "../i18n";
import {
  createRoutine,
  getRoutine,
  listRoutineRuns,
  listRoutines,
  patchRoutine,
  type Routine,
} from "../api/client";
import type { WSMessage } from "../api/contract";
import { routineForm, routinePatch } from "../lib/routineEdit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pushToast: vi.fn(),
  reconnectGen: 0,
  machines: [] as Array<{
    isSelf: boolean;
    id: string;
    label: string;
    online: boolean;
    roots: unknown[];
  }>,
  loading: false,
  failed: false,
  wsListeners: new Set<(message: WSMessage) => void>(),
}));

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: mocks.machines,
    agents: [],
    loading: mocks.loading,
    failed: mocks.failed,
    refresh: vi.fn(),
  }),
}));

vi.mock("../hooks/useRoutinePreview", () => ({ useRoutinePreview: () => null }));
vi.mock("../hooks/useSlowHint", () => ({ useSlowHint: () => false }));

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  createRoutine: vi.fn(),
  deleteRoutine: vi.fn(),
  getRoutine: vi.fn(),
  isAuthenticated: () => true,
  listRoutineRuns: vi.fn(async () => ({ routines: [], runs: [], has_more: false })),
  listRoutines: vi.fn(async () => ({ routines: [], next_cursor: "", has_more: false })),
  listTasks: vi.fn(async () => []),
  patchRoutine: vi.fn(),
  runRoutineNow: vi.fn(),
}));

vi.mock("../store/appStore", () => ({
  subscribeWS: (listener: (message: WSMessage) => void) => {
    mocks.wsListeners.add(listener);
    return () => mocks.wsListeners.delete(listener);
  },
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({
      pushToast: mocks.pushToast,
      reconnectGen: mocks.reconnectGen,
      auth: { status: "ok" },
    }),
}));

vi.mock("../i18n/react", () => {
  const translate = (key: string) => key;
  return { useT: () => translate };
});

vi.mock("../lib/devices", () => ({
  catalogFor: () => [],
  isRemoteDevice: (id: string) => id !== "self" && !!id,
  pathWithin: () => false,
}));

vi.mock("../lib/routineRecurrence", () => ({
  describeRoutineRule: () => "",
  localTimeZone: () => "UTC",
  parseRoutineRule: () => null,
  serializeRoutineRule: () => null,
}));

vi.mock("../components/Skeleton", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/Skeleton")>()),
  SlowConnectHint: () => null,
}));

vi.mock("../lib/routineEdit", () => ({
  routineForm: vi.fn(),
  routinePatch: vi.fn(),
  routineTitle: () => "",
}));

vi.mock("../lib/routineStatus", () => ({ routineStatusLabel: () => "" }));

vi.mock("../lib/agentModels", () => ({ modelsForAgent: () => [] }));

vi.mock("../lib/permissionMode", () => ({
  getDraftPermissionMode: () => "default",
  normalizePermissionMode: (mode: string) => mode,
}));

vi.mock("../components/chat/CwdPicker", () => ({
  default: (props: { cwd: string; onChange: (value: string) => void }) => (
    <input
      aria-label="cwd"
      value={props.cwd}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));
vi.mock("../components/chat/ModelPicker", () => ({ default: () => null }));
vi.mock("../components/chat/PermissionModePicker", () => ({
  default: (props: {
    value: string;
    disabled?: boolean;
    onChange: (mode: "default" | "accept_edits" | "yolo") => void;
  }) => (
    <div data-testid="permission-mode" data-value={props.value}>
      <button type="button" disabled={props.disabled} onClick={() => props.onChange("yolo")}>
        choose-yolo
      </button>
    </div>
  ),
}));
vi.mock("../components/routine/RoutineScheduleFields", () => ({
  default: (props: {
    intervalSecs: number;
    disabled?: boolean;
    onIntervalChange: (value: number) => void;
  }) => (
    <div data-testid="routine-interval" data-value={String(props.intervalSecs)}>
      <button type="button" disabled={props.disabled} onClick={() => props.onIntervalChange(3600)}>
        choose-hourly
      </button>
    </div>
  ),
  defaultNextRunLocal: () => "",
  parseLocalDateTime: () => null,
  toLocalInputValue: () => "",
}));

vi.mock("../components/ui/SheetSelect", () => ({
  default: (props: {
    label: string;
    value: string;
    options: Array<{ id: string; label: string }>;
    onChange: (id: string) => void;
  }) => (
    // The page now mounts a machine picker and two list filters through this
    // primitive. Only the machine one is the machine picker.
    <div
      data-testid={props.label === "machine.title" ? "machine-picker" : "filter-picker"}
      data-label={props.label}
      data-value={props.value}
    >
      {props.options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`machine-option-${option.id}`}
          onClick={() => props.onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

function renderApp(initial: string) {
  const router = createMemoryRouter(
    [
      { path: "/routines", element: <RoutinesPage /> },
      // The one list a routine's runs live in; the page only links to it.
      { path: "/sessions", element: <div>sessions</div> },
    ],
    { initialEntries: [initial] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

function locationOf(router: ReturnType<typeof createMemoryRouter>): string {
  const location = router.state.location;
  return location.pathname + location.search;
}

function standardMachines() {
  return [
    { isSelf: true, id: "self-1", label: "Local node", online: true, roots: [] },
    { isSelf: false, id: "dev-a", label: "Test node A", online: true, roots: [] },
    { isSelf: false, id: "dev-b", label: "Test node B", online: true, roots: [] },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function routine(id: string, title: string, overrides: Partial<Routine> = {}): Routine {
  return {
    id,
    cwd: "/tmp/kin",
    agent: "codex",
    model: "",
    permission_mode: "default",
    prompt: "check things",
    interval_secs: 86400,
    enabled: true,
    next_due_at: Date.now() + 60_000,
    consec_failures: 0,
    created_at: Date.now(),
    title,
    missed_run_policy: "skip",
    lane: "default",
    recurrence: "",
    ...overrides,
  };
}

function machineValue(): string | null {
  return screen.getByTestId("machine-picker").getAttribute("data-value");
}

async function navigate(router: ReturnType<typeof createMemoryRouter>, to: string) {
  await act(async () => {
    await router.navigate(to);
  });
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  mocks.machines = standardMachines();
  mocks.loading = false;
  mocks.failed = false;
  mocks.wsListeners.clear();
  mocks.pushToast.mockClear();
  mocks.reconnectGen = 0;
  vi.mocked(listRoutines).mockResolvedValue({
    routines: [],
    next_cursor: "",
    has_more: false,
  });
  vi.mocked(listRoutineRuns).mockResolvedValue({ routines: [], runs: [], has_more: false });
  vi.mocked(getRoutine).mockImplementation(async (id) =>
    routine(id, "Full original", { prompt: "The whole stored prompt" }),
  );
  vi.mocked(routineForm).mockImplementation((value) => ({
    title: value.title,
    prompt: value.prompt,
    cwd: value.cwd,
    agent: value.agent,
    model: value.model ?? "",
    permissionMode: value.permission_mode,
    intervalSecs: value.interval_secs,
    conversationMode: value.conversation_mode === "fresh" ? "fresh" : "continue",
    rule: null,
    nextRunMs: value.next_due_at,
    ruleZone: null,
  }));
  vi.mocked(routinePatch).mockReturnValue({ title: "stale edit" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RoutinesPage machine selection from the URL", () => {
  it("opens on the device a cold tap named", async () => {
    renderApp("/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
  });

  it("applies a warm tap while the page is already open", async () => {
    const { router } = renderApp("/routines");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    await navigate(router, "/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    expect(locationOf(router)).toBe("/routines?device=dev-b");
  });

  it("writes the URL when the reader switches machine by hand", async () => {
    const { router } = renderApp("/routines");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    fireEvent.click(screen.getByTestId("machine-option-dev-b"));
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    await waitFor(() => expect(locationOf(router)).toBe("/routines?device=dev-b"));
  });

  it("lets the same notification land again after a manual switch", async () => {
    const { router } = renderApp("/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    fireEvent.click(screen.getByTestId("machine-option-dev-a"));
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    await navigate(router, "/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
  });

  it("converges a missing machine in the URL to an existing one", async () => {
    const { router } = renderApp("/routines?device=missing");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    await waitFor(() => expect(locationOf(router)).toBe("/routines?device=dev-a"));
  });

  it("answers a back press with the previous history entry", async () => {
    const { router } = renderApp("/routines");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    await navigate(router, "/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(locationOf(router)).toBe("/routines?device=dev-a"));
    await act(async () => {
      await router.navigate(1);
    });
    await waitFor(() => expect(locationOf(router)).toBe("/routines?device=dev-b"));
  });

  it("clears the old machine's draft when a notification changes machines", async () => {
    const { router } = renderApp("/routines?device=dev-a");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    fireEvent.click(screen.getAllByRole("button", { name: "routines.createEntry" })[0]);
    const title = screen.getByLabelText("routines.titleLabel");
    fireEvent.change(title, { target: { value: "old machine draft" } });
    await navigate(router, "/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    fireEvent.click(screen.getAllByRole("button", { name: "routines.createEntry" })[0]);
    expect((screen.getByLabelText("routines.titleLabel") as HTMLInputElement).value).toBe("");
  });
});

describe("KIN-CONTRACT-001: /routines points at the one run list", () => {
  it("offers 看运行 on the opened routine and lands on the one list", async () => {
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "Morning review")],
      has_more: false,
    });
    const { router } = renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: "routines.openRoutine" }));
    const links = await screen.findAllByRole("link", { name: "routines.viewRunsFor" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/sessions?routine=r1");
    }
    await userEvent.click(links[0]);
    await waitFor(() => expect(locationOf(router)).toBe("/sessions?routine=r1"));
  });

  it("stops reading a routine's own run history on /routines", async () => {
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "No own history")],
      has_more: false,
    });
    renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: "routines.openRoutine" }));
    await screen.findAllByRole("link", { name: "routines.viewRunsFor" });
    expect(listRoutineRuns).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "r1",
    );
    expect(screen.queryByText("routines.runsPanelTitle")).toBeNull();
  });

  it("never asks for a run feed", async () => {
    // Runs are /sessions rows now; this page's only run affordance is the
    // opened routine's link. A load that still fetched the old global feed
    // would bring back the duplicate list, the unread pills and mark-all.
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "Morning review")],
      has_more: false,
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Morning review");
    // Give a feed read started after paint (or resolved late) room to land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(listRoutineRuns).not.toHaveBeenCalled();
    expect(screen.queryByText("routines.feedSection")).toBeNull();
    expect(screen.queryByText("routines.emptyFeed")).toBeNull();
  });

  it("names the row press as opening the routine, not its runs", async () => {
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "Open me")],
      has_more: false,
    });
    renderApp("/routines?device=dev-a");
    expect(await screen.findByRole("button", { name: "routines.openRoutine" })).toBeTruthy();
  });

  it("keeps the runs link under the row until the two-column width", async () => {
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "Morning review")],
      has_more: false,
    });
    renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: "routines.openRoutine" }));
    const links = await screen.findAllByRole("link", { name: "routines.viewRunsFor" });
    const inline = links.filter((link) => link.closest("aside") === null);
    const inAside = links.filter((link) => link.closest("aside") !== null);
    expect(inline).toHaveLength(1);
    expect(inAside).toHaveLength(1);
    // 820px is a tablet, not a desktop. The two-column layout used to start at
    // md (768px), squeezing the routine row beside a nearly empty aside until
    // the title truncated to two or three characters. It starts at lg, and the
    // inline link takes over below it with the same 44px tap target as a phone.
    expect(inline[0].parentElement?.className).toContain("lg:hidden");
    expect(inline[0].parentElement?.className).not.toContain("md:hidden");
    expect(inline[0].className).toContain("lg:min-h-0");
    const aside = inAside[0].closest("aside");
    expect(aside?.className).toContain("lg:block");
    expect(aside?.className).not.toContain("md:block");
    expect(aside?.parentElement?.className).toContain("lg:grid");
    expect(aside?.parentElement?.className).not.toContain("md:grid");
  });
});

describe("KIN-ROUTINE-001 bounded reads and complete editing", () => {
  it("clips the vertical root scroller so the browser leaves a horizontal tab gesture to the shell", () => {
    const { container } = renderApp("/routines?device=dev-a");
    // The actual Tailwind overflow-y-auto computes overflow-x:auto too, which
    // makes a real browser issue pointercancel on a blank-content tab swipe.
    expect(container.firstElementChild?.className).toContain("overflow-x-hidden");
  });

  it("reads a summary but opens and saves the full stored routine", async () => {
    const full = routine("r1", "Complete original", {
      prompt: "Do not truncate this prompt",
      next_due_at: 60000,
    });
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [{ ...full, prompt: "" }],
      has_more: false,
    });
    vi.mocked(getRoutine).mockResolvedValue(full);
    vi.mocked(routinePatch).mockReturnValue(null);
    renderApp("/routines?device=dev-a");
    await screen.findByText("Complete original");
    fireEvent.click(screen.getByRole("button", { name: /routines.editRoutine/ }));
    expect(await screen.findByDisplayValue("Do not truncate this prompt")).toBeTruthy();
    expect(getRoutine).toHaveBeenCalledWith("r1", "dev-a");
    // Editing reads the definition only; the runs stay in the one list.
    expect(listRoutineRuns).not.toHaveBeenCalledWith(10, "dev-a", "", "r1");
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "routines.save" }));
    await waitFor(() =>
      expect(routinePatch).toHaveBeenCalledWith(
        full,
        expect.objectContaining({ prompt: "Do not truncate this prompt" }),
      ),
    );
  });

  it("does not combine an old routine cursor with a query whose first page is pending", async () => {
    const refreshed = deferred<Awaited<ReturnType<typeof listRoutines>>>();
    vi.mocked(listRoutines).mockImplementation(async (options) => {
      if (options?.q === "refresh") return refreshed.promise;
      return {
        routines: [routine("r1", "Original routine")],
        next_cursor: "old",
        has_more: true,
      };
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Original routine");
    fireEvent.change(screen.getByRole("textbox", { name: "routines.searchPlaceholder" }), {
      target: { value: "refresh" },
    });
    await waitFor(() =>
      expect(listRoutines).toHaveBeenCalledWith({ limit: 100, q: "refresh" }, "dev-a"),
    );
    fireEvent.click(screen.getByRole("button", { name: "routines.loadMore" }));
    expect(
      vi
        .mocked(listRoutines)
        .mock.calls.some(([options]) => options?.cursor === "old" && options?.q === "refresh"),
    ).toBe(false);
    await act(async () => {
      refreshed.resolve({
        routines: [routine("r2", "Refreshed routine")],
        next_cursor: "new",
        has_more: true,
      });
      await refreshed.promise;
    });
    await screen.findByText("Refreshed routine");
    expect(screen.queryByText("Original routine")).toBeNull();
  });

  it("ignores a stale older routine rejection after a first-page refresh", async () => {
    const older = deferred<Awaited<ReturnType<typeof listRoutines>>>();
    const refreshed = deferred<Awaited<ReturnType<typeof listRoutines>>>();
    let firstPages = 0;
    vi.mocked(listRoutines).mockImplementation(async (options) => {
      if (options?.cursor === "old") return older.promise;
      if (options?.q === "refresh") return refreshed.promise;
      firstPages += 1;
      return {
        routines: [routine("r1", "Original routine")],
        next_cursor: "old",
        has_more: true,
      };
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Original routine");
    fireEvent.click(screen.getByRole("button", { name: "routines.loadMore" }));
    expect(screen.getByRole("button", { name: "tree.loadingMore" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "routines.searchPlaceholder" }), {
      target: { value: "refresh" },
    });
    await waitFor(() =>
      expect(listRoutines).toHaveBeenCalledWith({ limit: 100, q: "refresh" }, "dev-a"),
    );
    await act(async () => {
      refreshed.resolve({
        routines: [routine("r2", "Refreshed routine")],
        next_cursor: "new",
        has_more: true,
      });
      await refreshed.promise;
    });
    await screen.findByText("Refreshed routine");
    await act(async () => {
      older.reject(new Error("stale routine failure"));
      await expect(older.promise).rejects.toThrow("stale routine failure");
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "routines.loadMore" })).toBeTruthy(),
    );
    expect(mocks.pushToast).not.toHaveBeenCalledWith("stale routine failure", "error");
    fireEvent.click(screen.getByRole("button", { name: "routines.loadMore" }));
    await waitFor(() =>
      expect(listRoutines).toHaveBeenLastCalledWith(
        { limit: 100, cursor: "new", q: "refresh" },
        "dev-a",
      ),
    );
  });

  it("keeps an older routine page behind a first-page refresh", async () => {
    const older = deferred<Awaited<ReturnType<typeof listRoutines>>>();
    const refreshed = deferred<Awaited<ReturnType<typeof listRoutines>>>();
    let firstPages = 0;
    vi.mocked(listRoutines).mockImplementation(async (options) => {
      if (options?.cursor === "old") return older.promise;
      if (options?.q === "refresh") return refreshed.promise;
      firstPages += 1;
      return {
        routines: [routine("r1", "Original routine")],
        next_cursor: "old",
        has_more: true,
      };
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Original routine");
    fireEvent.click(screen.getByRole("button", { name: "routines.loadMore" }));
    await waitFor(() =>
      expect(listRoutines).toHaveBeenCalledWith({ limit: 100, cursor: "old" }, "dev-a"),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "routines.searchPlaceholder" }), {
      target: { value: "refresh" },
    });
    await waitFor(() =>
      expect(listRoutines).toHaveBeenCalledWith({ limit: 100, q: "refresh" }, "dev-a"),
    );
    await act(async () => {
      refreshed.resolve({
        routines: [routine("r2", "Refreshed routine")],
        next_cursor: "new",
        has_more: true,
      });
      await refreshed.promise;
    });
    await screen.findByText("Refreshed routine");
    await act(async () => {
      older.resolve({
        routines: [routine("r0", "Stale older routine")],
        next_cursor: "stale",
        has_more: true,
      });
      await older.promise;
    });
    expect(screen.queryByText("Stale older routine")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "routines.loadMore" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "routines.loadMore" }));
    await waitFor(() =>
      expect(listRoutines).toHaveBeenLastCalledWith(
        { limit: 100, cursor: "new", q: "refresh" },
        "dev-a",
      ),
    );
  });

  it("a late detail never replaces a newer create draft", async () => {
    const detail = deferred<Routine>();
    vi.mocked(getRoutine).mockReturnValue(detail.promise);
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "Original")],
      has_more: false,
    });
    renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: /routines.editRoutine/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "routines.createEntry" })[0]);
    const input = await screen.findByLabelText("routines.promptLabel");
    fireEvent.change(input, { target: { value: "Keep this newer draft" } });
    await screen.findByRole("button", { name: "routines.createAndOpen" });
    await act(async () => detail.resolve(routine("r1", "Old", { prompt: "Old original" })));
    expect(screen.getByDisplayValue("Keep this newer draft")).toBeTruthy();
    expect(screen.queryByDisplayValue("Old original")).toBeNull();
  });

  it("a detail failure leaves the summary and editor without inventing a prompt", async () => {
    vi.mocked(getRoutine).mockRejectedValue(new Error("detail unavailable"));
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [{ ...routine("r1", "Original"), prompt: "" }],
      has_more: false,
    });
    renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: /routines.editRoutine/ }));
    await waitFor(() => expect(getRoutine).toHaveBeenCalledWith("r1", "dev-a"));
    expect(screen.queryByLabelText("routines.promptLabel")).toBeNull();
    expect(screen.getByText("Original")).toBeTruthy();
  });

  it("does not let an old A create land after A → B → A", async () => {
    const first = deferred<Routine>();
    const second = deferred<Routine>();
    vi.mocked(createRoutine).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { router } = renderApp("/routines?device=dev-a");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));

    fireEvent.click(screen.getAllByRole("button", { name: "routines.createEntry" })[0]);
    fireEvent.change(screen.getByLabelText("routines.promptLabel"), {
      target: { value: "old view prompt" },
    });
    fireEvent.change(screen.getByLabelText("cwd"), { target: { value: "/tmp/old" } });
    fireEvent.click(screen.getByRole("button", { name: "routines.createAndOpen" }));
    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));

    await navigate(router, "/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    await navigate(router, "/routines?device=dev-a");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));

    fireEvent.click(screen.getAllByRole("button", { name: "routines.createEntry" })[0]);
    fireEvent.change(screen.getByLabelText("routines.promptLabel"), {
      target: { value: "current view prompt" },
    });
    fireEvent.change(screen.getByLabelText("cwd"), { target: { value: "/tmp/current" } });
    fireEvent.click(screen.getByRole("button", { name: "routines.createAndOpen" }));
    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(2));

    await act(async () => {
      first.resolve(routine("old-routine", "stale create", { cwd: "/tmp/old" }));
      await first.promise;
    });
    expect(screen.queryByText("stale create")).toBeNull();
    // The old request's finally block must not clear the new A view's busy
    // state and re-enable a form whose save is still running.
    expect(
      (screen.getByRole("button", { name: "routines.createAndOpen" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      second.resolve(routine("current-routine", "current create", { cwd: "/tmp/current" }));
      await second.promise;
    });
    await screen.findByText("current create");
  });

  it("does not let an old A detail replace the current form after A → B → A", async () => {
    vi.mocked(getRoutine).mockImplementation(async (id, device = "") =>
      device === "dev-a"
        ? routine(id, "Full A", { prompt: "Full A prompt", cwd: "/work/a" })
        : routine(id, "Full B", { prompt: "Full B prompt", cwd: "/work/b" }),
    );
    vi.mocked(listRoutines).mockImplementation(async (_options, device = "dev-a") => ({
      routines: [routine(`routine-${device}`, `${device.toUpperCase()} title`)],
      has_more: false,
    }));
    const first = deferred<Routine>();
    vi.mocked(getRoutine).mockReturnValueOnce(first.promise);
    const { router } = renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: /routines.editRoutine/ }));
    await waitFor(() => expect(getRoutine).toHaveBeenCalledWith("routine-dev-a", "dev-a"));

    await navigate(router, "/routines?device=dev-b");
    await screen.findByText("DEV-B title");
    fireEvent.click(screen.getByRole("button", { name: /routines.editRoutine/ }));
    expect(await screen.findByDisplayValue("Full B prompt")).toBeTruthy();
    await navigate(router, "/routines?device=dev-a");
    await screen.findByText("DEV-A title");
    fireEvent.click(screen.getByRole("button", { name: /routines.editRoutine/ }));
    expect(await screen.findByDisplayValue("Full A prompt")).toBeTruthy();

    await act(async () =>
      first.resolve(
        routine("routine-a", "Stale A", { prompt: "Stale A prompt", cwd: "/work/stale" }),
      ),
    );
    expect(screen.getByDisplayValue("Full A prompt")).toBeTruthy();
    expect(screen.queryByDisplayValue("Stale A prompt")).toBeNull();
    expect((screen.getByLabelText("cwd") as HTMLInputElement).value).toBe("/work/a");
  });

  it("does not let an old A edit overwrite the routine list after A → B → A", async () => {
    const original = routine("routine-1", "original title");
    const edit = deferred<Routine>();
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [original],
      next_cursor: "",
      has_more: false,
    });
    vi.mocked(patchRoutine).mockReturnValueOnce(edit.promise);
    const { router } = renderApp("/routines?device=dev-a");
    await screen.findByText("original title");

    fireEvent.click(screen.getByRole("button", { name: /routines.editRoutine/ }));
    fireEvent.click(await screen.findByRole("button", { name: "routines.save" }));
    await waitFor(() => expect(patchRoutine).toHaveBeenCalledTimes(1));

    await navigate(router, "/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    await navigate(router, "/routines?device=dev-a");
    await screen.findByText("original title");

    await act(async () => {
      edit.resolve({ ...original, title: "stale edit" });
      await edit.promise;
    });
    expect(screen.getByText("original title")).not.toBeNull();
    expect(screen.queryByText("stale edit")).toBeNull();
  });

  it("resets machine-specific permission and cadence drafts on every switch", async () => {
    const { router } = renderApp("/routines?device=dev-a");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    fireEvent.click(screen.getAllByRole("button", { name: "routines.createEntry" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "choose-yolo" }));
    fireEvent.click(screen.getByRole("button", { name: "choose-hourly" }));
    expect(screen.getByTestId("permission-mode").getAttribute("data-value")).toBe("yolo");
    expect(screen.getByTestId("routine-interval").getAttribute("data-value")).toBe("3600");

    await navigate(router, "/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    await navigate(router, "/routines?device=dev-a");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    fireEvent.click(screen.getAllByRole("button", { name: "routines.createEntry" })[0]);

    expect(screen.getByTestId("permission-mode").getAttribute("data-value")).toBe("default");
    expect(screen.getByTestId("routine-interval").getAttribute("data-value")).toBe("86400");
  });
});

describe("RoutinesPage offline machine list", () => {
  it("applies a warm tap even while the machine list has not loaded", async () => {
    mocks.machines = [];
    mocks.loading = true;
    const { router } = renderApp("/routines");
    await navigate(router, "/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
  });

  it("reports a missing machine as gone instead of inventing a local page", async () => {
    const { router } = renderApp("/routines?device=missing");
    await screen.findByTestId("machine-picker");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    await waitFor(() => expect(locationOf(router)).toBe("/routines?device=dev-a"));
  });
});

describe("switching machine while the routine form has edits", () => {
  it("keeps the create draft and machine when the discard is refused", async () => {
    const { router } = renderApp("/routines?device=dev-a");
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    fireEvent.click(screen.getAllByRole("button", { name: "routines.createEntry" })[0]);
    fireEvent.change(screen.getByLabelText("routines.promptLabel"), {
      target: { value: "unfinished draft" },
    });

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByTestId("machine-option-dev-b"));

    expect(confirm).toHaveBeenCalledWith("routines.discardConfirm");
    expect(machineValue()).toBe("dev-a");
    expect(locationOf(router)).toBe("/routines?device=dev-a");
    expect((screen.getByLabelText("routines.promptLabel") as HTMLTextAreaElement).value).toBe(
      "unfinished draft",
    );

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId("machine-option-dev-b"));
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    expect(screen.queryByLabelText("routines.promptLabel")).toBeNull();
  });

  it("asks before an edit's changes are dropped by a machine switch", async () => {
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("routine-1", "Morning review")],
      next_cursor: "",
      has_more: false,
    });
    const { router } = renderApp("/routines?device=dev-a");
    await screen.findByText("Morning review");
    fireEvent.click(screen.getByRole("button", { name: /routines.editRoutine/ }));
    fireEvent.change(await screen.findByLabelText("routines.titleLabel"), {
      target: { value: "Changed title" },
    });

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByTestId("machine-option-dev-b"));

    expect(confirm).toHaveBeenCalledWith("routines.discardConfirm");
    expect(machineValue()).toBe("dev-a");
    expect(locationOf(router)).toBe("/routines?device=dev-a");
    expect(screen.getByDisplayValue("Changed title")).toBeTruthy();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId("machine-option-dev-b"));
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    expect(screen.queryByDisplayValue("Changed title")).toBeNull();
  });
});

describe("RoutinesPage routines left on this machine", () => {
  it("points at this machine's own routines while another machine is shown", async () => {
    vi.mocked(listRoutines).mockImplementation(async (_params, device) =>
      device === "self"
        ? {
            routines: [routine("own-1", "Own one"), routine("own-2", "Own two")],
            next_cursor: "",
            has_more: false,
          }
        : { routines: [], next_cursor: "", has_more: false },
    );
    const { router } = renderApp("/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    expect(await screen.findByText("routines.ownMachineHasRoutines")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "routines.ownMachineView" }));

    await waitFor(() => expect(machineValue()).toBe("self"));
    await waitFor(() => expect(locationOf(router)).toBe("/routines?device=self"));
    await screen.findByText("Own one");
    expect(screen.queryByText("routines.ownMachineHasRoutines")).toBeNull();
  });

  it("stays quiet when this machine holds no routines", async () => {
    renderApp("/routines?device=dev-b");
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    await waitFor(() => expect(listRoutines).toHaveBeenCalledWith({ limit: 100 }, "self"));
    expect(screen.queryByText("routines.ownMachineHasRoutines")).toBeNull();
  });

  it("does not ask for this machine's rows while already showing them", async () => {
    vi.mocked(listRoutines).mockClear();
    renderApp("/routines?device=self");
    await waitFor(() => expect(machineValue()).toBe("self"));
    await waitFor(() => expect(listRoutines).toHaveBeenCalled());
    const ownCalls = vi
      .mocked(listRoutines)
      .mock.calls.filter(([params, device]) => device === "self" && !("q" in (params ?? {})));
    expect(ownCalls).toHaveLength(0);
    expect(screen.queryByText("routines.ownMachineHasRoutines")).toBeNull();
  });
});

describe("RoutinesPage actions on the shared facade", () => {
  it("shows one filled primary: only the empty-state create", async () => {
    // A machine with routines has no filled action on the page, even though the
    // run feed's empty state also offers create.
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "Only routine")],
      next_cursor: "",
      has_more: false,
    });
    const withRoutines = renderApp("/routines?device=dev-a");
    await screen.findByText("Only routine");
    expect(withRoutines.container.querySelectorAll(".kin-btn-primary")).toHaveLength(0);
    cleanup();

    // A machine with none: exactly one, inside the list's empty state, and it
    // opens the create form.
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [],
      next_cursor: "",
      has_more: false,
    });
    const empty = renderApp("/routines?device=dev-a");
    await screen.findByText("routines.emptyList");
    const primaries = empty.container.querySelectorAll(".kin-btn-primary");
    expect(primaries).toHaveLength(1);
    expect(primaries[0].textContent).toBe("routines.createEntry");
    fireEvent.click(primaries[0]);
    expect(await screen.findByRole("button", { name: "routines.createAndOpen" })).toBeTruthy();
  });

  it("keeps the page load retry on the facade", async () => {
    let failing = true;
    vi.mocked(listRoutines).mockClear();
    vi.mocked(listRoutines).mockImplementation(async (_params, device) => {
      if (device === "dev-a" && failing) {
        failing = false;
        throw new Error("boom");
      }
      return { routines: [], next_cursor: "", has_more: false };
    });
    renderApp("/routines?device=dev-a");
    const retry = await screen.findByRole("button", { name: "routines.retry" });
    expect(retry.classList.contains("kin-btn")).toBe(true);
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        vi.mocked(listRoutines).mock.calls.filter(([, device]) => device === "dev-a"),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "routines.retry" })).toBeNull(),
    );
    cleanup();
  });
});
