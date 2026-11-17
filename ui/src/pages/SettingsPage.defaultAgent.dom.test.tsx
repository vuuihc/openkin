// @vitest-environment jsdom
// R-settings-default-newchat — 保存下来的默认 agent，就是下一次新会话使用的那一个。
// 本套件持有的验收行：
//   1. 保存成功 → 共享的机器快照被要求重读（不是只刷新设置页自己的列表）；
//   2. 保存失败 → 不重读，错误照旧显示；
//   3. 在设置里改了默认 agent，下一次打开 /new 立刻显示新 agent，无需刷新、无需等 30 秒。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  updateSettings,
  type AgentInfo,
  type ProviderEntry,
  type Settings,
} from "../api/client";
import { setLocale, t } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { resetMachinesCache } from "../hooks/useMachines";
import { useAppStore } from "../store/appStore";
import NewChatPage from "./NewChatPage";
import SettingsPage from "./SettingsPage";

/**
 * The default agent is saved in Settings but read from the shared machine
 * snapshot by the new-chat face (and the Run settings sheet). A save that only
 * refreshed the settings page's own agent list left that snapshot holding the
 * old answer for up to its 30-second freshness window: the toast said "saved"
 * while `/new` still named the previous host agent. These tests pin the save
 * to the shared snapshot, and the failure to stay quiet.
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

const CLAUDE = { id: "claude-code", name: "Claude Code" };
const CODEX = { id: "codex-cli", name: "Codex CLI" };

const fixtures = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  providers: [] as ProviderEntry[],
  /** Returned by `updateSettings` instead of saving, when set. */
  saveError: null as Error | null,
  /** True for the settings-only tests: the hook is replaced, the refresh is counted. */
  stubMachinesHook: true,
  refreshCalls: 0,
  agents: [] as Array<{ id: string; name: string }>,
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
      if (fixtures.saveError) throw fixtures.saveError;
      fixtures.settings = { ...fixtures.settings, ...body };
      return fixtures.settings as unknown as Settings;
    }),
    /** The default flag follows the saved `agent.default`, as the daemon's does. */
    listAgents: vi.fn(async (): Promise<AgentInfo[]> => {
      const chosen = String(fixtures.settings["agent.default"] ?? "");
      return fixtures.agents.map((agent) => ({
        ...agent,
        installed: true,
        available: true,
        default: agent.id === chosen,
        model_list_source: "recommended" as const,
        model_list_status: "available" as const,
        permission_modes: ["default", "accept_edits", "yolo"],
      }));
    }),
    listProviders: vi.fn(async () => ({
      active_id: String(fixtures.settings["provider.active_id"] ?? ""),
      providers: fixtures.providers,
    })),
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
      desktop_id: "desktop-self",
      desktop_name: "This Mac",
    }),
    listMachines: vi.fn(async () => []),
    listAgentManagement: vi.fn(async () => []),
    getUsageSummary: vi.fn(async () => []),
    getUsageLimits: vi.fn(async () => []),
    recentCwds: vi.fn(async () => []),
    findProjectByRoot: vi.fn().mockRejectedValue(new actual.ApiError(404, "not found")),
    createTask: vi.fn(),
  };
});

// The real `useMachines` owns a module-level snapshot, which is exactly what
// the last test is about. The first two tests replace the hook with a cheap
// face and count `refreshMachines` calls; the third uses both as shipped.
vi.mock("../hooks/useMachines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useMachines")>();
  return {
    ...actual,
    useMachines: (...args: Parameters<typeof actual.useMachines>) =>
      fixtures.stubMachinesHook
        ? { machines: [], agents: [], loading: false, failed: false, refresh: () => {} }
        : actual.useMachines(...args),
    refreshMachines: (...args: Parameters<typeof actual.refreshMachines>) => {
      fixtures.refreshCalls += 1;
      return fixtures.stubMachinesHook ? Promise.resolve([]) : actual.refreshMachines(...args);
    },
  };
});

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

function pageOnly() {
  window.history.replaceState({}, "", "/settings");
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function newChatOnly() {
  window.history.replaceState({}, "", "/new");
  return render(
    <MemoryRouter initialEntries={["/new"]}>
      <Routes>
        <Route path="/new" element={<NewChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Open the providers tab, where the default agent is saved. */
async function openProviders(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("tab", { name: t("settings.tabs.providers") });
  await user.click(screen.getByRole("tab", { name: t("settings.tabs.providers") }));
}

function saveDefaultAgent() {
  return screen.getByRole("button", { name: t("settings.provider.save") });
}

beforeEach(() => {
  resetLeaveGuard();
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setLocale("en");
  resetMachinesCache();
  fixtures.settings = { ...baseSettings, "agent.default": CLAUDE.id } as unknown as Record<
    string,
    unknown
  >;
  fixtures.providers = [];
  fixtures.saveError = null;
  fixtures.stubMachinesHook = true;
  fixtures.refreshCalls = 0;
  fixtures.agents = [CLAUDE, CODEX];
  useAppStore.setState({ wsStatus: "connected", reconnectGen: 0, toasts: [] });
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
  resetMachinesCache();
});

describe("a saved default agent reaches the shared snapshot", () => {
  it("saving the default agent asks the shared machine snapshot to reload", async () => {
    const user = userEvent.setup();
    pageOnly();
    await openProviders(user);

    await user.click(saveDefaultAgent());

    await waitFor(() => expect(vi.mocked(updateSettings)).toHaveBeenCalled());
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ "agent.default": CLAUDE.id }),
    );
    // The save itself must not wait on the reload…
    await waitFor(() => expect(fixtures.refreshCalls).toBe(1));
  });

  it("a failed save does not reload the machine snapshot", async () => {
    fixtures.saveError = new ApiError(500, "settings write failed");
    const user = userEvent.setup();
    pageOnly();
    await openProviders(user);

    await user.click(saveDefaultAgent());

    expect(await screen.findByText("settings write failed")).toBeTruthy();
    expect(fixtures.refreshCalls).toBe(0);
  });

  it("a saved default agent is the host agent on the next new chat", async () => {
    // The real hook and the real module-level snapshot: this is the acceptance.
    fixtures.stubMachinesHook = false;
    const user = userEvent.setup();

    newChatOnly();
    expect(await screen.findByText("Host agent · Claude Code")).toBeTruthy();
    cleanup();

    pageOnly();
    await openProviders(user);
    // Pick the other agent, then save it as the default.
    await user.click(document.querySelector('[aria-haspopup="listbox"]') as HTMLElement);
    const list = await screen.findByRole("listbox", {
      name: t("settings.provider.defaultAgent"),
    });
    await user.click(within(list).getByRole("option", { name: /codex-cli/ }));
    await user.click(saveDefaultAgent());
    await waitFor(() => expect(fixtures.refreshCalls).toBe(1));
    // Let the fire-and-forget reload land before leaving the page.
    await waitFor(() => expect(String(fixtures.settings["agent.default"])).toBe(CODEX.id));
    cleanup();

    // No fake timers: a second mount inside the 30s window must already see
    // the new default, because the save itself refreshed the one snapshot.
    newChatOnly();
    expect(await screen.findByText("Host agent · Codex CLI")).toBeTruthy();
    expect(screen.queryByText("Host agent · Claude Code")).toBeNull();
  });
});
