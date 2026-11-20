// @vitest-environment jsdom
// Hiding quiet routine runs is a local, per-machine preference: it empties the
// inbox feed, never the run, and the routine's own history still lists it.
import { within, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import RoutinesPage from "./RoutinesPage";
import { setLocale } from "../i18n";
import { listRoutineRuns, listRoutines, runRoutineNow, type Routine, type Task } from "../api/client";
import type { WSMessage } from "../api/contract";
import { hideRunIds } from "../lib/routineHiddenRuns";
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

// Keep the vars in the accessible name so a test can read the count a line
// says, not only which key rendered.
vi.mock("../i18n/react", () => {
  const translate = (key: string, vars?: Record<string, string | number>) =>
    vars
      ? `${key}(${Object.entries(vars)
          .map(([name, value]) => `${name}=${value}`)
          .join(",")})`
      : key;
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

function standardMachines() {
  return [
    { isSelf: true, id: "self-1", label: "Local node", online: true, roots: [] },
    { isSelf: false, id: "dev-a", label: "Test node A", online: true, roots: [] },
    { isSelf: false, id: "dev-b", label: "Test node B", online: true, roots: [] },
  ];
}

function routine(id: string, title: string): Routine {
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
  };
}

function run(id: string, title: string, overrides: Partial<Task> = {}): Task {
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
    routine_id: "routine-1",
    routine_unread: true,
    routine_noteworthy: true,
    ...overrides,
  };
}

function quietRun(id: string, title: string, unread = false): Task {
  return run(id, title, { routine_noteworthy: false, routine_unread: unread });
}

function machineValue(): string | null {
  return screen.getByTestId("machine-picker").getAttribute("data-value");
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  mocks.machines = standardMachines();
  mocks.loading = false;
  mocks.failed = false;
  mocks.wsListeners.clear();
  vi.mocked(listRoutines).mockResolvedValue({ routines: [], next_cursor: "", has_more: false });
  vi.mocked(listRoutineRuns).mockResolvedValue({ routines: [], runs: [], has_more: false });
  vi.mocked(runRoutineNow).mockResolvedValue(undefined as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RoutinesPage hidden runs", () => {
  it("hides only read quiet runs, never noteworthy or unread ones", async () => {
    vi.mocked(listRoutineRuns).mockResolvedValue({
      routines: [],
      runs: [
        run("n1", "Noteworthy run", { routine_noteworthy: true, routine_unread: false }),
        quietRun("q1", "Quiet read run"),
        quietRun("q2", "Quiet unread run", true),
      ],
      has_more: false,
    });
    renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: /routines\.showSilent/ }));
    expect(await screen.findByText("Quiet read run")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "routines.hideEnded" }));

    // Hiding collapses the section; the noteworthy row is untouched and the
    // unread quiet run is only behind the toggle, never hidden.
    expect(screen.getByText("Noteworthy run")).toBeTruthy();
    expect(screen.queryByText("Quiet read run")).toBeNull();
    expect(screen.getByRole("button", { name: /routines\.hiddenEnded\(count=1\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /routines\.showSilent\(count=1\)/ }));
    expect(await screen.findByText("Quiet unread run")).toBeTruthy();
    expect(screen.queryByText("Quiet read run")).toBeNull();
  });

  it("remembers the hide across a remount for the same machine and not another", async () => {
    vi.mocked(listRoutineRuns).mockResolvedValue({
      routines: [],
      runs: [quietRun("q1", "Quiet read run")],
      has_more: false,
    });
    const first = renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: /routines\.showSilent/ }));
    fireEvent.click(await screen.findByRole("button", { name: "routines.hideEnded" }));
    expect(screen.queryByText("Quiet read run")).toBeNull();
    first.unmount();

    renderApp("/routines?device=dev-a");
    expect(await screen.findByRole("button", { name: /routines\.hiddenEnded/ })).toBeTruthy();
    expect(screen.queryByText("Quiet read run")).toBeNull();

    // Another machine has its own stored set: this hide does not apply there.
    fireEvent.click(screen.getByTestId("machine-option-dev-b"));
    await waitFor(() => expect(machineValue()).toBe("dev-b"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /routines\.hiddenEnded/ })).toBeNull(),
    );
    fireEvent.click(await screen.findByRole("button", { name: /routines\.showSilent/ }));
    expect(await screen.findByText("Quiet read run")).toBeTruthy();
  });

  it("leaves the routine's own history untouched", async () => {
    vi.mocked(listRoutines).mockResolvedValue({
      routines: [routine("routine-1", "Morning review")],
      next_cursor: "",
      has_more: false,
    });
    const hiddenRun = quietRun("q1", "Quiet read run");
    vi.mocked(listRoutineRuns).mockImplementation(async (_limit, _device, _cursor = "", id = "") => ({
      routines: [],
      runs: id ? [hiddenRun] : [hiddenRun],
      has_more: false,
    }));
    renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: /routines\.showSilent/ }));
    fireEvent.click(await screen.findByRole("button", { name: "routines.hideEnded" }));
    expect(screen.queryByText("Quiet read run")).toBeNull();

    // The history is the drill-down, and a hidden run is still findable there.
    fireEvent.click(await screen.findByRole("button", { name: /routines\.showRuns/ }));
    const panels = await screen.findAllByRole("region", { name: /routines\.runsPanelTitle/ });
    expect(panels.some((panel) => within(panel).queryByText("Quiet read run"))).toBe(true);
  });

  it("restores every hidden run from the same line", async () => {
    vi.mocked(listRoutineRuns).mockResolvedValue({
      routines: [],
      runs: [quietRun("q1", "Quiet read run"), quietRun("q2", "Second quiet run")],
      has_more: false,
    });
    renderApp("/routines?device=dev-a");
    fireEvent.click(await screen.findByRole("button", { name: /routines\.showSilent\(count=2\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "routines.hideEnded" }));

    // With every quiet run hidden the toggle is gone; the restore line is the
    // only control left in the section.
    expect(screen.queryByRole("button", { name: /routines\.showSilent/ })).toBeNull();
    const restore = screen.getByRole("button", { name: /routines\.hiddenEnded\(count=2\)/ });
    fireEvent.click(restore);

    expect(await screen.findByText("Quiet read run")).toBeTruthy();
    expect(screen.getByText("Second quiet run")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /routines\.hiddenEnded/ })).toBeNull();
  });

  it("keeps the restore line when the feed no longer lists a hidden run", async () => {
    // A machine's stored set can outlive the rows on the first feed page; the
    // restore path must not disappear with them.
    hideRunIds("dev-a", ["aged-out"]);
    renderApp("/routines?device=dev-a");
    const restore = await screen.findByRole("button", {
      name: /routines\.hiddenEnded\(count=1\)/,
    });
    expect(screen.queryByText("routines.emptyFeed")).toBeNull();

    fireEvent.click(restore);
    expect(await screen.findByText("routines.emptyFeed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /routines\.hiddenEnded/ })).toBeNull();
  });
});
