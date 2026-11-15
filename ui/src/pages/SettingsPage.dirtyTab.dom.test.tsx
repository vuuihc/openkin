// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEntry, Settings } from "../api/client";
import AppShell from "../components/layout/AppShell";
import { setLocale } from "../i18n";
import { isLeaveGuardArmed, resetLeaveGuard } from "../lib/leaveGuard";
import { useAppStore } from "../store/appStore";
import SettingsPage from "./SettingsPage";

/**
 * Dirty Settings tab changes must not stack history. MemoryRouter cannot
 * exercise the leave-guard sentinel (`window.history.state.idx`), so this
 * file uses a real BrowserRouter stack: list → Advanced, edit, switch to
 * General, one approved Back reaches the list.
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

function panel(id: string): HTMLElement {
  const node = document.getElementById(`settings-panel-${id}`);
  expect(node).toBeTruthy();
  return node as HTMLElement;
}

function app() {
  return (
    <BrowserRouter>
      <AppShell pendingApprovals={[]}>
        <Routes>
          <Route path="/sessions" element={<div>chats page</div>} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </AppShell>
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

beforeEach(() => {
  resetLeaveGuard();
  cleanup();
  vi.clearAllMocks();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.settings = { ...baseSettings } as unknown as Record<string, unknown>;
  fixtures.providers = [];
  useAppStore.setState({ reconnectGen: 0 });
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
  resetLeaveGuard();
});

describe("a dirty Settings tab change on a real history stack", () => {
  it("reaches the list on one approved Back after switching tabs", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    browserAt(["/sessions", "/settings?tab=advanced"]);

    const price = (await screen.findAllByDisplayValue("{}"))[0];
    fireEvent.change(price, { target: { value: '{"mine":true}' } });
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));

    await user.click(screen.getByRole("tab", { name: "General" }));
    await waitFor(() => expect(panel("general").hidden).toBe(false));
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));
    expect(window.location.pathname + window.location.search).toBe("/settings");

    // System Back (the leave-guard sentinel path). MemoryRouter cannot
    // exercise this; the header button uses React Router's own index, which
    // this jsdom fixture cannot keep in sync with the armed entry.
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(screen.getByText("chats page")).toBeTruthy();
  });
});
