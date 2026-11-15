// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BrowserRouter,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEntry, Settings } from "../api/client";
import { setLocale } from "../i18n";
import { isLeaveGuardArmed, resetLeaveGuard } from "../lib/leaveGuard";
import { useAppStore } from "../store/appStore";
import { parseNotificationRoute } from "../lib/notificationRoute";
import SettingsPage from "./SettingsPage";

/**
 * `?tab=` arriving while Settings is already on screen.
 *
 * A notification tap is a router navigation, not a remount: React Router keeps
 * `SettingsPage` mounted when only the query changes, so a tab read once in a
 * state initializer froze the panel the page first opened on. The parser and
 * source-string tests in `settingsTabsWiring.test.ts` cannot see that failure;
 * this file mounts the page and moves the route under it.
 *
 * The URL is the source of the panel in both directions, so a later tap for the
 * tab that is already in the URL is a real move after the reader picked another
 * one by hand — `NotificationTaps` compares the target with the current URL.
 */

const baseSettings = {
  price_table: "{}",
  agent_limits: "{}",
  agent_roles: "[]",
  "agent.default": "",
  limit_policy: "wait",
  "limit_policy.fallback_agents": "[]",
  "provider.active_id": "",
} as unknown as Settings;

const fixtures = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  providers: [] as ProviderEntry[],
}));

vi.mock("../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: [],
    loaded: true,
    error: null,
    pageFull: false,
    loading: false,
  }),
  useTaskResource: () => ({ data: { task: undefined }, loaded: true, error: null }),
  usePendingResources: () => ({
    data: { approvals: [], questions: [] },
    loaded: true,
    error: null,
  }),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    getSettings: vi.fn(async () => fixtures.settings as unknown as Settings),
    updateSettings: vi.fn(async (body: Record<string, string>) => {
      fixtures.settings = { ...fixtures.settings, ...body };
      return fixtures.settings as unknown as Settings;
    }),
    listProviders: vi.fn(async () => ({
      active_id:
        fixtures.providers.find((provider) => provider.active)?.id ??
        String(fixtures.settings["provider.active_id"] ?? ""),
      providers: fixtures.providers,
    })),
    listAgents: vi.fn(async () => []),
    listAgentProviders: vi.fn(async () => []),
    listProviderModels: vi.fn(async () => ({ models: [] })),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    activateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    getRoutingDefaults: vi.fn(async () => ({
      enabled: false,
      default_team: "",
      objective: "balanced",
      max_attempts_per_step: 3,
      terminal_limit_policy: "ask",
      manual_fallback: false,
      quality_floor: "",
      force_phases: [],
    })),
    getRoutingOptions: vi.fn(async () => ({ teams: [] })),
    getRoutingProfiles: vi.fn(async () => ({ profiles: [] })),
    updateRoutingDefaults: vi.fn(),
    updateRoutingProfiles: vi.fn(),
    isAuthenticated: vi.fn(() => true),
    serverVersion: vi.fn().mockResolvedValue({
      desktop_id: "desktop-hub",
      desktop_name: "hub",
    }),
    listMachines: vi.fn(async () => []),
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));

vi.mock("../hooks/useMinWidth", () => ({
  useMinWidth: () => false,
}));

vi.mock("../hooks/useAgentSessionImport", () => ({
  useAgentSessionImport: () => ({
    importing: false,
    importEveryMachine: vi.fn(async () => ({ imported: 0, providers: {} })),
  }),
  importsInFlight: () => false,
}));

vi.mock("../lib/desktop", () => ({
  isKinDesktop: () => false,
}));

vi.mock("../components/terminal/TerminalPanel", () => ({
  default: () => null,
}));

/** The tap: a router navigation to a settings section, page already mounted. */
function NotificationTap({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      tap notification
    </button>
  );
}

/** The URL the console is on, for the "the panel is the URL" assertions. */
function CurrentURL() {
  const location = useLocation();
  return <output data-testid="url">{location.pathname + location.search}</output>;
}

function renderSettings(initialEntry = "/settings", tapTo = "/settings?tab=routing") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      <NotificationTap to={tapTo} />
      <CurrentURL />
    </MemoryRouter>,
  );
}

function panel(id: string): HTMLElement {
  const node = document.getElementById(`settings-panel-${id}`);
  expect(node).toBeTruthy();
  return node as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.settings = { ...baseSettings } as unknown as Record<string, unknown>;
  fixtures.providers = [];
  useAppStore.setState({ reconnectGen: 0 });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("a settings notification tap while the page is mounted", () => {
  it("opens the section the URL names", async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByRole("tablist");
    expect(panel("general").hidden).toBe(false);
    expect(panel("routing").hidden).toBe(true);

    await user.click(screen.getByRole("button", { name: "tap notification" }));

    await waitFor(() => expect(panel("routing").hidden).toBe(false));
    expect(panel("general").hidden).toBe(true);
    expect(screen.getByTestId("url").textContent).toBe("/settings?tab=routing");
  });

  it("keeps an unsaved draft while the panel changes", async () => {
    const user = userEvent.setup();
    renderSettings("/settings?tab=advanced");
    const price = (await screen.findAllByDisplayValue("{}"))[0];
    fireEvent.change(price, { target: { value: '{"mine":true}' } });

    await user.click(screen.getByRole("button", { name: "tap notification" }));

    await waitFor(() => expect(panel("routing").hidden).toBe(false));
    expect(screen.getByDisplayValue('{"mine":true}')).toBeTruthy();
  });

  // The panel and the URL must agree after a hand-picked tab too. Without the
  // rewrite, this page would show Routing while `NotificationTaps` still saw
  // the old URL as "already here" and silently dropped a later tap for it.
  it("puts a hand-picked tab in the URL", async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByRole("tablist");

    await user.click(screen.getByRole("tab", { name: "Routing" }));

    await waitFor(() => expect(panel("routing").hidden).toBe(false));
    expect(screen.getByTestId("url").textContent).toBe("/settings?tab=routing");

    await user.click(screen.getByRole("tab", { name: "General" }));

    await waitFor(() => expect(panel("general").hidden).toBe(false));
    expect(screen.getByTestId("url").textContent).toBe("/settings");
  });

  it("opens General when a notification is canonicalized to /settings without ?tab=", async () => {
    const user = userEvent.setup();
    const target = parseNotificationRoute(
      "https://console.example/settings?tab=general",
      "https://console.example",
    ).path;
    expect(target).toBe("/settings");
    renderSettings("/settings?tab=routing", target);
    await screen.findByRole("tablist");
    expect(panel("routing").hidden).toBe(false);

    await user.click(screen.getByRole("button", { name: "tap notification" }));

    await waitFor(() => expect(panel("general").hidden).toBe(false));
    expect(panel("routing").hidden).toBe(true);
    expect(screen.getByTestId("url").textContent).toBe("/settings");
  });

  // The area table accepts `/settings?tab=operations`, but its panel arrives
  // with N4. General alone would read as "the link was wrong"; the notice names
  // where Agent operations lives now and gives the reader the way there.
  it("explains an operations tab and links to Agents until N4 hosts the panel", async () => {
    renderSettings("/settings?tab=operations");
    await screen.findByRole("tablist");

    expect(panel("general").hidden).toBe(false);
    expect(screen.getByText(/Agent operations now live in the Agents page/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Agents" }).getAttribute("href")).toBe(
      "/agents",
    );
    expect(screen.getByTestId("url").textContent).toBe("/settings?tab=operations");
  });
});

describe("dirty settings tab changes and system Back", () => {
  afterEach(() => {
    resetLeaveGuard();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("reaches /sessions after one approved Back following dirty tab switches", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState(null, "", "/sessions");
    window.history.pushState(null, "", "/settings?tab=advanced");
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/sessions" element={<div data-testid="sessions">sessions</div>} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
        <CurrentURL />
      </BrowserRouter>,
    );
    const price = (await screen.findAllByDisplayValue("{}"))[0];
    fireEvent.change(price, { target: { value: '{"mine":true}' } });
    // The guard arms on a deferred reconcile. Clicking a tab before that would
    // rewrite the entry the sentinel is meant to protect, so the test would
    // pass without ever exercising the guard.
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));

    await user.click(screen.getByRole("tab", { name: "General" }));
    await waitFor(() => expect(screen.getByTestId("url").textContent).toBe("/settings"));
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));

    await user.click(screen.getByRole("tab", { name: "Routing" }));
    await waitFor(() =>
      expect(screen.getByTestId("url").textContent).toBe("/settings?tab=routing"),
    );
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId("sessions")).toBeTruthy());
    expect(screen.getByTestId("url").textContent).toBe("/sessions");
    // Both dirty switches re-armed instead of leaving an entry each, so the
    // one Back that leaves Settings asks exactly once on the way out.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });
});
