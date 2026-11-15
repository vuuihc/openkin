// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { listProjects, type Project } from "./api/client";
import App from "./App";
import { setLocale } from "./i18n";
import { useAppStore } from "./store/appStore";

/**
 * N2: the four areas own the console's URLs.
 *
 * The route table is the thing under test, so the pages are markers and the
 * shell is a passthrough — a test that mounts the real sidebar would be asking
 * whether the sidebar works, and would fail for reasons this slice did not
 * change. The one real page is the new `/projects` host, because "not blank"
 * is its acceptance.
 */

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return {
    ...actual,
    getToken: vi.fn(() => "test-token"),
    hasStoredToken: vi.fn(() => true),
    getRoutineUnreadCount: vi.fn(async () => ({ count: 0 })),
    listProjects: vi.fn(async () => [] as Project[]),
  };
});

vi.mock("./api/useLiveResources", () => ({
  usePendingResources: () => ({
    data: { approvals: [], questions: [] },
    loaded: true,
    error: null,
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
vi.mock("./pages/AgentsPage", () => ({
  default: () => createElement("div", null, "agents page"),
}));
vi.mock("./pages/SettingsPage", () => ({
  default: () => createElement("div", null, "settings page"),
}));
vi.mock("./pages/RoutinesPage", () => ({
  default: () => createElement("div", null, "routines page"),
}));

const PROJECT: Project = {
  id: "p1",
  name: "alpha",
  mode: "ship",
  status: "active",
  created_at: 1,
  updated_at: 2,
  last_active_at: 3,
  roots: ["/work/alpha"],
};

function renderAt(path: string) {
  return render(
    createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)),
  );
}

beforeEach(() => {
  // The product's default locale is zh; these assertions read the English
  // catalogue, so the test says which one it is reading.
  setLocale("en");
  useAppStore.setState({ auth: { status: "ok" } });
  vi.mocked(listProjects).mockResolvedValue([]);
});

describe("area routes", () => {
  it("serves the projects collection at /projects", async () => {
    renderAt("/projects");
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
    // Not blank: an empty collection says so rather than rendering nothing.
    expect(await screen.findByText(/No covers yet/)).toBeTruthy();
  });

  it("lists a loaded project at its detail URL", async () => {
    vi.mocked(listProjects).mockResolvedValue([PROJECT]);
    renderAt("/projects");
    const link = await screen.findByRole("link", { name: "alpha" });
    expect(link.getAttribute("href")).toBe("/projects/p1");
  });

  // The collection route must not swallow the detail route: `/projects/:id`
  // is still the project cover.
  it("keeps /projects/:id on the project detail page", () => {
    renderAt("/projects/p1");
    expect(screen.getByText("project detail page")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
  });

  // CEO call for N2: `settings?tab=operations` has no panel body until N4 hosts
  // it and E4a moves the Agent-operations content in. Redirecting now would turn
  // `/agents` into a blank tab, so the redirect moves to N4 with the host. This
  // test makes the deferral deliberate rather than forgotten.
  it("keeps /agents on the agents page until the operations tab has content", () => {
    renderAt("/agents");
    expect(screen.getByText("agents page")).toBeTruthy();
    expect(screen.queryByText("settings page")).toBeNull();
  });
});
