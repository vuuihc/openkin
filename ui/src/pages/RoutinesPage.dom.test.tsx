// @vitest-environment jsdom
// KIN-ROUTINE-001: the routine page owns machine choice, form state and run
// history without rendering the conversation itself.
// KIN-NOTIFY-001: a notification on an already-open routines page changes the
// machine, and a manual switch writes the same URL, so a second tap of the same
// notification is a real navigation again.
import { within, act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import RoutinesPage from "./RoutinesPage";
import { setLocale } from "../i18n";
import {
  ApiError,
  createRoutine,
  getRoutine,
  listRoutineRuns,
  listRoutines,
  markAllRoutineRunsRead,
  markRoutineRunRead,
  patchRoutine,
  type Routine,
  type Task,
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
  isTerminal: () => true,
  listRoutineRuns: vi.fn(async () => ({ routines: [], runs: [], has_more: false })),
  listRoutines: vi.fn(async () => ({ routines: [], next_cursor: "", has_more: false })),
  listTasks: vi.fn(async () => []),
  markAllRoutineRunsRead: vi.fn(),
  markRoutineRunRead: vi.fn(),
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

vi.mock("../lib/routineHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/routineHistory")>()),
  ROUTINE_HISTORY_MAX: 100,
}));

vi.mock("../components/Skeleton", () => ({ SlowConnectHint: () => null }));

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
  const router = createMemoryRouter([{ path: "/routines", element: <RoutinesPage /> }], {
    initialEntries: [initial],
  });
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

function run(id: string, routineId: string, title: string): Task {
  return {
    id,
    title,
    agent: "codex",
    cwd: "/tmp/kin",
    prompt: "check things",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: Date.now(),
    event_epoch: 0,
    routine_id: routineId,
    routine_unread: true,
    routine_noteworthy: true,
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
  vi.mocked(markAllRoutineRunsRead).mockResolvedValue({ marked: 0 });
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
    await waitFor(() => expect(locationOf(router)).toBe("/routines?device=dev-a"));
    expect(listRoutineRuns).toHaveBeenCalledWith(10, "dev-a");
    await act(async () => {
      await router.navigate(1);
    });
    await waitFor(() => expect(locationOf(router)).toBe("/routines?device=dev-b"));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "dev-b"));
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
    // A full definition and its bounded run history are separate reads. Editing
    // must not mistake the summary-only selection for an already loaded history.
    await waitFor(() => expect(listRoutineRuns).toHaveBeenCalledWith(10, "dev-a", "", "r1"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "routines.save" }));
    await waitFor(() =>
      expect(routinePatch).toHaveBeenCalledWith(
        full,
        expect.objectContaining({ prompt: "Do not truncate this prompt" }),
      ),
    );
  });

  it("appends the older global run feed without reusing its route cursor", async () => {
    const old = run("001", "r1", "Older result");
    vi.mocked(listRoutineRuns).mockImplementation(
      async (_limit, _device, cursor = "", _routineId = "") =>
        cursor
          ? {
              routines: [],
              runs: [old],
              has_more: false,
              runs_next_cursor: "",
              runs_has_more: false,
            }
          : {
              routines: [],
              runs: [run("003", "r1", "New result")],
              has_more: false,
              runs_next_cursor: "003",
              runs_has_more: true,
            },
    );
    renderApp("/routines?device=dev-a");
    await screen.findByText("New result");
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    await screen.findByText("Older result");
    expect(screen.getByText("New result")).toBeTruthy();
    await waitFor(() => expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "dev-a", "003"));
  });

  it("does not truncate loaded older feed rows when a live run arrives", async () => {
    mocks.machines = [{ isSelf: true, id: "self-1", label: "Local node", online: true, roots: [] }];
    const older = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "") => {
      if (cursor === "deep") return older.promise;
      if (cursor === "deeper")
        return {
          routines: [],
          runs: [],
          has_more: false,
          runs_next_cursor: "",
          runs_has_more: false,
        };
      return {
        routines: [],
        runs: Array.from({ length: 10 }, (_, index) =>
          run(String(20 - index).padStart(3, "0"), "r1", `First page ${index}`),
        ),
        has_more: false,
        runs_next_cursor: "deep",
        runs_has_more: true,
      };
    });
    renderApp("/routines?device=self");
    await waitFor(() => expect(machineValue()).toBe("self"));
    await act(async () => {});
    await waitFor(() => expect(listRoutineRuns).toHaveBeenCalledWith(10, "self"));
    await screen.findByText("First page 0");
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "tree.loadingMore" })).toBeTruthy(),
    );
    await waitFor(() => expect(listRoutineRuns).toHaveBeenCalledWith(10, "self", "deep"));
    await act(async () => {
      older.resolve({
        routines: [],
        runs: [run("009", "r1", "Older page")],
        has_more: false,
        runs_next_cursor: "deeper",
        runs_has_more: true,
      });
      await older.promise;
    });
    await screen.findByText("Older page");
    await act(async () => {
      // Newer than the first page's head (020). Reusing an existing id would
      // take foldRoutineRun's in-place branch, so the insert-then-cap path
      // this test protects would never run.
      for (const listener of mocks.wsListeners)
        listener({ kind: "task_update", data: run("021", "r1", "Live run") });
    });
    expect(screen.getByText("Live run")).toBeTruthy();
    expect(screen.getByText("Older page")).toBeTruthy();
    expect(screen.getByText("First page 9")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "self", "deeper"));
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

  it("does not let an older feed response resurrect rows after Mark all read", async () => {
    const older = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "") =>
      cursor === "old"
        ? older.promise
        : {
            routines: [],
            runs: [run("010", "r1", "Unread first page")],
            has_more: false,
            runs_next_cursor: "old",
            runs_has_more: true,
          },
    );
    renderApp("/routines?device=dev-a");
    await screen.findByText("Unread first page");
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenCalledWith(10, "dev-a", "old"));
    fireEvent.click(screen.getByRole("button", { name: "routines.markAllRead" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "routines.markRead" })).toBeNull(),
    );
    await act(async () => {
      older.resolve({
        routines: [],
        runs: [run("009", "r1", "Previously unread older page")],
        has_more: false,
        runs_next_cursor: "older",
        runs_has_more: true,
      });
      await older.promise;
    });
    await screen.findByText("Previously unread older page");
    expect(screen.queryByRole("button", { name: "routines.markRead" })).toBeNull();
  });

  it("ignores a stale older feed rejection after a first-page refresh", async () => {
    const older = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    const refreshed = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    let firstPages = 0;
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "") => {
      if (cursor === "old") return older.promise;
      if (cursor === "") {
        firstPages += 1;
        if (firstPages === 1) {
          return {
            routines: [],
            runs: [run("010", "r1", "Original feed")],
            has_more: false,
            runs_next_cursor: "old",
            runs_has_more: true,
          };
        }
        return refreshed.promise;
      }
      return {
        routines: [],
        runs: [],
        has_more: false,
        runs_next_cursor: "",
        runs_has_more: false,
      };
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Original feed");
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    expect(screen.getByRole("button", { name: "tree.loadingMore" })).toBeTruthy();
    await waitFor(() =>
      expect(vi.mocked(listRoutineRuns).mock.calls.some(([, , cursor]) => cursor === "old")).toBe(
        true,
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "routines.searchPlaceholder" }), {
      target: { value: "refresh" },
    });
    await waitFor(() => expect(firstPages).toBe(2));
    await act(async () => {
      refreshed.resolve({
        routines: [],
        runs: [run("020", "r1", "Refreshed feed")],
        has_more: false,
        runs_next_cursor: "new",
        runs_has_more: true,
      });
      await refreshed.promise;
    });
    await screen.findByText("Refreshed feed");
    await act(async () => {
      older.reject(new Error("stale older failure"));
      await expect(older.promise).rejects.toThrow("stale older failure");
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "routines.historyLoadOlder" })).toBeTruthy(),
    );
    expect(mocks.pushToast).not.toHaveBeenCalledWith("stale older failure", "error");
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "dev-a", "new"));
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

  it("ignores a stale older feed page that finishes after the refreshed cursor", async () => {
    const older = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    const refreshed = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    let firstPages = 0;
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "") => {
      if (cursor === "old") return older.promise;
      if (cursor === "") {
        firstPages += 1;
        if (firstPages === 1) {
          return {
            routines: [],
            runs: [run("010", "r1", "Original feed")],
            has_more: false,
            runs_next_cursor: "old",
            runs_has_more: true,
          };
        }
        return refreshed.promise;
      }
      return {
        routines: [],
        runs: [],
        has_more: false,
        runs_next_cursor: "",
        runs_has_more: false,
      };
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Original feed");
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    expect(screen.getByRole("button", { name: "tree.loadingMore" })).toBeTruthy();
    await waitFor(() =>
      expect(vi.mocked(listRoutineRuns).mock.calls.some(([, , cursor]) => cursor === "old")).toBe(
        true,
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "routines.searchPlaceholder" }), {
      target: { value: "refresh" },
    });
    await waitFor(() => expect(firstPages).toBe(2));
    await act(async () => {
      refreshed.resolve({
        routines: [],
        runs: [run("020", "r1", "Refreshed feed")],
        has_more: false,
        runs_next_cursor: "new",
        runs_has_more: true,
      });
      await refreshed.promise;
    });
    await act(async () => {
      older.resolve({
        routines: [],
        runs: [run("005", "r1", "Stale older feed")],
        has_more: false,
        runs_next_cursor: "stale",
        runs_has_more: true,
      });
      await older.promise;
    });
    await screen.findByText("Refreshed feed");
    expect(screen.queryByText("Stale older feed")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "routines.historyLoadOlder" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "dev-a", "new"));
  });

  it("rejects an older feed page started during a refresh after the first page lands", async () => {
    const older = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    const refreshed = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    let firstPages = 0;
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "") => {
      if (cursor === "old") return older.promise;
      if (cursor === "") {
        firstPages += 1;
        if (firstPages === 1)
          return {
            routines: [],
            runs: [run("010", "r1", "Original feed")],
            has_more: false,
            runs_next_cursor: "old",
            runs_has_more: true,
          };
        return refreshed.promise;
      }
      return {
        routines: [],
        runs: [],
        has_more: false,
        runs_next_cursor: "",
        runs_has_more: false,
      };
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Original feed");
    fireEvent.change(screen.getByRole("textbox", { name: "routines.searchPlaceholder" }), {
      target: { value: "refresh" },
    });
    await waitFor(() => expect(firstPages).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenCalledWith(10, "dev-a", "old"));
    await act(async () => {
      refreshed.resolve({
        routines: [],
        runs: [run("020", "r1", "Refreshed feed")],
        has_more: false,
        runs_next_cursor: "new",
        runs_has_more: true,
      });
      await refreshed.promise;
    });
    await screen.findByText("Refreshed feed");
    await act(async () => {
      older.resolve({
        routines: [],
        runs: [run("005", "r1", "Stale older feed")],
        has_more: false,
        runs_next_cursor: "stale",
        runs_has_more: true,
      });
      await older.promise;
    });
    expect(screen.queryByText("Stale older feed")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "routines.historyLoadOlder" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "dev-a", "new"));
  });

  it("ignores an older feed rejection started during a refresh after the first page lands", async () => {
    const older = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    const refreshed = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    let firstPages = 0;
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "") => {
      if (cursor === "old") return older.promise;
      if (cursor === "") {
        firstPages += 1;
        if (firstPages === 1)
          return {
            routines: [],
            runs: [run("010", "r1", "Original feed")],
            has_more: false,
            runs_next_cursor: "old",
            runs_has_more: true,
          };
        return refreshed.promise;
      }
      return { routines: [], runs: [], has_more: false };
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Original feed");
    fireEvent.change(screen.getByRole("textbox", { name: "routines.searchPlaceholder" }), {
      target: { value: "refresh" },
    });
    await waitFor(() => expect(firstPages).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenCalledWith(10, "dev-a", "old"));
    await act(async () => {
      refreshed.resolve({
        routines: [],
        runs: [run("020", "r1", "Refreshed feed")],
        has_more: false,
        runs_next_cursor: "new",
        runs_has_more: true,
      });
      await refreshed.promise;
    });
    await screen.findByText("Refreshed feed");
    await act(async () => {
      older.reject(new Error("stale in-flight older failure"));
      await expect(older.promise).rejects.toThrow("stale in-flight older failure");
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "routines.historyLoadOlder" })).toBeTruthy(),
    );
    expect(mocks.pushToast).not.toHaveBeenCalledWith("stale in-flight older failure", "error");
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

  it("releases older pagination when an authentication refresh expires", async () => {
    const refreshed = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    let firstPages = 0;
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "") => {
      if (cursor === "old")
        return new Promise<Awaited<ReturnType<typeof listRoutineRuns>>>(() => {});
      if (cursor === "") {
        firstPages += 1;
        if (firstPages === 1)
          return {
            routines: [],
            runs: [run("010", "r1", "Original feed")],
            has_more: false,
            runs_next_cursor: "old",
            runs_has_more: true,
          };
        return refreshed.promise;
      }
      return { routines: [], runs: [], has_more: false };
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Original feed");
    fireEvent.click(screen.getByRole("button", { name: "routines.historyLoadOlder" }));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenCalledWith(10, "dev-a", "old"));
    fireEvent.change(screen.getByRole("textbox", { name: "routines.searchPlaceholder" }), {
      target: { value: "expired" },
    });
    await waitFor(() => expect(firstPages).toBe(2));
    await act(async () => {
      const error = new ApiError(401, "expired");
      refreshed.reject(error);
      await expect(refreshed.promise).rejects.toThrow("expired");
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "routines.historyLoadOlder" })).toBeTruthy(),
    );
  });

  it("keeps an older routine history rejection and cursor behind a reopened first page", async () => {
    const older = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
    const firstPages: Array<
      ReturnType<typeof deferred<Awaited<ReturnType<typeof listRoutineRuns>>>>
    > = [];
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "History")],
      has_more: false,
    });
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "", id = "") => {
      if (id !== "r1") return { routines: [], runs: [], has_more: false };
      if (cursor === "old") return older.promise;
      if (cursor === "") {
        const page = deferred<Awaited<ReturnType<typeof listRoutineRuns>>>();
        firstPages.push(page);
        return page.promise;
      }
      return {
        routines: [],
        runs: [],
        has_more: false,
        runs_next_cursor: "",
        runs_has_more: false,
      };
    });
    renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: "routines.showRuns" }));
    await act(async () => {
      firstPages[0].resolve({
        routines: [],
        runs: [run("010", "r1", "Original history")],
        has_more: false,
        runs_next_cursor: "old",
        runs_has_more: true,
      });
      await firstPages[0].promise;
    });
    const panel = (await screen.findAllByRole("region", { name: /routines\.runsPanelTitle/ })).find(
      (region) => region.parentElement?.className.includes("md:hidden"),
    )!;
    await within(panel).findByRole("link", { name: "Original history" });
    fireEvent.click(within(panel).getByRole("button", { name: "routines.historyLoadOlder" }));
    fireEvent.click(screen.getByRole("button", { name: /routines.editRoutine/ }));
    await screen.findByDisplayValue("The whole stored prompt");
    await waitFor(() => expect(firstPages).toHaveLength(2));
    await act(async () => {
      firstPages[1].resolve({
        routines: [],
        runs: [run("020", "r1", "Refreshed history")],
        has_more: false,
        runs_next_cursor: "new",
        runs_has_more: true,
      });
      await firstPages[1].promise;
    });
    await within(panel).findByRole("link", { name: "Refreshed history" });
    await act(async () => {
      older.reject(new Error("stale history failure"));
      await expect(older.promise).rejects.toThrow("stale history failure");
    });
    expect(mocks.pushToast).not.toHaveBeenCalledWith("stale history failure", "error");
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: "routines.historyLoadOlder" })).toBeTruthy(),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "routines.historyLoadOlder" }));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "dev-a", "new", "r1"));
  });

  it("pages one remote routine's own history below the global feed", async () => {
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "Own records")],
      has_more: false,
    });
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "", id = "") => {
      if (id !== "r1")
        return {
          routines: [],
          runs: [run("009", "other", "Unrelated run")],
          has_more: false,
          runs_next_cursor: "009",
          runs_has_more: true,
        };
      if (cursor === "001")
        return {
          routines: [],
          runs: [run("000", "r1", "Older own run")],
          has_more: false,
          runs_next_cursor: "000",
          runs_has_more: false,
        };
      return {
        routines: [],
        runs: [run("001", "r1", "Old own run")],
        has_more: false,
        runs_next_cursor: "001",
        runs_has_more: true,
      };
    });
    renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: "routines.showRuns" }));
    const panel = (await screen.findAllByRole("region", { name: /routines\.runsPanelTitle/ })).find(
      (region) => region.parentElement?.className.includes("md:hidden"),
    )!;
    await within(panel).findByRole("link", { name: "Old own run" });
    expect(listRoutineRuns).toHaveBeenCalledWith(10, "dev-a", "", "r1");
    fireEvent.click(within(panel).getByRole("button", { name: "routines.historyLoadOlder" }));
    await within(panel).findByRole("link", { name: "Older own run" });
    expect(within(panel).getByRole("link", { name: "Old own run" })).toBeTruthy();
    expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "dev-a", "001", "r1");
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

  it("reads local run histories as bounded summaries with the same independent cursor", async () => {
    mocks.machines = [{ isSelf: true, id: "self-1", label: "Local node", online: true, roots: [] }];
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "Original")],
      has_more: false,
    });
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "", id = "") => {
      if (id !== "r1") return { routines: [], runs: [], has_more: false };
      if (cursor === "003")
        return {
          routines: [],
          runs: [run("002", "r1", "Older local summary")],
          runs_has_more: false,
          runs_next_cursor: "",
          has_more: false,
        };
      return {
        routines: [],
        runs: [run("003", "r1", "Local summary")],
        runs_has_more: true,
        runs_next_cursor: "003",
        has_more: false,
      };
    });
    renderApp("/routines");
    await screen.findByText("Original");
    await waitFor(() => expect(machineValue()).toBe("self"));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenCalledWith(10, ""));
    await userEvent.click(screen.getByRole("button", { name: "routines.showRuns" }));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenCalledWith(10, "", "", "r1"));
    const panel = (await screen.findAllByRole("region", { name: /routines\.runsPanelTitle/ })).find(
      (region) => region.parentElement?.className.includes("md:hidden"),
    )!;
    await within(panel).findByRole("link", { name: "Local summary" });
    await userEvent.click(within(panel).getByRole("button", { name: "routines.historyLoadOlder" }));
    await within(panel).findByRole("link", { name: "Older local summary" });
    expect(within(panel).getByRole("link", { name: "Local summary" })).toBeTruthy();
    expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "", "003", "r1");
  });

  it("a failed new remote history read is visible and retryable", async () => {
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "Failure history")],
      has_more: false,
    });
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, _cursor = "", id = "") =>
      id === "r1"
        ? Promise.reject(new Error("history unavailable"))
        : Promise.resolve({ routines: [], runs: [], has_more: false }),
    );
    renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: "routines.showRuns" }));
    const panels = (
      await screen.findAllByRole("region", { name: /routines\.runsPanelTitle/ })
    ).filter((region) => region.parentElement?.className.includes("md:hidden"));
    await within(panels[0]).findByText("history unavailable");
    expect(within(panels[0]).getByRole("button", { name: "routines.retry" })).toBeTruthy();
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

  it("does not let an old A mark-all clear unread rows after A → B → A", async () => {
    const markAll = deferred<{ marked: number }>();
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, device) => ({
      routines: [],
      runs: [run(`${device}-run`, "routine-1", `${device} report`)],
      has_more: false,
    }));
    vi.mocked(markAllRoutineRunsRead).mockReturnValueOnce(markAll.promise);
    const { router } = renderApp("/routines?device=dev-a");
    await screen.findByText("dev-a report");

    fireEvent.click(screen.getByRole("button", { name: "routines.markAllRead" }));
    await waitFor(() => expect(markAllRoutineRunsRead).toHaveBeenCalledWith("dev-a"));

    await navigate(router, "/routines?device=dev-b");
    await screen.findByText("dev-b report");
    await navigate(router, "/routines?device=dev-a");
    await screen.findByText("dev-a report");

    await act(async () => {
      markAll.resolve({ marked: 1 });
      await markAll.promise;
    });
    expect(screen.getByRole("button", { name: "routines.markRead" })).not.toBeNull();
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

describe("marking a remote routine run read from its link", () => {
  it("keeps the browser's modifier-click default and still marks the run read", async () => {
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, device) => ({
      routines: [],
      runs: [run(`${device}-run`, "routine-1", `${device} report`)],
      has_more: false,
    }));
    vi.mocked(markRoutineRunRead).mockReturnValue(new Promise(() => {}));
    renderApp("/routines?device=dev-a");
    const link = await screen.findByRole("link", { name: "dev-a report" });

    const modifiers = ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const;
    for (const [index, modifier] of modifiers.entries()) {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        [modifier]: true,
      });
      expect(link.dispatchEvent(event)).toBe(true);
      await waitFor(() => expect(markRoutineRunRead).toHaveBeenCalledTimes(index + 1));
      expect(markRoutineRunRead).toHaveBeenLastCalledWith("dev-a-run", "dev-a");
    }
    // None of the modified clicks moved the console itself.
    expect(screen.getByRole("link", { name: "dev-a report" })).toBeTruthy();
  });

  it("marks an ordinary click once and swallows a failed write", async () => {
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, device) => ({
      routines: [],
      runs: [run(`${device}-run`, "routine-1", `${device} report`)],
      has_more: false,
    }));
    vi.mocked(markRoutineRunRead).mockRejectedValue(new Error("offline"));
    vi.mocked(markRoutineRunRead).mockClear();
    renderApp("/routines?device=dev-a");
    const link = await screen.findByRole("link", { name: "dev-a report" });

    fireEvent.click(link);

    await waitFor(() => expect(markRoutineRunRead).toHaveBeenCalledTimes(1));
    expect(markRoutineRunRead).toHaveBeenCalledWith("dev-a-run", "dev-a");
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
    await screen.findByText("routines.emptyFeed");
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

  it("keeps mark-all-read, page retry, silent toggle and history pagination on the facade", async () => {
    // Mark all read.
    vi.mocked(listRoutineRuns).mockResolvedValue({
      routines: [],
      runs: [run("m1", "routine-1", "Marked run")],
      has_more: false,
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Marked run");
    const markAll = screen.getByRole("button", { name: "routines.markAllRead" });
    expect(markAll.classList.contains("kin-btn")).toBe(true);
    expect(markAll.classList.contains("kin-btn-secondary")).toBe(true);
    fireEvent.click(markAll);
    await waitFor(() => expect(markAllRoutineRunsRead).toHaveBeenCalledWith("dev-a"));
    cleanup();

    // Show / hide silent runs.
    vi.mocked(listRoutineRuns).mockResolvedValue({
      routines: [],
      runs: [{ ...run("s1", "routine-1", "Silent run"), routine_noteworthy: false }],
      has_more: false,
    });
    renderApp("/routines?device=dev-a");
    const showSilent = await screen.findByRole("button", { name: "routines.showSilent" });
    expect(showSilent.classList.contains("kin-btn")).toBe(true);
    fireEvent.click(showSilent);
    expect(await screen.findByText("Silent run")).toBeTruthy();
    expect(screen.getByRole("button", { name: "routines.hideSilent" })).toBeTruthy();
    cleanup();

    // The global feed's load older still asks with the feed's own cursor.
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, cursor = "") =>
      cursor
        ? {
            routines: [],
            runs: [run("f0", "routine-1", "Older run")],
            has_more: false,
            runs_next_cursor: "",
            runs_has_more: false,
          }
        : {
            routines: [],
            runs: [run("f1", "routine-1", "New run")],
            has_more: false,
            runs_next_cursor: "feed-1",
            runs_has_more: true,
          },
    );
    renderApp("/routines?device=dev-a");
    await screen.findByText("New run");
    const feedOlder = screen.getByRole("button", { name: "routines.historyLoadOlder" });
    expect(feedOlder.classList.contains("kin-btn")).toBe(true);
    fireEvent.click(feedOlder);
    await screen.findByText("Older run");
    await waitFor(() => expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "dev-a", "feed-1"));
    cleanup();

    // The page's load retry still re-runs the load.
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

    // One routine's own load older still asks with that routine's cursor.
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("r1", "Selected routine")],
      next_cursor: "",
      has_more: false,
    });
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, before = "", id = "") => {
      if (id !== "r1")
        return {
          routines: [],
          runs: [],
          has_more: false,
          runs_next_cursor: "",
          runs_has_more: false,
        };
      return before
        ? {
            routines: [],
            runs: [run("h0", "r1", "Older history")],
            has_more: false,
            runs_next_cursor: "",
            runs_has_more: false,
          }
        : {
            routines: [],
            runs: [run("h1", "r1", "First history")],
            has_more: false,
            runs_next_cursor: "history-1",
            runs_has_more: true,
          };
    });
    renderApp("/routines?device=dev-a");
    await screen.findByText("Selected routine");
    fireEvent.click(await screen.findByRole("button", { name: "routines.showRuns" }));
    const panel = (await screen.findAllByRole("region", { name: /routines\.runsPanelTitle/ })).find(
      (region) => region.parentElement?.className.includes("md:hidden"),
    )!;
    await within(panel).findByRole("link", { name: "First history" });
    const panelOlder = within(panel).getByRole("button", { name: "routines.historyLoadOlder" });
    expect(panelOlder.classList.contains("kin-btn")).toBe(true);
    fireEvent.click(panelOlder);
    await within(panel).findByRole("link", { name: "Older history" });
    expect(listRoutineRuns).toHaveBeenLastCalledWith(10, "dev-a", "history-1", "r1");
  });
});
