// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import { setLocale } from "./i18n";
import { useAppStore } from "./store/appStore";

/**
 * N2 / KIN-CONTRACT-001: the three areas own the console's URLs.
 *
 * The route table is the thing under test, so the pages are markers and the
 * shell is a passthrough — a test that mounts the real sidebar would be asking
 * whether the sidebar works, and would fail for reasons this slice did not
 * change. `/projects` is the exception: its acceptance is that a bookmark
 * lands on the real conversation list, so that redirect renders the real
 * `SessionsRoute`.
 */

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return {
    ...actual,
    getToken: vi.fn(() => "test-token"),
    hasStoredToken: vi.fn(() => true),
    getRoutineUnreadCount: vi.fn(async () => ({ count: 0 })),
  };
});

vi.mock("./api/useLiveResources", () => ({
  usePendingResources: () => ({
    data: { approvals: [], questions: [] },
    loaded: true,
    error: null,
  }),
  useTaskList: () => ({
    data: [],
    loaded: true,
    error: null,
    pageFull: false,
    loading: false,
  }),
}));

vi.mock("./api/sessionSync", () => ({
  SessionSync: class {
    start() {}
    stop() {}
  },
}));

vi.mock("./hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));

vi.mock("./components/layout/AppShell", () => ({
  default: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("./components/NotificationTaps", () => ({ default: () => null }));
vi.mock("./components/ToastHost", () => ({ default: () => null }));
vi.mock("./pages/TaskSessionHost", () => ({ default: () => null }));

vi.mock("./pages/ProjectDetailPage", () => ({
  default: () => createElement("div", null, "project detail page"),
}));
// The settings host reads its location so the redirect's target is asserted
// rather than assumed: landing on `/settings` without `?tab=operations` would
// still render this marker.
vi.mock("./pages/SettingsPage", async () => {
  const { useLocation } = await import("react-router-dom");
  return {
    default: function SettingsPageMock() {
      const location = useLocation();
      return createElement("div", null, `settings page ${location.pathname}${location.search}`);
    },
  };
});
vi.mock("./pages/RoutinesPage", () => ({
  default: () => createElement("div", null, "routines page"),
}));

function renderAt(path: string) {
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)));
}

beforeEach(() => {
  // The product's default locale is zh; these assertions read the English
  // catalogue, so the test says which one it is reading.
  setLocale("en");
  useAppStore.setState({ auth: { status: "ok" } });
  // The phone shape: `SessionsRoute` is the list where there is no sidebar, so
  // the redirect test reads the list the reader actually lands on.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

describe("area routes", () => {
  it("sends /projects to the sessions list in place of the retired collection", async () => {
    renderAt("/projects");
    // The real list, empty, says so; the retired collection's heading is gone.
    expect(await screen.findByText("No chats yet")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
  });

  // The collection route must not swallow the detail route: `/projects/:id`
  // is still the project cover.
  it("keeps /projects/:id on the project detail page", () => {
    renderAt("/projects/p1");
    expect(screen.getByText("project detail page")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
  });

  // E4a: the operations tab now hosts the agent console, so the old
  // full-page destinations land on the panel instead of a second copy.
  it("sends /agents to the operations tab now that the panel has content", async () => {
    renderAt("/agents");
    expect(await screen.findByText("settings page /settings?tab=operations")).toBeTruthy();
    expect(screen.queryByText("agents page")).toBeNull();
  });

  it("sends /usage to the operations tab too", async () => {
    renderAt("/usage");
    expect(await screen.findByText("settings page /settings?tab=operations")).toBeTruthy();
  });
});
