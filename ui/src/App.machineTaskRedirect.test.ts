// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import App from "./App";
import { useAppStore } from "./store/appStore";

/**
 * KIN-CONTRACT-001 exit row `/machines/:device/tasks/:id` → `/tasks/:id?device=`.
 *
 * One task detail page covers local and remote runs, and the device is the
 * query parameter that says where the run lives. The old path survives only as
 * a redirect, so a bookmark, a banner or an old phone notification still lands;
 * it must replace, not push, or Back would return to a URL that immediately
 * leaves again.
 *
 * The host is a location probe: this suite asks where the router landed, not
 * what the page drew (that is `TaskSessionHost.remote.dom.test.tsx`).
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

// The one surface under test is the route the App registers for a task; the
// keep-alive host is that route's body, so it reports the location it reached.
vi.mock("./pages/TaskSessionHost", () => ({
  default: function HostProbe() {
    const location = useLocation();
    const navigate = useNavigate();
    return createElement(
      "div",
      null,
      createElement(
        "span",
        { "data-testid": "here" },
        location.pathname + location.search,
      ),
      createElement(
        "button",
        { type: "button", onClick: () => navigate(-1) },
        "back",
      ),
    );
  },
}));

// The page Back lands on is a marker: this suite asserts the history entry,
// not what the Routines page draws.
vi.mock("./pages/RoutinesPage", () => ({
  default: () => createElement("div", null, "routines page"),
}));

function renderAt(entries: string[]) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: entries, initialIndex: entries.length - 1 },
      createElement(App),
    ),
  );
}

beforeEach(() => {
  useAppStore.setState({ auth: { status: "ok" } });
});

describe("the retired machine task URL", () => {
  it("redirects to the task detail with the device preserved", async () => {
    renderAt(["/machines/dev-a/tasks/run-1"]);
    expect((await screen.findByTestId("here")).textContent).toBe(
      "/tasks/run-1?device=dev-a",
    );
  });

  it("keeps the query string", async () => {
    // `?focus=` is how a notification names the approval it wants revealed;
    // the redirect must not drop it on the way to the task detail.
    renderAt(["/machines/dev-a/tasks/run-1?focus=appr-1&keep=1"]);
    expect((await screen.findByTestId("here")).textContent).toBe(
      "/tasks/run-1?device=dev-a&focus=appr-1&keep=1",
    );
  });

  it("replaces rather than pushes", async () => {
    renderAt(["/routines", "/machines/dev-a/tasks/run-1"]);
    expect((await screen.findByTestId("here")).textContent).toBe(
      "/tasks/run-1?device=dev-a",
    );
    // One Back reaches the page the reader came from, not the URL that just
    // redirected them. A push would land on `/machines/...` and bounce again.
    fireEvent.click(screen.getByText("back"));
    expect(screen.getByTestId("here").textContent).toBe("/routines");
  });
});
