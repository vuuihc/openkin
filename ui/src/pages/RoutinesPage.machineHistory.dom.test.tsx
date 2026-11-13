// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { setLocale } from "../i18n";
import RoutinesPage from "./RoutinesPage";

/**
 * A machine switch is a view of the one routines screen.
 *
 * On a phone the routines page is one push above the list, so switching
 * `?device=A` to `?device=B` replaces that entry: `[list, routines B]`, and one
 * Back reaches the list. On a Mac the sidebar keeps the stack ordinary, so B
 * is pushed over A and Back shows the machine the reader came from.
 *
 * Real `BrowserRouter` history is the assertion: a MemoryRouter cannot tell a
 * replace from a push.
 */

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {},
  createRoutine: vi.fn(),
  deleteRoutine: vi.fn(),
  isAuthenticated: () => true,
  isTerminal: () => true,
  listRoutineRuns: vi.fn(async () => []),
  listRoutines: vi.fn(async (_params?: unknown, device?: string) => ({
    routines:
      device === "dev-b"
        ? [
            {
              id: "routine-b",
              title: "Machine B routine",
              cwd: "/work/b",
              agent: "kin",
              permission_mode: "default",
              prompt: "b",
              interval_secs: 86400,
              enabled: true,
              next_due_at: 1,
              consec_failures: 0,
              created_at: 1,
              updated_at: 1,
            },
          ]
        : [
            {
              id: "routine-a",
              title: "Machine A routine",
              cwd: "/work/a",
              agent: "kin",
              permission_mode: "default",
              prompt: "a",
              interval_secs: 86400,
              enabled: true,
              next_due_at: 1,
              consec_failures: 0,
              created_at: 1,
              updated_at: 1,
            },
          ],
    next_cursor: "",
    has_more: false,
  })),
  listTasks: vi.fn(async () => []),
  markAllRoutineRunsRead: vi.fn(async () => ({ marked: 0 })),
  markRoutineRunRead: vi.fn(),
  patchRoutine: vi.fn(),
  runRoutineNow: vi.fn(),
}));

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "hub", label: "Hub", isSelf: true, online: true, roots: [], agents: [] },
      { id: "dev-a", label: "Machine A", isSelf: false, online: true, roots: [], agents: [] },
      { id: "dev-b", label: "Machine B", isSelf: false, online: true, roots: [], agents: [] },
    ],
    agents: [],
    loading: false,
    failed: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../hooks/useSlowHint", () => ({ useSlowHint: () => false }));
vi.mock("../hooks/useRoutinePreview", () => ({ useRoutinePreview: () => null }));
vi.mock("../components/chat/CwdPicker", () => ({ default: () => null }));
vi.mock("../components/chat/ModelPicker", () => ({ default: () => null }));
vi.mock("../components/chat/PermissionModePicker", () => ({ default: () => null }));
vi.mock("../components/routine/RoutineScheduleFields", () => ({
  default: () => null,
  defaultNextRunLocal: () => "",
  parseLocalDateTime: () => null,
  toLocalInputValue: () => "",
}));
vi.mock("../components/ui/SheetSelect", () => ({
  default: (props: {
    options: Array<{ id: string; label: string }>;
    onChange: (id: string) => void;
  }) => (
    <div data-testid="machine-picker">
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

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function browserAt(entries: string[], wide: boolean) {
  viewport(wide);
  window.history.replaceState({ idx: 0 }, "", entries[0]);
  entries.slice(1).forEach((url, index) => {
    window.history.pushState({ idx: index + 1 }, "", url);
  });
  return render(
    <BrowserRouter>
      <Routes>
        <Route path="/sessions" element={<div>list page</div>} />
        <Route path="/routines" element={<RoutinesPage />} />
      </Routes>
    </BrowserRouter>,
  );
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState({ idx: 0 }, "", "/");
});

describe("a routine machine switch on real browser history", () => {
  it("replaces the phone's routines entry, so one Back reaches the list", async () => {
    const user = userEvent.setup();
    browserAt(["/sessions", "/routines?device=dev-a"], false);
    await screen.findByText("Machine A routine");
    expect(window.history.state.idx).toBe(1);

    await user.click(screen.getByTestId("machine-option-dev-b"));
    await waitFor(() => expect(window.location.search).toBe("?device=dev-b"));
    expect(await screen.findByText("Machine B routine")).toBeTruthy();

    // [list, routines B] — not [list, routines A, routines B].
    expect(window.history.state.idx).toBe(1);
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
  });

  it("pushes the Mac's machine view, so Back returns to machine A", async () => {
    const user = userEvent.setup();
    browserAt(["/sessions", "/routines?device=dev-a"], true);
    await screen.findByText("Machine A routine");
    expect(window.history.state.idx).toBe(1);

    await user.click(screen.getByTestId("machine-option-dev-b"));
    await waitFor(() => expect(window.location.search).toBe("?device=dev-b"));
    expect(await screen.findByText("Machine B routine")).toBeTruthy();

    expect(window.history.state.idx).toBe(2);
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe("?device=dev-a"));
    expect(await screen.findByText("Machine A routine")).toBeTruthy();
    expect(window.history.state.idx).toBe(1);
  });
});
