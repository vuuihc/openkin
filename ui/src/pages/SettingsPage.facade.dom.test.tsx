// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings, type ProviderEntry, type Settings } from "../api/client";
import { setLocale } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { applyTheme, setThemeMode } from "../lib/theme";
import { useAppStore } from "../store/appStore";
import SettingsPage from "./SettingsPage";

/**
 * E1: the general tab's actions belong to the shared `Button` facade, its
 * groups to `SettingsSection` / `SettingsRow`, and each group owns a
 * `role="alert"` error line.
 *
 * The facade is a behaviour contract as much as a class contract: the click,
 * the disabled state and the accessible name have to survive the migration. A
 * test that only reads `className` would pass on a button that no longer saves.
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

function panel(id: string): HTMLElement {
  const node = document.getElementById(`settings-panel-${id}`);
  expect(node).toBeTruthy();
  return node as HTMLElement;
}

/** The `SettingsSection` that owns a heading, by its visible name. */
function group(heading: string): HTMLElement {
  const node = screen.getByRole("heading", { level: 2, name: heading }).closest("section");
  expect(node).toBeTruthy();
  return node as HTMLElement;
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

describe("the general tab on the button facade", () => {
  it("puts the general tab's actions on the shared button facade", async () => {
    const user = userEvent.setup();
    pageOnly();
    await screen.findByRole("tab", { name: "General" });

    const general = panel("general");
    const dark = within(general).getByRole("button", { name: "Dark" });
    expect(dark.className).toContain("kin-btn");
    expect(dark.className).toContain("kin-btn-secondary");
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    expect(
      within(general).getByRole("button", { name: "Light" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      within(general).getByRole("button", { name: "System" }).getAttribute("aria-pressed"),
    ).toBe("false");

    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    const advanced = panel("advanced");
    for (const name of ["Save price table", "Save limits"]) {
      const button = within(advanced).getByRole("button", { name });
      expect(button.className).toContain("kin-btn");
      expect(button.className).toContain("kin-btn-primary");
    }
    const reset = within(advanced).getByRole("button", { name: "Reset to LiteLLM defaults" });
    expect(reset.className).toContain("kin-btn");
    expect(reset.className).toContain("kin-btn-secondary");

    await user.click(screen.getByRole("tab", { name: "Routing" }));
    const policySave = within(panel("routing")).getByRole("button", {
      name: "Save rate-limit policy",
    });
    expect(policySave.className).toContain("kin-btn");
    expect(policySave.className).toContain("kin-btn-primary");
  });

  it("keeps one filled primary in each general-tab group", async () => {
    const user = userEvent.setup();
    pageOnly("/settings?tab=advanced");
    await screen.findByRole("tab", { name: "Advanced" });

    expect(group("Price table").querySelectorAll(".kin-btn-primary")).toHaveLength(1);
    expect(group("Agent usage limits").querySelectorAll(".kin-btn-primary")).toHaveLength(1);

    await user.click(screen.getByRole("tab", { name: "Routing" }));
    expect(group("Rate-limit policy").querySelectorAll(".kin-btn-primary")).toHaveLength(1);
  });

  it("still saves, resets and switches the theme through the facade", async () => {
    const user = userEvent.setup();
    pageOnly("/settings?tab=advanced");

    const price = (await screen.findAllByDisplayValue("{}"))[0] as HTMLTextAreaElement;
    fireEvent.change(price, { target: { value: '{"mine":true}' } });
    await user.click(screen.getByRole("button", { name: "Save price table" }));

    await waitFor(() => expect(vi.mocked(updateSettings)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateSettings).mock.calls[0][0]).toMatchObject({
      price_table: '{"mine":true}',
    });

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Reset to LiteLLM defaults" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Reset to LiteLLM defaults" }));
    await waitFor(() => expect(vi.mocked(updateSettings)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateSettings).mock.calls[1][0]).toEqual({ price_table: "" });

    await user.click(screen.getByRole("tab", { name: "General" }));
    await user.click(within(panel("general")).getByRole("button", { name: "Light" }));
    expect(vi.mocked(setThemeMode)).toHaveBeenCalledWith("light");
    expect(vi.mocked(applyTheme)).toHaveBeenCalledWith("light");
  });

  it("wires label, hint and error to the general-tab fields", async () => {
    const user = userEvent.setup();
    pageOnly("/settings?tab=routing");
    await screen.findByRole("tab", { name: "Routing" });

    await user.click(screen.getByRole("radio", { name: "Auto-switch to another agent" }));
    const field = screen.getByRole("textbox", { name: "Switch preference (JSON array)" });
    expect(field).toBeTruthy();
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toContain(
      'e.g. ["codex","kin"]',
    );

    vi.mocked(updateSettings).mockRejectedValueOnce(new Error("boom"));
    await user.click(screen.getByRole("button", { name: "Save rate-limit policy" }));

    const routing = panel("routing");
    await waitFor(() => {
      const alerts = Array.from(routing.querySelectorAll('[role="alert"]'));
      expect(alerts.some((node) => node.textContent?.includes("boom"))).toBe(true);
    });
  });
});
