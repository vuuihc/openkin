// @vitest-environment jsdom
import { StrictMode, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import { beginUnansweredAccountProbe, endUnansweredAccountProbe } from "./api/account";
import { NO_ACCOUNT, useAppStore } from "./store/appStore";

/**
 * `<StrictMode>` runs App's mount effect twice in development builds. The first
 * pass retires the pre-render account-probe placeholder (see `applyVisitGate`);
 * the second pass then sees `account.enabled === false`. That is a retired
 * placeholder, not a verdict about the daemon, and reading it as "no accounts"
 * closes the gate on the token screen the deadline path deliberately avoided.
 *
 * The routes are markers: this test is about the mount effect, not the pages.
 */

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return {
    ...actual,
    getToken: vi.fn(() => null),
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
vi.mock("./pages/TaskSessionHost", () => ({ default: () => null }));
vi.mock("./pages/NewChatPage", () => ({ default: () => null }));

function renderApp() {
  return render(
    createElement(
      StrictMode,
      null,
      createElement(MemoryRouter, { initialEntries: ["/new"] }, createElement(App)),
    ),
  );
}

beforeEach(() => {
  endUnansweredAccountProbe();
  useAppStore.setState({ auth: { status: "ok" }, account: NO_ACCOUNT });
});

afterEach(() => {
  endUnansweredAccountProbe();
});

describe("App's mount gate under StrictMode", () => {
  it("keeps the gate open when the first pass retired the unanswered placeholder", () => {
    // The deadline path: the console opens before /api/auth/status answers.
    beginUnansweredAccountProbe();
    useAppStore.getState().setAuthOk();

    renderApp();

    // Pass one decided the visit from the placeholder and retired it, so a
    // later API 401 reads as "no accounts" (the token screen).
    expect(useAppStore.getState().account.enabled).toBe(false);
    // Pass two ran after that retirement. It must not call requireToken: the
    // probe is still unanswered, and the deadline did not ask for that screen.
    expect(useAppStore.getState().auth).toEqual({ status: "ok" });
  });

  it("still closes on the token screen once the probe answered that there are no accounts", () => {
    // The same effect with an answer in hand: a daemon without accounts still
    // gets the token screen, so the guard above cannot mask the real gate.
    beginUnansweredAccountProbe();
    endUnansweredAccountProbe();
    useAppStore.getState().setAccount(NO_ACCOUNT);
    useAppStore.getState().setAuthOk();

    renderApp();

    expect(useAppStore.getState().auth).toEqual({ status: "need_token", reason: "missing" });
  });
});
