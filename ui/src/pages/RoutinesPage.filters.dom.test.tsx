// @vitest-environment jsdom
// R-routine-filters: the routines list narrows by 状态 and 目录, both server-side
// and both owned by the URL. These tests pin the request each filter turns
// into, the cursor generation that a filter change must throw away, and the
// machine switch that keeps 状态 but drops a directory.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import RoutinesPage from "./RoutinesPage";
import { setLocale } from "../i18n";
import { listRoutineRuns, listRoutines, patchRoutine, type Routine } from "../api/client";
import type { WSMessage } from "../api/contract";
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
vi.mock("../components/chat/PermissionModePicker", () => ({ default: () => null }));
vi.mock("../components/routine/RoutineScheduleFields", () => ({
  default: () => null,
  defaultNextRunLocal: () => "",
  parseLocalDateTime: () => null,
  toLocalInputValue: () => "",
}));

/**
 * The page mounts three of these — the machine picker and the two filters.
 * Each is addressable by its label, and its rows are always rendered so a
 * test chooses a value the same way the real chip's menu would.
 */
vi.mock("../components/ui/SheetSelect", () => ({
  default: (props: {
    label: string;
    value: string;
    options: Array<{ id: string; label: string }>;
    display?: string;
    onChange: (id: string) => void;
  }) => (
    <div data-testid={`select-${props.label}`} data-value={props.value}>
      <span data-testid={`select-${props.label}-current`}>
        {props.display ??
          props.options.find((option) => option.id === props.value)?.label ??
          props.value}
      </span>
      {props.options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`select-${props.label}-option-${option.id}`}
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

function paramsOf(router: ReturnType<typeof createMemoryRouter>): URLSearchParams {
  const location = router.state.location;
  return new URLSearchParams(location.search);
}

function standardMachines() {
  return [
    { isSelf: true, id: "self-1", label: "Local node", online: true, roots: [] },
    { isSelf: false, id: "dev-a", label: "Test node A", online: true, roots: [] },
    { isSelf: false, id: "dev-b", label: "Test node B", online: true, roots: [] },
  ];
}

function routine(id: string, title: string, overrides: Partial<Routine> = {}): Routine {
  return {
    id,
    cwd: "/work/alpha",
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

type Page = { routines: Routine[]; next_cursor: string; has_more: boolean };

function page(routines: Routine[], next = "", hasMore = false): Page {
  return { routines, next_cursor: next, has_more: hasMore };
}

const statusOption = (id: string) =>
  screen.getByTestId(`select-routines.filterStatus-option-${id}`);
const directoryOption = (id: string) =>
  screen.getByTestId(`select-routines.filterDirectory-option-${id}`);

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
  // Module mocks keep their call history across tests; a "find the call that
  // matched" assertion would otherwise read a previous test's request.
  vi.mocked(listRoutines).mockReset();
  vi.mocked(listRoutineRuns).mockReset();
  vi.mocked(patchRoutine).mockReset();
  vi.mocked(listRoutines).mockResolvedValue(page([]));
  vi.mocked(listRoutineRuns).mockResolvedValue({ routines: [], runs: [], has_more: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RoutinesPage filters", () => {
  it("sends 已暂停 as enabled=false with neither cwd nor outcome, keeping the machine", async () => {
    vi.mocked(listRoutines).mockResolvedValue(
      page([routine("alpha", "Alpha", { enabled: false })]),
    );
    const { router } = renderApp("/routines?device=dev-a");
    await screen.findByText("Alpha");
    fireEvent.click(statusOption("paused"));
    await waitFor(() => expect(paramsOf(router).get("status")).toBe("paused"));
    expect(paramsOf(router).get("device")).toBe("dev-a");
    await waitFor(() => {
      const call = vi
        .mocked(listRoutines)
        .mock.calls.find(([options]) => options?.enabled === false);
      expect(call).toBeTruthy();
      expect(call?.[1]).toBe("dev-a");
      expect(call?.[0]).not.toHaveProperty("cwd");
      expect(call?.[0]).not.toHaveProperty("outcome");
    });
  });

  it("sends 最近失败 as outcome=failed and no enabled", async () => {
    vi.mocked(listRoutines).mockResolvedValue(
      page([routine("broken", "Broken", { last_outcome: "failed" })]),
    );
    const { router } = renderApp("/routines?device=dev-a");
    await screen.findByText("Broken");
    fireEvent.click(statusOption("failed"));
    await waitFor(() => expect(paramsOf(router).get("status")).toBe("failed"));
    await waitFor(() => {
      const call = vi
        .mocked(listRoutines)
        .mock.calls.find(([options]) => options?.outcome === "failed");
      expect(call).toBeTruthy();
      expect(call?.[0]).not.toHaveProperty("enabled");
    });
  });

  it("sends a chosen directory as cwd with no enabled or outcome", async () => {
    vi.mocked(listRoutines).mockResolvedValue(
      page([
        routine("alpha", "Alpha", { cwd: "/work/alpha" }),
        routine("beta", "Beta", { cwd: "/work/beta" }),
      ]),
    );
    const { router } = renderApp("/routines?device=dev-a");
    await screen.findByText("Alpha");
    fireEvent.click(directoryOption("/work/alpha"));
    await waitFor(() => expect(paramsOf(router).get("cwd")).toBe("/work/alpha"));
    await waitFor(() => {
      const call = vi
        .mocked(listRoutines)
        .mock.calls.find(([options]) => options?.cwd === "/work/alpha");
      expect(call).toBeTruthy();
      expect(call?.[0]).not.toHaveProperty("enabled");
      expect(call?.[0]).not.toHaveProperty("outcome");
    });
  });

  it("paginates inside the filter, sending the same status and directory", async () => {
    vi.mocked(listRoutines).mockImplementation(async (options) => {
      if (options?.cursor === "p1")
        return page([routine("older", "Older paused", { enabled: false })]);
      if (options?.cwd === "/work/alpha" && options?.enabled === false) {
        return page([routine("first", "First paused", { enabled: false })], "p1", true);
      }
      return page([
        routine("alpha", "Alpha", { cwd: "/work/alpha" }),
        routine("beta", "Beta", { cwd: "/work/beta" }),
      ]);
    });
    renderApp("/routines?device=dev-a&status=paused&cwd=/work/alpha");
    await screen.findByText("First paused");
    fireEvent.click(screen.getByRole("button", { name: "routines.loadMore" }));
    await screen.findByText("Older paused");
    const call = vi.mocked(listRoutines).mock.calls.find(([options]) => options?.cursor === "p1");
    expect(call?.[1]).toBe("dev-a");
    expect(call?.[0]).toMatchObject({ enabled: false, cwd: "/work/alpha" });
    expect(call?.[0]).not.toHaveProperty("outcome");
  });

  it("drops a paginated generation when a filter changes", async () => {
    vi.mocked(listRoutines).mockImplementation(async (options) => {
      if (options?.cursor === "a1") return page([routine("old", "Old all row")]);
      if (options?.enabled === false) {
        return page([routine("paused", "Paused only", { enabled: false })]);
      }
      return page([routine("alpha", "Alpha"), routine("beta", "Beta")], "a1", true);
    });
    const { router } = renderApp("/routines?device=dev-a");
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "routines.loadMore" }));
    await screen.findByText("Old all row");
    fireEvent.click(statusOption("paused"));
    await waitFor(() => expect(paramsOf(router).get("status")).toBe("paused"));
    await screen.findByText("Paused only");
    for (const gone of ["Alpha", "Beta", "Old all row"]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it("applies both filters from the URL on mount", async () => {
    vi.mocked(listRoutines).mockResolvedValue(
      page([routine("paused-alpha", "Paused alpha", { enabled: false })]),
    );
    renderApp("/routines?device=dev-a&status=paused&cwd=/work/alpha");
    await screen.findByText("Paused alpha");
    const call = vi.mocked(listRoutines).mock.calls.find(([options]) => options?.enabled === false);
    expect(call?.[0]).toMatchObject({ cwd: "/work/alpha" });
  });

  it("reads an unknown status as 全部", async () => {
    vi.mocked(listRoutines).mockResolvedValue(page([routine("alpha", "Alpha")]));
    renderApp("/routines?device=dev-a&status=weird");
    await screen.findByText("Alpha");
    expect(
      vi
        .mocked(listRoutines)
        .mock.calls.some(([options]) => options?.enabled != null || options?.outcome != null),
    ).toBe(false);
    const current = screen.getByTestId("select-routines.filterStatus-current");
    expect(current.textContent).not.toBe("");
  });

  it("keeps 状态 and drops 目录 when the machine changes", async () => {
    vi.mocked(listRoutines).mockResolvedValue(page([routine("alpha", "Alpha")]));
    const { router } = renderApp("/routines?device=dev-a&status=paused&cwd=/work/alpha");
    await waitFor(() => expect(paramsOf(router).get("cwd")).toBe("/work/alpha"));
    fireEvent.click(screen.getByTestId("select-machine.title-option-dev-b"));
    await waitFor(() => expect(paramsOf(router).get("device")).toBe("dev-b"));
    expect(paramsOf(router).get("status")).toBe("paused");
    expect(paramsOf(router).get("cwd")).toBeNull();
    await waitFor(() =>
      expect(
        vi
          .mocked(listRoutines)
          .mock.calls.some(([options, device]) => device === "dev-b" && options?.enabled === false),
      ).toBe(true),
    );
  });

  it("re-reads the list after a toggle under 已启用, so the paused row leaves", async () => {
    let paused = false;
    vi.mocked(listRoutines).mockImplementation(async (options) => {
      if (options?.enabled === true) return page(paused ? [] : [routine("alpha", "Alpha")]);
      return page([routine("alpha", "Alpha", { enabled: false })]);
    });
    vi.mocked(patchRoutine).mockImplementation(async () => {
      paused = true;
      return routine("alpha", "Alpha", { enabled: false });
    });
    renderApp("/routines?device=dev-a&status=enabled");
    await screen.findByText("Alpha");
    const row = screen.getByText("Alpha").closest("li") as HTMLLIElement;
    fireEvent.click(within(row).getByRole("button", { name: "routines.pause" }));
    await waitFor(() => expect(patchRoutine).toHaveBeenCalledTimes(1));
    // The second enabled read answers with no rows: the list must take that
    // answer instead of patching the row in place.
    await waitFor(() => expect(screen.queryByText("Alpha")).toBeNull());
    expect(screen.getByText("routines.filterEmpty")).toBeTruthy();
    expect(
      vi.mocked(listRoutines).mock.calls.filter(([options]) => options?.enabled === true).length,
    ).toBeGreaterThan(1);
  });

  it("renders the filtered-empty state with clear, not the list's create call to action", async () => {
    const { router } = renderApp("/routines?device=dev-a&status=paused");
    const empty = await screen.findByText("routines.filterEmpty");
    const block = empty.parentElement as HTMLElement;
    expect(within(block).getByRole("button", { name: "routines.filterClear" })).toBeTruthy();
    expect(within(block).queryByRole("button", { name: "routines.createEntry" })).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "routines.filterClear" }));
    await waitFor(() => expect(paramsOf(router).get("status")).toBeNull());
    expect(paramsOf(router).get("device")).toBe("dev-a");
  });
});
