// @vitest-environment jsdom
// KIN-AGENTS-002 — 看清安装探测与会话/角色导入的边界（J6）：本套件持有
// 「打开 tab 才读 provider、只读一次」「迟到的读不覆盖新的」三条页面验收行。
// Partial: cases 13–16 and 18 (pre-existing import/role flows) are deferred —
// see the PR body and rsi/state/followups.md.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listAgentProviders,
  listAgents,
  type AgentInfo,
  type AgentProvider,
  type ProviderEntry,
  type Settings,
} from "../api/client";
import { setLocale, t } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { useAppStore } from "../store/appStore";
import SettingsPage from "./SettingsPage";

const baseSettings = {
  price_table: "{}",
  agent_limits: "{}",
  agent_roles: "[]",
  "agent.default": "",
  limit_policy: "ask",
  "limit_policy.fallback_agents": "[]",
  "provider.active_id": "",
} as unknown as Settings;

const fixtures = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  providers: [] as ProviderEntry[],
  agents: [] as Array<Partial<AgentInfo> & { id: string; name: string }>,
}));

vi.mock("../lib/theme", () => ({
  getThemeMode: () => "dark",
  setThemeMode: vi.fn(),
  applyTheme: vi.fn(),
}));

vi.mock("../api/useLiveResources", () => ({
  useTaskList: () => ({ data: [], loaded: true, error: null, pageFull: false, loading: false }),
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
    listAgents: vi.fn(async (): Promise<AgentInfo[]> =>
      fixtures.agents.map((agent) => ({
        installed: true,
        available: true,
        default: false,
        model_list_source: "recommended" as const,
        model_list_status: "available" as const,
        permission_modes: ["default", "accept_edits", "yolo"],
        ...agent,
      })),
    ),
    listProviders: vi.fn(async () => ({
      active_id: String(fixtures.settings["provider.active_id"] ?? ""),
      providers: fixtures.providers,
    })),
    listAgentProviders: vi.fn(),
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
    isAuthenticated: vi.fn(() => true),
    listAgentManagement: vi.fn(async () => []),
    getUsageSummary: vi.fn(async () => []),
    getUsageLimits: vi.fn(async () => []),
  };
});

vi.mock("../hooks/useMachines", () => ({
  refreshMachines: vi.fn(async () => []),
  useMachines: () => ({
    machines: [],
    agents: [],
    loading: false,
    failed: false,
    refresh: () => {},
  }),
  resetMachinesCache: () => {},
}));
vi.mock("../hooks/useMinWidth", () => ({ useMinWidth: () => false }));
vi.mock("../lib/desktop", () => ({ isKinDesktop: () => false }));
vi.mock("../components/terminal/TerminalPanel", () => ({ default: () => null }));

function provider(over: Partial<AgentProvider> & { id: string }): AgentProvider {
  return {
    name: over.id,
    kind: "cli",
    state: "available",
    installed: true,
    available: true,
    last_scanned_at: "2026-10-26T09:07:00",
    capabilities: [{ capability: "session_list", state: "available" }],
    ...over,
  };
}

const codex = provider({ id: "codex", name: "Codex" });

function pageAt(search: string) {
  window.history.replaceState({}, "", `/settings${search}`);
  return render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function group(title: string): HTMLElement {
  return screen.getByRole("heading", { name: title, level: 2 }).closest("section") as HTMLElement;
}

// Read through the translator at call time: this file sets the locale in
// `beforeEach`, so module-level constants would freeze the default language.
const detectionHeading = () => t("settings.localAgents.detectionHeading");
const importHeading = () => t("settings.localAgents.importHeading");

beforeEach(() => {
  resetLeaveGuard();
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  setLocale("en");
  fixtures.settings = { ...baseSettings } as unknown as Record<string, unknown>;
  fixtures.providers = [];
  fixtures.agents = [];
  vi.mocked(listAgentProviders).mockReset().mockResolvedValue([codex]);
  vi.mocked(listAgents).mockReset();
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
});

describe("KIN-AGENTS-002 · what opening the agents tab reads", () => {
  it("KIN-AGENTS-002 opening Settings on the general tab reads no agent providers", async () => {
    pageAt("");

    // The appearance section only renders once getSettings answered; by then
    // the providers read would have fired if it were still inside load().
    expect(await screen.findByText(t("settings.appearance.heading"))).not.toBeNull();
    await waitFor(() => expect(vi.mocked(listAgents)).toHaveBeenCalled());
    expect(vi.mocked(listAgentProviders)).not.toHaveBeenCalled();
  });

  it("KIN-AGENTS-002 opening the agents tab reads providers once and renders both groups", async () => {
    const user = userEvent.setup();
    pageAt("");

    await user.click(await screen.findByRole("tab", { name: t("settings.tabs.agents") }));

    expect(await screen.findByText(t("settings.localAgents.detectionRule"))).not.toBeNull();
    expect(screen.getByText(t("settings.localAgents.importRule"))).not.toBeNull();
    expect(screen.getByText(t("settings.localAgents.rolesRule"))).not.toBeNull();
    await waitFor(() => expect(vi.mocked(listAgentProviders)).toHaveBeenCalledTimes(1));

    // Detection rows and import rows both come from that one read.
    expect(within(group(detectionHeading())).getByText("Codex")).not.toBeNull();
    expect(within(group(importHeading())).getByText("Codex")).not.toBeNull();

    // Leaving and coming back keeps the rows; it does not start another probe.
    await user.click(screen.getByRole("tab", { name: t("settings.tabs.general") }));
    await user.click(screen.getByRole("tab", { name: t("settings.tabs.agents") }));
    expect(vi.mocked(listAgentProviders)).toHaveBeenCalledTimes(1);
  });

  it("KIN-AGENTS-002 a late provider read does not paint over a newer one", async () => {
    const stale = provider({ id: "stale", name: "Stale Agent" });
    const fresh = provider({ id: "fresh", name: "Fresh Agent" });
    let releaseFirst: (() => void) | null = null;
    vi.mocked(listAgentProviders)
      .mockResolvedValue([fresh])
      .mockImplementationOnce(
        () =>
          new Promise<AgentProvider[]>((resolve) => {
            releaseFirst = () => resolve([stale]);
          }),
      );

    pageAt("?tab=agents");
    await waitFor(() => expect(vi.mocked(listAgentProviders)).toHaveBeenCalledTimes(1));

    // A reconnect while the tab is open starts a second read; the first one is
    // still out and must not win when it finally answers.
    act(() => {
      useAppStore.setState({ reconnectGen: 1 });
    });
    await waitFor(() => expect(vi.mocked(listAgentProviders)).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByText("Fresh Agent")).not.toHaveLength(0);

    await act(async () => {
      releaseFirst?.();
    });
    expect(screen.queryByText("Stale Agent")).toBeNull();
    expect(screen.getAllByText("Fresh Agent")).not.toHaveLength(0);
  });
});
