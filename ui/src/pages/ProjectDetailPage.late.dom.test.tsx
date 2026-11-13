// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import ProjectDetailPage from "./ProjectDetailPage";
import { setLocale } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { useLeaveGuard } from "../hooks/useLeaveGuard";
import { notePhoneLocation, resetPhoneNavigation } from "../lib/phoneNavigation";

/**
 * A recipe is launched after an explicit approval on the project cover. If its
 * answer arrives after the reader has moved on — notably to a dirty Settings —
 * that approval belongs to the cover, not to wherever they are now. The answer
 * must stay put rather than navigate the current screen away.
 */

const launch = vi.hoisted(() => ({
  launchRecipe: vi.fn(),
}));

vi.mock("../recipes/launch", () => ({ launchRecipe: launch.launchRecipe }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    isAuthenticated: vi.fn(() => true),
    getProject: vi.fn(async (id: string) => ({
      id,
      name: "alpha",
      mode: "ship",
      status: "active",
      roots: ["/work/alpha"],
      created_at: 1,
      updated_at: 2,
      last_active_at: 3,
    })),
    getOnePager: vi.fn(async () => ({
      project_id: "p1",
      markdown: "Original summary",
      updated_at: 1,
    })),
    listProjectArtifacts: vi.fn(async () => []),
    getProjectPulse: vi.fn(async () => null),
    listProjectTasks: vi.fn(async () => []),
    listAgentSessions: vi.fn(async () => []),
    listRoutines: vi.fn(async () => ({ routines: [], has_more: false })),
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
}));

vi.mock("../lib/desktop", () => ({ isKinDesktop: () => false }));

vi.mock("../components/terminal/TerminalPanel", () => ({ default: () => null }));

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

let jump: ((to: string) => void) | null = null;

function Jump() {
  const navigate = useNavigate();
  jump = (to: string) => navigate(to);
  return null;
}

function RouteProbe() {
  const location = useLocation();
  useEffect(() => {
    notePhoneLocation(location);
  }, [location]);
  return null;
}

function DirtySettings() {
  const [text, setText] = useState("");
  useLeaveGuard(
    () => (typeof window.confirm === "function" ? window.confirm("Discard settings draft?") : true),
    text.trim() !== "",
  );
  return (
    <input
      aria-label="settings draft"
      value={text}
      onChange={(event) => setText(event.target.value)}
    />
  );
}

function app() {
  return (
    <BrowserRouter>
      <Jump />
      <RouteProbe />
      <Routes>
        <Route path="/sessions" element={<div>list page</div>} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/settings" element={<DirtySettings />} />
        <Route path="/tasks/:id" element={<div>conversation page</div>} />
      </Routes>
    </BrowserRouter>
  );
}

function browserAt(entries: string[]) {
  window.history.replaceState({ idx: 0 }, "", entries[0]);
  entries.slice(1).forEach((url, index) => {
    window.history.pushState({ idx: index + 1 }, "", url);
  });
  return render(app());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetLeaveGuard();
  resetPhoneNavigation();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  jump = null;
  viewport();
  launch.launchRecipe.mockReset();
});

describe("a recipe answer after the cover was left", () => {
  it("does not navigate over a dirty Settings opened while it runs", async () => {
    const user = userEvent.setup();
    const recipe = deferred<{ id: string }>();
    launch.launchRecipe.mockImplementationOnce(() => recipe.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    const view = browserAt(["/sessions", "/projects/p1"]);
    await screen.findByRole("heading", { name: "alpha" });
    await user.click(screen.getByRole("button", { name: "Continue focus" }));
    expect(launch.launchRecipe).toHaveBeenCalledTimes(1);

    act(() => jump!("/settings"));
    const draft = await screen.findByLabelText("settings draft");
    fireEvent.change(draft, { target: { value: "settings words" } });

    await act(async () => {
      recipe.resolve({ id: "task-99" });
      await recipe.promise;
    });

    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
    expect((screen.getByLabelText("settings draft") as HTMLInputElement).value).toBe(
      "settings words",
    );
    expect(confirm).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("the cover's own Open cover link", () => {
  it("asks a dirty cover first and does not stack a second project entry", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const view = browserAt(["/sessions", "/projects/p1"]);
      await screen.findByRole("heading", { name: "alpha" });
      await user.click(screen.getByRole("button", { name: "Edit One-Pager" }));
      const editor = screen.getByRole("textbox");
      await user.clear(editor);
      await user.type(editor, "unsaved words");
      await waitFor(() =>
        expect(
          (window.history.state as { kinLeaveGuard?: string } | null)?.kinLeaveGuard,
        ).toBeTruthy(),
      );
      const baseLength = window.history.length - 1;
      expect(window.history.length).toBe(baseLength + 1);

      // A self-link must take the same guarded departure as Back. Refusing
      // keeps the page, the draft and exactly one armed sentinel in place.
      await user.click(screen.getByRole("link", { name: "Open cover" }));
      expect(confirm).toHaveBeenCalledWith("Discard unsaved One-Pager changes?");
      expect(window.location.pathname).toBe("/projects/p1");
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("unsaved words");
      expect(window.history.length).toBe(baseLength + 1);
      expect(
        (window.history.state as { kinLeaveGuard?: string } | null)?.kinLeaveGuard,
      ).toBeTruthy();

      // Agreeing replaces this project entry in place (no second copy), then
      // re-arms the still-dirty page. One Back after that reaches the list.
      confirm.mockReturnValue(true);
      await user.click(screen.getByRole("link", { name: "Open cover" }));
      await waitFor(() =>
        expect(
          (window.history.state as { kinLeaveGuard?: string } | null)?.kinLeaveGuard,
        ).toBeTruthy(),
      );
      expect(window.location.pathname).toBe("/projects/p1");
      expect(window.history.length).toBe(baseLength + 1);

      act(() => window.history.back());
      await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
      view.unmount();
    } finally {
      confirm.mockRestore();
    }
  });
});
