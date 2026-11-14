// @vitest-environment jsdom
// KIN-NOTIFY-001: a notification on an already-open routines page changes the
// machine, and a manual switch writes the same URL, so a second tap of the same
// notification is a real navigation again.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import {
  createRoutine,
  listRoutineRuns,
  listRoutines,
  markAllRoutineRunsRead,
  patchRoutine,
  type Routine,
  type Task,
} from "../api/client";
import { routineForm, routinePatch } from "../lib/routineEdit";
import RoutinesPage from "./RoutinesPage";

const mocks = vi.hoisted(() => ({
  machines: [] as Array<{
    isSelf: boolean;
    id: string;
    label: string;
    online: boolean;
    roots: unknown[];
  }>,
  loading: false,
  failed: false,
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
  ApiError: class ApiError extends Error {},
  createRoutine: vi.fn(),
  deleteRoutine: vi.fn(),
  isAuthenticated: () => true,
  isTerminal: () => true,
  listRoutineRuns: vi.fn(async () => []),
  listRoutines: vi.fn(async () => ({ routines: [], next_cursor: "", has_more: false })),
  listTasks: vi.fn(async () => []),
  markAllRoutineRunsRead: vi.fn(),
  markRoutineRunRead: vi.fn(),
  patchRoutine: vi.fn(),
  runRoutineNow: vi.fn(),
}));

vi.mock("../store/appStore", () => ({
  subscribeWS: () => () => {},
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({ pushToast: vi.fn(), reconnectGen: 0, auth: { status: "ok" } }),
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

vi.mock("../lib/routineHistory", () => ({
  appendOlderRuns: vi.fn(),
  foldRoutineRun: vi.fn(),
  pageCursor: () => "",
  reconcileRoutineReads: vi.fn(),
  ROUTINE_HISTORY_MAX: 100,
  ROUTINE_HISTORY_PAGE: 20,
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
    value: string;
    options: Array<{ id: string; label: string }>;
    onChange: (id: string) => void;
  }) => (
    <div data-testid="machine-picker" data-value={props.value}>
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
    { isSelf: true, id: "self-1", label: "This Mac", online: true, roots: [] },
    { isSelf: false, id: "dev-a", label: "MacBook A", online: true, roots: [] },
    { isSelf: false, id: "dev-b", label: "MacBook B", online: true, roots: [] },
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
  vi.mocked(listRoutines).mockResolvedValue({
    routines: [],
    next_cursor: "",
    has_more: false,
  });
  vi.mocked(listRoutineRuns).mockResolvedValue([]);
  vi.mocked(markAllRoutineRunsRead).mockResolvedValue({ marked: 0 });
  vi.mocked(routineForm).mockImplementation((value) => ({
    title: value.title,
    prompt: value.prompt,
    cwd: value.cwd,
    agent: value.agent,
    model: value.model ?? "",
    permissionMode: value.permission_mode,
    intervalSecs: value.interval_secs,
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
    await waitFor(() => expect(machineValue()).toBe("dev-a"));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenLastCalledWith(80, "dev-a"));
    await act(async () => {
      await router.navigate(1);
    });
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    await waitFor(() => expect(listRoutineRuns).toHaveBeenLastCalledWith(80, "dev-b"));
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

describe("RoutinesPage device-scoped requests", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "routines.save" }));
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
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, device) => [
      run(`${device}-run`, "routine-1", `${device} report`),
    ]);
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
