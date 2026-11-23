// @vitest-environment jsdom
// TASTE 15 / GOAL F4: opening a routine or visiting another area unmounts
// this page. The list the reader had scrolled halfway down must come back at
// the same place, and each machine keeps its own place.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import RoutinesPage from "./RoutinesPage";
import { setLocale } from "../i18n";
import { listRoutines, type Routine } from "../api/client";
import { getKeyedScroll, setKeyedScroll } from "../lib/sessionScroll";
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
vi.mock("../components/ui/SheetSelect", () => ({
  default: (props: { label: string; options: Array<{ id: string; label: string }> }) => (
    <div data-testid={props.label === "machine.title" ? "machine-picker" : "filter-picker"} />
  ),
}));

// jsdom has no layout and stores scrollTop without clamping, so a browser
// would hide any bug in the page's own clamp. Pin the measured heights and
// leave the setter raw: what the tests read back is exactly what the page
// asked for. A new element (a remount) starts at 0, so a restored offset can
// only come from the page itself.
const VIEWPORT = 600;
let contentHeight = 2000;
const tops = new WeakMap<Element, number>();
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get: () => contentHeight,
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => VIEWPORT,
});
Object.defineProperty(HTMLElement.prototype, "scrollTop", {
  configurable: true,
  get(this: HTMLElement) {
    return tops.get(this) ?? 0;
  },
  set(this: HTMLElement, value: number) {
    tops.set(this, Number(value) || 0);
  },
});

// jsdom rewrites import.meta.url to an http URL, so resolve from the package
// root Vitest runs in (ui/).
const SOURCE = readFileSync(join(process.cwd(), "src/pages/RoutinesPage.tsx"), "utf8");

function renderApp(initial: string) {
  const router = createMemoryRouter([{ path: "/routines", element: <RoutinesPage /> }], {
    initialEntries: [initial],
  });
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

function scroller(view: ReturnType<typeof renderApp>): HTMLElement {
  return view.container.firstElementChild as HTMLElement;
}

/**
 * The real return path: the list is one route, the runs destination another.
 * The existing cases never leave /routines; a reader leaves through 看运行,
 * which pushes /sessions, and Back or the footer tab pops back to /routines.
 * Both are route changes, so the page is genuinely gone in between.
 */
function renderWithRunsDestination(initial: string) {
  const router = createMemoryRouter(
    [
      { path: "/routines", element: <RoutinesPage /> },
      { path: "/sessions", element: <div data-testid="runs-destination">runs</div> },
    ],
    { initialEntries: [initial] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

/** Leave through the row's 看运行 link, the way the reader does. */
async function openRunsDestination() {
  fireEvent.click(screen.getAllByRole("button", { name: "routines.openRoutine" })[0]);
  // The selected row carries one link and the desktop aside carries the same
  // one. The aside is `hidden lg:block`, so a browser below lg does not show
  // it, while jsdom applies no CSS and does; either link is the same
  // destination.
  fireEvent.click((await screen.findAllByRole("link", { name: "routines.viewRunsFor" }))[0]);
  await screen.findByTestId("runs-destination");
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
    prompt: "",
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

function rows(count: number): Routine[] {
  return Array.from({ length: count }, (_, index) => routine(`r${index}`, `Routine ${index}`));
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  contentHeight = 2000;
  Element.prototype.scrollIntoView = vi.fn();
  mocks.machines = standardMachines();
  mocks.loading = false;
  mocks.failed = false;
  mocks.wsListeners.clear();
  mocks.pushToast.mockClear();
  mocks.reconnectGen = 0;
  vi.mocked(listRoutines).mockResolvedValue({
    routines: rows(20),
    next_cursor: "",
    has_more: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RoutinesPage keeps the list's place", () => {
  it("restores the list position after the page remounts", async () => {
    const first = renderApp("/routines?device=dev-a");
    await screen.findByText("Routine 0");

    const before = scroller(first);
    before.scrollTop = 480;
    fireEvent.scroll(before);
    first.unmount();

    const second = renderApp("/routines?device=dev-a");
    await screen.findByText("Routine 0");
    await waitFor(() => expect(scroller(second).scrollTop).toBe(480));
  });

  it("clamps a stored offset larger than the rendered list to 0", async () => {
    // Three rows do not fill the viewport, so there is nowhere to scroll.
    contentHeight = 120;
    vi.mocked(listRoutines).mockResolvedValue({
      routines: rows(3),
      next_cursor: "",
      has_more: false,
    });
    setKeyedScroll("routines:dev-a", 99999);

    const view = renderApp("/routines?device=dev-a");
    await screen.findByText("Routine 0");
    expect(scroller(view).scrollTop).toBe(0);
  });

  it("keeps a separate position per machine", async () => {
    const a = renderApp("/routines?device=dev-a");
    await screen.findByText("Routine 0");
    scroller(a).scrollTop = 480;
    fireEvent.scroll(scroller(a));
    a.unmount();

    const b = renderApp("/routines?device=dev-b");
    await screen.findByText("Routine 0");
    // B never inherits A's offset.
    expect(scroller(b).scrollTop).toBe(0);
    b.unmount();

    const backToA = renderApp("/routines?device=dev-a");
    await screen.findByText("Routine 0");
    await waitFor(() => expect(scroller(backToA).scrollTop).toBe(480));
  });

  it("restores each machine's place when the machine is switched in place", async () => {
    // The first control on the page switches machines without remounting it.
    // A per-mount restore would leave B at A's offset, and the render that
    // clears the list clamps and fires `scroll` — that clamp must not become
    // B's saved place, or A's own offset is lost on the way back.
    setKeyedScroll("routines:dev-b", 300);
    const view = renderApp("/routines?device=dev-a");
    await screen.findByText("Routine 0");
    const list = scroller(view);
    list.scrollTop = 480;
    fireEvent.scroll(list);
    expect(getKeyedScroll("routines:dev-a")).toBe(480);

    // Hold B's read open so the list-clearing render is what the reader (and
    // the browser's clamp) sees, exactly as during a real switch.
    let releaseB: (() => void) | null = null;
    vi.mocked(listRoutines).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseB = () => resolve({ routines: rows(20), next_cursor: "", has_more: false });
        }) as ReturnType<typeof listRoutines>,
    );
    await act(async () => {
      await view.router.navigate("/routines?device=dev-b");
    });
    // What a browser does when the list is replaced by a shorter one.
    list.scrollTop = 0;
    fireEvent.scroll(list);
    // A's clamped place must not become B's saved place.
    expect(getKeyedScroll("routines:dev-b")).toBe(300);
    await act(async () => {
      releaseB!();
    });
    await waitFor(() => expect(scroller(view).scrollTop).toBe(300));

    await act(async () => {
      await view.router.navigate("/routines?device=dev-a");
    });
    await waitFor(() => expect(scroller(view).scrollTop).toBe(480));
    expect(getKeyedScroll("routines:dev-a")).toBe(480);
  });

  it("restores after the automatic retry when the first read failed", async () => {
    // A sleeping machine is the state this page is built to survive: the first
    // read fails, the page retries by itself, and the saved place must still
    // apply when the rows finally arrive.
    vi.useFakeTimers();
    try {
      vi.mocked(listRoutines).mockRejectedValueOnce(new Error("machine asleep"));
      setKeyedScroll("routines:dev-a", 480);
      const view = renderApp("/routines?device=dev-a");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("machine asleep")).toBeTruthy();
      expect(scroller(view).scrollTop).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(screen.getByText("Routine 0")).toBeTruthy();
      expect(scroller(view).scrollTop).toBe(480);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the restore once the page has scrolled to the form", () => {
    // Not reachable through the DOM today: the edit control only exists after
    // the list has loaded, and the restore runs in that same commit. Guarded at
    // the source so a future form-opening path cannot be yanked back to the
    // saved list offset.
    expect(SOURCE).toContain("formScrolled.current = true;");
    expect(SOURCE).toContain("if (formScrolled.current) return;");
  });

  // The 2026-11-23 dogfood read this path as broken (scroll 600 → Back → 0);
  // its branch retracted the entry (c9b0c8b9) because the walk assigned
  // `scrollTop` and tapped in the same task, so no `scroll` event fired and
  // nothing was saved. Measured on this tree it restores on every route-change
  // return; these cases pin that, so a regression on the real path is caught
  // here instead of by the next dogfood pass.
  it("restores the list after returning from the routine runs destination", async () => {
    const view = renderWithRunsDestination("/routines?device=dev-a");
    await screen.findByText("Routine 0");
    const list = scroller(view);
    list.scrollTop = 480;
    fireEvent.scroll(list);
    expect(getKeyedScroll("routines:dev-a")).toBe(480);

    await openRunsDestination();
    await act(async () => {
      await view.router.navigate(-1);
    });
    await screen.findByText("Routine 0");
    await waitFor(() => expect(scroller(view).scrollTop).toBe(480));
  });

  it("restores the list when the tab returns instead of Back", async () => {
    const view = renderWithRunsDestination("/routines?device=dev-a");
    await screen.findByText("Routine 0");
    const list = scroller(view);
    list.scrollTop = 480;
    fireEvent.scroll(list);
    expect(getKeyedScroll("routines:dev-a")).toBe(480);

    await openRunsDestination();
    await act(async () => {
      await view.router.navigate("/routines?device=dev-a");
    });
    await screen.findByText("Routine 0");
    await waitFor(() => expect(scroller(view).scrollTop).toBe(480));
  });

  it("does not consume another machine's saved place on the return path", async () => {
    setKeyedScroll("routines:dev-b", 300);
    const view = renderWithRunsDestination("/routines?device=dev-a");
    await screen.findByText("Routine 0");
    const list = scroller(view);
    list.scrollTop = 480;
    fireEvent.scroll(list);
    expect(getKeyedScroll("routines:dev-a")).toBe(480);

    await openRunsDestination();
    await act(async () => {
      await view.router.navigate(-1);
    });
    await screen.findByText("Routine 0");
    await waitFor(() => expect(scroller(view).scrollTop).toBe(480));
    // B's place is still B's: the return applied A's, not a merged one.
    expect(getKeyedScroll("routines:dev-b")).toBe(300);
  });
});
