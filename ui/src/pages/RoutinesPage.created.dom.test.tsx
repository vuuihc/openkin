// @vitest-environment jsdom
// R-newchat-createdid: a routine created from New chat's "as routine" toggle
// lands here named in router state, and a routine created from this page's own
// form is prepended. Both must point at the row that was just made, for this
// visit only — the mark is not selection and does not survive leaving.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import RoutinesPage from "./RoutinesPage";
import { setLocale } from "../i18n";
import { createRoutine, listRoutineRuns, listRoutines, type Routine } from "../api/client";
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

/** The machine picker and the two filters; each test addresses it by its label. */
vi.mock("../components/ui/SheetSelect", () => ({
  default: (props: {
    label: string;
    value: string;
    options: Array<{ id: string; label: string }>;
    display?: string;
    onChange: (id: string) => void;
  }) => (
    <div data-testid={`select-${props.label}`} data-value={props.value}>
      <span data-testid={`select-${props.label}-current`}>{props.display ?? props.value}</span>
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

type Entry = string | { pathname: string; search?: string; state: unknown };

function renderApp(initial: Entry) {
  const router = createMemoryRouter(
    [
      { path: "/routines", element: <RoutinesPage /> },
      { path: "/other", element: <p>elsewhere</p> },
    ],
    { initialEntries: [initial] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

async function navigate(router: ReturnType<typeof createMemoryRouter>, to: string) {
  await act(async () => {
    await router.navigate(to);
  });
}

async function goBack(router: ReturnType<typeof createMemoryRouter>) {
  await act(async () => {
    await router.navigate(-1);
  });
}

function standardMachines() {
  return [
    { isSelf: true, id: "self-1", label: "Local node", online: true, roots: [] },
    { isSelf: false, id: "dev-a", label: "Test node A", online: true, roots: [] },
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

function page(routines: Routine[]): Page {
  return { routines, next_cursor: "", has_more: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const rowOf = (title: string) => screen.getByText(title).closest("li")!;

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
  vi.mocked(listRoutines).mockReset();
  vi.mocked(listRoutineRuns).mockReset();
  vi.mocked(createRoutine).mockReset();
  vi.mocked(listRoutines).mockResolvedValue(page([]));
  vi.mocked(listRoutineRuns).mockResolvedValue({ routines: [], runs: [], has_more: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RoutinesPage created routine arrival", () => {
  it("marks the routine named by location.state.createdId", async () => {
    vi.mocked(listRoutines).mockResolvedValue(
      page([routine("r-1", "One"), routine("r-2", "Two"), routine("r-3", "Three")]),
    );
    renderApp({ pathname: "/routines", state: { createdId: "r-2" } });

    await screen.findByText("Two");
    await waitFor(() => expect(rowOf("Two").getAttribute("data-just-created")).toBe("true"));
    expect(rowOf("One").hasAttribute("data-just-created")).toBe(false);
    expect(rowOf("Three").hasAttribute("data-just-created")).toBe(false);
    // The mark is an arrival cue, not selection: the row's select control is
    // still unpressed and nothing was opened.
    expect(
      within(rowOf("Two")).getByRole("button", { name: "routines.showRuns" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");
    // It is brought on screen even when the saved list scroll was elsewhere.
    expect(vi.mocked(Element.prototype.scrollIntoView)).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("clears the one-shot state so a return visit does not mark again", async () => {
    vi.mocked(listRoutines).mockResolvedValue(page([routine("r-1", "One"), routine("r-2", "Two")]));
    // `?device=self` is already the choice, so the page's own URL write stays
    // out of the way: only the one-shot clear can remove this state.
    const { router } = renderApp({
      pathname: "/routines",
      search: "?device=self",
      state: { createdId: "r-2" },
    });
    await screen.findByText("Two");
    await waitFor(() => expect(router.state.location.state).toBeNull());

    await navigate(router, "/other");
    await screen.findByText("elsewhere");
    // Back to the very entry the page replaced, not a fresh push: a state that
    // was only consumed in memory would mark the row again here.
    await goBack(router);    await screen.findByText("Two");
    expect(document.querySelector('[data-just-created="true"]')).toBeNull();
  });

  it("keeps the mark until the list arrives", async () => {
    const pending = deferred<Page>();
    vi.mocked(listRoutines).mockReturnValue(pending.promise);
    const { router } = renderApp({ pathname: "/routines", state: { createdId: "r-2" } });

    // Consumed (and cleared) while the rows are still in flight.
    await waitFor(() => expect(router.state.location.state).toBeNull());
    await act(async () => {
      pending.resolve(page([routine("r-1", "One"), routine("r-2", "Two")]));
      await pending.promise;
    });

    await screen.findByText("Two");
    expect(rowOf("Two").getAttribute("data-just-created")).toBe("true");
    expect(rowOf("One").hasAttribute("data-just-created")).toBe(false);
  });

  it("marks a routine created from the page's own form", async () => {
    vi.mocked(listRoutines).mockResolvedValue(page([routine("r-1", "One")]));
    vi.mocked(createRoutine).mockResolvedValue(routine("r-new", "Fresh"));
    renderApp("/routines");
    await screen.findByText("One");

    fireEvent.click(screen.getAllByRole("button", { name: "routines.createEntry" })[0]);
    fireEvent.change(screen.getByLabelText("routines.promptLabel"), {
      target: { value: "fresh prompt" },
    });
    fireEvent.change(screen.getByLabelText("cwd"), { target: { value: "/work/alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "routines.createAndOpen" }));

    await screen.findByText("Fresh");
    expect(rowOf("Fresh").getAttribute("data-just-created")).toBe("true");
    expect(rowOf("One").hasAttribute("data-just-created")).toBe(false);
  });

  it("marks nothing without a createdId", async () => {
    vi.mocked(listRoutines).mockResolvedValue(page([routine("r-1", "One")]));
    const { router } = renderApp("/routines");

    await screen.findByText("One");
    expect(document.querySelector('[data-just-created="true"]')).toBeNull();
    expect(router.state.location.state ?? null).toBeNull();
    expect(vi.mocked(Element.prototype.scrollIntoView)).not.toHaveBeenCalled();
  });

  it("marks nothing when the named routine is not in the loaded page", async () => {
    vi.mocked(listRoutines).mockResolvedValue(page([routine("r-1", "One")]));
    const { router } = renderApp({ pathname: "/routines", state: { createdId: "r-gone" } });

    await screen.findByText("One");
    await waitFor(() => expect(router.state.location.state).toBeNull());
    expect(document.querySelector('[data-just-created="true"]')).toBeNull();
    expect(mocks.pushToast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });
});
