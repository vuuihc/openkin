// @vitest-environment jsdom
// KIN-SETTINGS-001 — 改默认设置（J6）：本套件持有运维入口与被动视图不预读的验收行。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUsageLimits,
  getUsageSummary,
  listAgentManagement,
  type ProviderEntry,
  type Settings,
} from "../api/client";
import AppShell from "../components/layout/AppShell";
import { setLocale } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { useAppStore } from "../store/appStore";
import SettingsPage from "./SettingsPage";

/**
 * N4: Operations is a settings tab that *hosts* the agent console.
 *
 * Two things this file exists to hold, which no component test can see:
 * opening Settings must not start the agent console's reads (AGENTS.md: a
 * passive view may not call third-party APIs implicitly), and the hosted page
 * may not bring a second `h1` onto the screen.
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
      active_id: String(fixtures.settings["provider.active_id"] ?? ""),
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
    // The reads the hosted agent console performs on mount. Mocked explicitly
    // so "not called" cannot pass because the function was missing.
    listAgentManagement: vi.fn(async () => []),
    getUsageSummary: vi.fn(async () => []),
    getUsageLimits: vi.fn(async () => []),
    smokeAgents: vi.fn(async () => []),
    importAgentSessions: vi.fn(async () => ({})),
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

function viewport() {
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
}

function shell(settingsURL = "/settings") {
  window.history.replaceState({}, "", settingsURL);
  return render(
    <MemoryRouter initialEntries={["/sessions", settingsURL]}>
      <AppShell pendingApprovals={[]}>
        <Routes>
          <Route path="/sessions" element={<div>chats page</div>} />
          <Route path="/agents" element={<div>agents page</div>} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </AppShell>
    </MemoryRouter>,
  );
}

/**
 * SettingsPage without the shell.
 *
 * `AppShell` reads the usage summary for its own week-cost chip, so a test
 * that attributes usage reads to this page cannot wrap it in the shell.
 */
function pageOnly(settingsURL = "/settings") {
  window.history.replaceState({}, "", settingsURL);
  return render(
    <MemoryRouter initialEntries={[settingsURL]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function operationsTab(): HTMLElement {
  return screen.getByRole("tab", { name: "Operations" });
}

function panel(id: string): HTMLElement {
  return document.getElementById(`settings-panel-${id}`) as HTMLElement;
}

beforeEach(() => {
  resetLeaveGuard();
  cleanup();
  vi.clearAllMocks();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  fixtures.settings = { ...baseSettings } as unknown as Record<string, unknown>;
  fixtures.providers = [];
  useAppStore.setState({ reconnectGen: 0 });
  viewport();
  vi.spyOn(window, "confirm").mockReturnValue(false);
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the Operations settings tab", () => {
  it("opens the operations tab from a ?tab=operations deep link", async () => {
    shell("/settings?tab=operations");

    const tab = await screen.findByRole("tab", { name: "Operations" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(panel("operations").hasAttribute("hidden")).toBe(false);
  });

  it("reads nothing from the agent operations page until its tab is opened", async () => {
    const user = userEvent.setup();
    pageOnly("/settings?tab=general");

    await screen.findByRole("tab", { name: "General" });
    // Opening Settings is a passive view: the agent console's reads have not
    // started even though its panel will host them.
    expect(listAgentManagement).not.toHaveBeenCalled();
    expect(getUsageSummary).not.toHaveBeenCalled();
    expect(getUsageLimits).not.toHaveBeenCalled();

    await user.click(operationsTab());

    await waitFor(() => expect(listAgentManagement).toHaveBeenCalled());
    expect(getUsageSummary).toHaveBeenCalled();
    expect(getUsageLimits).toHaveBeenCalled();
  });

  it("keeps an unsaved general draft while the operations tab is opened and back", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    shell("/settings?tab=general");

    // General's own visible state today is the appearance choice, and the
    // price table is the page's canonical unsaved text — both must survive a
    // trip through another tab because the panels stay mounted.
    await screen.findByRole("tab", { name: "General" });
    await user.click(within(panel("general")).getByRole("button", { name: "Dark" }));
    const price = (await screen.findAllByDisplayValue("{}"))[0];
    fireEvent.change(price, { target: { value: '{"mine":true}' } });

    await user.click(operationsTab());
    expect(panel("general").hasAttribute("hidden")).toBe(true);
    expect(panel("operations").hasAttribute("hidden")).toBe(false);

    await user.click(screen.getByRole("tab", { name: "General" }));
    expect(panel("general").hasAttribute("hidden")).toBe(false);

    expect((screen.getAllByDisplayValue('{"mine":true}')[0] as HTMLTextAreaElement).value).toBe(
      '{"mine":true}',
    );
    // An in-page tab change is not leaving Settings, so it never asks.
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows exactly one h1 while the operations tab is open", async () => {
    shell("/settings?tab=operations");

    await screen.findByRole("tab", { name: "Operations" });
    await act(async () => {
      await Promise.resolve();
    });
    // Two page-level `h1`s exist by design and jsdom cannot see their CSS:
    // `MobileHeader`'s title (`md:hidden`) and Settings' own (`hidden md:block`),
    // so exactly one is visible at any width. What this test holds is that the
    // hosted console adds no third: `AgentsPage` drops its heading when
    // `embedded`.
    expect(within(panel("operations")).queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });

  it("widens the settings layout for operations, drops nested padding, and adds a phone section heading", async () => {
    shell("/settings?tab=operations");

    await screen.findByRole("tab", { name: "Operations" });
    await act(async () => {
      await Promise.resolve();
    });

    const opPanel = panel("operations");
    expect(opPanel.closest(".max-w-page-wide")).not.toBeNull();
    expect(opPanel.querySelector(".py-6")).toBeNull();
    expect(within(opPanel).getByRole("heading", { level: 2, name: "Operations" })).toBeTruthy();
    expect(within(opPanel).queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });

  it("lets the operations panel own the heading and keeps the settings header in place", async () => {
    shell("/settings?tab=operations");

    await screen.findByRole("tab", { name: "Operations" });
    await act(async () => {
      await Promise.resolve();
    });

    const opPanel = panel("operations");
    const heading = within(opPanel).getByRole("heading", { level: 2, name: "Operations" });
    // The panel names itself at every width. Only the tab strip is
    // width-dependent, and a selected tab says which tab is open, not what the
    // page below it is.
    expect(heading.className).not.toContain("md:hidden");
    expect(
      within(opPanel).getByText("What this machine has, whether it works, and what it cost"),
    ).toBeTruthy();
    // The header block is the same on every tab — dropping the tagline for one
    // tab changed its height and moved the section list — and Operations hides
    // that whole column for its wide table, so the tagline is never a second
    // description on screen.
    const sectionColumn = screen.getByRole("tablist", { name: "Settings" })
      .parentElement as HTMLElement;
    expect(sectionColumn.className).toContain("hidden");
    expect(sectionColumn.querySelector("p")?.textContent).toBe(
      "Cognition provider (Kin agent), agents, routing, and pricing.",
    );
  });

  it("shows an empty state instead of dash tiles when this machine has no usage", async () => {
    shell("/settings?tab=operations");

    await screen.findByRole("tab", { name: "Operations" });
    const opPanel = panel("operations");
    await waitFor(() => expect(within(opPanel).getByText("No usage in this range")).toBeTruthy());
    // An empty range is a state, not four em-dash metric tiles.
    expect(within(opPanel).queryByText("Cache hit rate")).toBeNull();
    expect(within(opPanel).queryByText("—")).toBeNull();
  });

  it("does not render usage tiles until the agent list has arrived", async () => {
    // The two reads race: usage can land first. Rendering its tiles while the
    // agent list is still loading put live cards below the loading skeleton.
    vi.mocked(listAgentManagement).mockImplementationOnce(() => new Promise(() => {}));
    shell("/settings?tab=operations");

    await screen.findByRole("tab", { name: "Operations" });
    await waitFor(() => expect(getUsageSummary).toHaveBeenCalled());
    const opPanel = panel("operations");
    expect(within(opPanel).getByText("Reading this machine's agents and usage…")).toBeTruthy();
    expect(within(opPanel).queryByText("Cache hit rate")).toBeNull();
    expect(within(opPanel).queryByText("No usage in this range")).toBeNull();
  });
});
