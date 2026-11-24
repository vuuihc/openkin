// @vitest-environment jsdom
// The 2026-11-24 dogfood finding: at 390 a waiting 等待处理 strip floats over
// the second routine card's 立即运行 and 编辑, and the routines pane had no
// scroll room to bring them clear (`scrollHeight == clientHeight == 714`). The
// strip stays — it is this tab root's only pending-approval entry — and the
// pane reserves the band the surface publishes: `FloatingApproval` measures the
// pill, `.phone-approval-clearance` spends it as bottom padding on phone
// widths.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import RoutinesPage from "./RoutinesPage";
import { setLocale } from "../i18n";
import { listRoutines, type Routine } from "../api/client";
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

// jsdom rewrites import.meta.url to an http URL, so resolve from the package
// root Vitest runs in (ui/).
const SOURCE = readFileSync(join(process.cwd(), "src/pages/RoutinesPage.tsx"), "utf8");
const CSS = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

function renderPage() {
  const router = createMemoryRouter([{ path: "/routines", element: <RoutinesPage /> }], {
    initialEntries: ["/routines?device=dev-a"],
  });
  return render(<RouterProvider router={router} />);
}

function scroller(view: ReturnType<typeof renderPage>): HTMLElement {
  return view.container.firstElementChild as HTMLElement;
}

function standardMachines() {
  return [{ isSelf: true, id: "self-1", label: "Local node", online: true, roots: [] }];
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
    routines: [routine("r0", "Routine 0"), routine("r1", "Routine 1")],
    next_cursor: "",
    has_more: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RoutinesPage clears the approval strip", () => {
  it("reserves the approval strip band on the routines scroller", async () => {
    const view = renderPage();
    await screen.findByText("Routine 0");

    const list = scroller(view);
    // The footer's clearance is still the base (`phoneFooterGlass.test.ts`
    // pins that class); the strip's band is the addition that scrolls the
    // routine controls clear on a phone.
    expect(list.classList.contains("phone-footer-clearance")).toBe(true);
    expect(list.classList.contains("phone-approval-clearance")).toBe(true);
  });

  it("leaves the routines scroller's clearance unchanged when no strip band is published", async () => {
    // No FloatingApproval is mounted in this tree, so nothing has published a
    // band. The CSS fallback is what a page with nothing pending keeps: the
    // `0px` var fallbacks make the max() resolve to exactly today's footer
    // clearance (54 + 8 + 12).
    expect(document.documentElement.style.getPropertyValue("--approval-strip-height")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--approval-strip-bottom")).toBe("");

    const rule = CSS.match(
      /@media \(max-width: 767\.98px\)\s*\{\s*\.phone-approval-clearance\s*\{([^}]*)\}/,
    );
    expect(rule, "the phone rule exists").not.toBeNull();
    const body = rule![1];
    expect(body).toMatch(/padding-bottom:\s*max\(\s*var\(--phone-footer-clearance\)/);
    expect(body).toMatch(/var\(--approval-strip-height,\s*0px\)/);
    expect(body).toMatch(/var\(--approval-strip-bottom,\s*0px\)/);
    expect(body).toMatch(/\+\s*8px/);
  });

  it("declares the strip clearance inside the phone media query", () => {
    // KIN-CONTINUE-005 declared the footer's geometry once; this rule follows
    // the same shape. It has to sit in the phone query (a desktop pane must
    // not grow a band for a strip it does not share space with) and it has to
    // consume the published variable rather than a guessed constant.
    expect(CSS).toMatch(
      /@media \(max-width: 767\.98px\)\s*\{\s*\.phone-approval-clearance\s*\{[^}]*padding-bottom:\s*max\([^}]*var\(--approval-strip-height,\s*0px\)[^}]*var\(--approval-strip-bottom,\s*0px\)[^}]*\)/,
    );
    // The scroller names it next to the footer class, not inside a page-local
    // inline style.
    expect(SOURCE).toContain("phone-footer-clearance phone-approval-clearance");
  });
});
