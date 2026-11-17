// @vitest-environment jsdom
// KIN-SETTINGS-001 — 改默认设置（J6）：本套件持有目录里「现在生效的值」的验收行。
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  getSettings,
  listProviders,
  type ProviderEntry,
  type Settings,
} from "../api/client";
import { setLocale, t } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { useAppStore } from "../store/appStore";
import SettingsPage from "./SettingsPage";

/**
 * The settings directory names what is in effect: the theme, the active
 * provider and the rate-limit policy sit beside their section's name on both
 * surfaces (the Mac tab strip and the phone's directory card).
 *
 * Only values the page already holds are shown. A value that has not loaded
 * yet keeps the section's description instead — never "None", never a guess —
 * and a failed reload keeps the values already on screen.
 */

const baseSettings = {
  price_table: "{}",
  agent_limits: "{}",
  agent_roles: "[]",
  "agent.default": "",
  limit_policy: "ask",
  "limit_policy.fallback_agents": "[]",
  "provider.active_id": "prov-1",
} as unknown as Settings;

const anthropic: ProviderEntry = {
  id: "prov-1",
  name: "Anthropic",
  kind: "openai",
  base_url: "https://api.example.com/v1",
  model: "example-model",
  active: true,
};

const fixtures = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  providers: [] as ProviderEntry[],
}));

vi.mock("../lib/theme", () => ({
  getThemeMode: () => "dark",
  setThemeMode: vi.fn(),
  applyTheme: vi.fn(),
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
    listAgentManagement: vi.fn(async () => []),
    getUsageSummary: vi.fn(async () => []),
    getUsageLimits: vi.fn(async () => []),
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

/** The Mac tab whose section this is; its name stays just the section. */
function macTab(id: string): HTMLElement {
  return screen.getByRole("tab", { name: t(`settings.tabs.${id}`) });
}

/** The phone directory's row for a section, found inside the "More settings" card. */
function phoneRow(id: string): HTMLElement {
  const card = screen.getByText(t("settings.moreSections")).nextElementSibling as HTMLElement;
  expect(card).toBeTruthy();
  const row = within(card)
    .getByText(t(`settings.tabs.${id}`))
    .closest("button");
  expect(row).toBeTruthy();
  return row as HTMLElement;
}

/** The value is a second line inside the tab and a trailing slot in the row. */
function expectValue(surface: HTMLElement, value: string) {
  expect(within(surface).getByText(value)).toBeTruthy();
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
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
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

describe("what the settings directory says is in effect", () => {
  it("names the theme, the active provider and the rate-limit policy in the directory", async () => {
    fixtures.providers = [anthropic];
    pageOnly();

    await screen.findByRole("tab", { name: "General" });
    await waitFor(() => expectValue(macTab("providers"), "Anthropic"));

    // The Mac tab strip: a muted second line under the section's name.
    expectValue(macTab("general"), "Dark");
    expectValue(macTab("routing"), "Ask");

    // The phone directory: the same three values in the row's trailing slot,
    // with each section's description still underneath its name.
    expectValue(phoneRow("providers"), "Anthropic");
    expectValue(phoneRow("routing"), "Ask");
    expect(phoneRow("providers").textContent).toContain(t("settings.tabs.providersDesc"));

    // Sections with no derivable value keep their description and show no
    // invented one.
    for (const id of ["agents", "operations", "advanced"]) {
      expect(macTab(id).textContent).toBe(t(`settings.tabs.${id}`));
      expect(phoneRow(id).textContent).toBe(
        `${t(`settings.tabs.${id}`)}${t(`settings.tabs.${id}Desc`)}`,
      );
    }
  });

  it("shows no provider value before the provider list loads", async () => {
    // An empty registry is not "None": the section keeps its description until
    // there is a real provider name to name.
    fixtures.providers = [];
    pageOnly();

    await screen.findByRole("tab", { name: "General" });
    await waitFor(() => expect(vi.mocked(listProviders)).toHaveBeenCalled());

    expect(macTab("providers").textContent).toBe(t("settings.tabs.providers"));
    expect(phoneRow("providers").textContent).toBe(
      `${t("settings.tabs.providers")}${t("settings.tabs.providersDesc")}`,
    );
  });

  it("keeps the last loaded values when a reconnect reload fails", async () => {
    fixtures.providers = [anthropic];
    pageOnly();

    await screen.findByRole("tab", { name: "General" });
    await waitFor(() => expectValue(macTab("providers"), "Anthropic"));

    vi.mocked(getSettings).mockRejectedValueOnce(new ApiError(500, "socket closed"));
    act(() => useAppStore.setState({ reconnectGen: 1 }));

    await waitFor(() => expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(2));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Disconnected — showing the last values");

    // A summary never fills a failure and never blanks an answer the page
    // already has: these are the values from before the link dropped.
    expectValue(macTab("general"), "Dark");
    expectValue(macTab("providers"), "Anthropic");
    expectValue(macTab("routing"), "Ask");
  });
});
