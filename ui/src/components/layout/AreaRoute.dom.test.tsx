// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import AreaRoute from "./AreaRoute";

/**
 * S3: only the content region moves.
 *
 * These render the real wrapper with a real router: the URL is the only input,
 * and the question is what the shell has on screen in the *same commit* as the
 * new page. A `useEffect` that latched the motion would pass a "what does the
 * DOM say after the click" assertion but animate one frame late — or not at
 * all — so the probe below reads the wrapper from a layout effect, the first
 * moment the committed DOM exists and before the browser paints.
 */

type Commit = { page: string; motion: string | null };
let commits: Commit[] = [];

function Page({ name }: { name: string }) {
  useLayoutEffect(() => {
    const wrapper = document.querySelector(".kin-route");
    commits.push({ page: name, motion: wrapper?.getAttribute("data-motion") ?? null });
  }, [name]);
  return <div data-testid={`page-${name}`}>{name}</div>;
}

function Nav() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/tasks/t1")}>open-task-1</button>
      <button onClick={() => navigate("/tasks/t2")}>open-task-2</button>
      <button onClick={() => navigate("/projects")}>open-projects</button>
      <button onClick={() => navigate("/settings?tab=agents")}>open-agents-tab</button>
      <button onClick={() => navigate(-1)}>go-back</button>
    </>
  );
}

/**
 * The shape `App` renders: a shell that consumes the location (so a navigation
 * re-renders it), the keep-alive host's stand-in as a sibling before the
 * wrapper, then the wrapper around the routes.
 */
function Shell() {
  const location = useLocation();
  return (
    <div data-pathname={location.pathname}>
      <div data-testid="sentinel" />
      <Nav />
      <AreaRoute>
        <Routes>
          <Route path="/sessions" element={<Page name="sessions" />} />
          <Route path="/tasks/:id" element={<Page name="task" />} />
          <Route path="/projects" element={<Page name="projects" />} />
          <Route path="/settings" element={<Page name="settings" />} />
        </Routes>
      </AreaRoute>
    </div>
  );
}

function renderShell(initialEntry = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Shell />
    </MemoryRouter>,
  );
}

function wrapper(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".kin-route");
  if (!element) throw new Error("no .kin-route wrapper");
  return element;
}

/** `matches` is true only for the reduced-motion query the component asks. */
function stubMotionPreference(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  commits = [];
  stubMotionPreference(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AreaRoute", () => {
  it("puts the motion kind on the content region before the first commit", () => {
    renderShell();
    // Cold start: there is no direction to animate from.
    expect(wrapper().getAttribute("data-motion")).toBe("none");
    commits = [];

    fireEvent.click(screen.getByRole("button", { name: "open-task-1" }));
    expect(wrapper().getAttribute("data-motion")).toBe("push");
    // The new page saw the kind in the commit that mounted it, not a frame later.
    expect(commits).toEqual([{ page: "task", motion: "push" }]);

    fireEvent.click(screen.getByRole("button", { name: "go-back" }));
    expect(wrapper().getAttribute("data-motion")).toBe("pop");
    expect(commits.at(-1)).toEqual({ page: "sessions", motion: "pop" });

    fireEvent.click(screen.getByRole("button", { name: "open-projects" }));
    expect(wrapper().getAttribute("data-motion")).toBe("area");
    expect(commits.at(-1)).toEqual({ page: "projects", motion: "area" });
  });

  it("keeps a sibling outside the wrapper mounted across a navigation", () => {
    renderShell();
    const sentinel = screen.getByTestId("sentinel");

    fireEvent.click(screen.getByRole("button", { name: "open-projects" }));

    // Same node object, not merely an equal one: nothing keyed by the location
    // remounted the shell beside the route.
    expect(screen.getByTestId("sentinel")).toBe(sentinel);
  });

  it("renders exactly one route subtree after navigating", () => {
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: "open-task-1" }));
    expect(screen.queryByTestId("page-sessions")).toBeNull();
    expect(document.querySelectorAll(".kin-route > *")).toHaveLength(1);
    expect(document.querySelectorAll("[data-testid^='page-']")).toHaveLength(1);

    // A detail-to-detail move is a content swap inside the same subtree.
    fireEvent.click(screen.getByRole("button", { name: "open-task-2" }));
    expect(wrapper().getAttribute("data-motion")).toBe("none");
    expect(document.querySelectorAll(".kin-route > *")).toHaveLength(1);
    expect(document.querySelectorAll("[data-testid^='page-']")).toHaveLength(1);
  });

  it("falls back to a fade when the reader asks for reduced motion", () => {
    stubMotionPreference(true);
    renderShell();
    expect(wrapper().getAttribute("data-motion")).toBe("none");
    commits = [];

    fireEvent.click(screen.getByRole("button", { name: "open-task-1" }));
    expect(wrapper().getAttribute("data-motion")).toBe("fade");
    expect(commits).toEqual([{ page: "task", motion: "fade" }]);

    fireEvent.click(screen.getByRole("button", { name: "go-back" }));
    expect(wrapper().getAttribute("data-motion")).toBe("fade");

    fireEvent.click(screen.getByRole("button", { name: "open-projects" }));
    expect(wrapper().getAttribute("data-motion")).toBe("fade");
  });

  it("does not animate when only the query changes", () => {
    renderShell("/settings");
    commits = [];

    fireEvent.click(screen.getByRole("button", { name: "open-agents-tab" }));

    expect(screen.getByTestId("page-settings")).toBeTruthy();
    expect(wrapper().getAttribute("data-motion")).toBe("none");
    // The page did not remount, so there is no arrival to animate at all.
    expect(commits).toEqual([]);
  });
});
