// @vitest-environment jsdom
// R-settings-default-newchat — 保存下来的默认 agent，就是下一次新会话使用的那一个。
// 本套件持有的验收行：
//   1. 保存成功 → 共享的机器快照被要求重读（不是只刷新设置页自己的列表）；
//   2. 保存失败 → 不重读，错误照旧显示；
//   3. 在设置里改了默认 agent，下一次打开 /new 立刻显示新 agent，无需刷新、无需等 30 秒。
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

/** What one `/api/agents` row says, beyond the defaults the mock fills in. */
type AgentFixture = {
  id: string;
  name: string;
  installed?: boolean;
  available?: boolean;
  reason?: string;
};

const fixtures = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  providers: [] as ProviderEntry[],
  /** Returned by `updateSettings` instead of saving, when set. */
  saveError: null as Error | null,
  /** True for the settings-only tests: the hook is replaced, the refresh is counted. */
  stubMachinesHook: true,
  refreshCalls: 0,
  agents: [] as AgentFixture[],
  /**
   * How `listAgents` answers. `hold` keeps the read pending until the test
   * calls `releaseAgentRead`; `reject` fails it. The default-agent row must
   * tell the truth in all three, so the tests need to steer the read.
   */
  agentRead: "ok" as "ok" | "hold" | "reject",
  releaseAgentRead: null as null | (() => void),
  agentReadCalls: 0,
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
    listAgents: vi.fn((): Promise<AgentInfo[]> => {
      fixtures.agentReadCalls += 1;
      const answer = (): AgentInfo[] => {
        const chosen = String(fixtures.settings["agent.default"] ?? "");
        return fixtures.agents.map((agent) => ({
          installed: true,
          available: true,
          ...agent,
          default: agent.id === chosen,
          model_list_source: "recommended" as const,
          model_list_status: "available" as const,
          permission_modes: ["default", "accept_edits", "yolo"],
        }));
      };
      if (fixtures.agentRead === "reject") {
        return Promise.reject(new Error("agent catalog unreadable"));
      }
      if (fixtures.agentRead === "hold") {
        return new Promise<AgentInfo[]>((resolve) => {
          fixtures.releaseAgentRead = () => resolve(answer());
        });
      }
      return Promise.resolve(answer());
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
  fixtures.agentRead = "ok";
  fixtures.releaseAgentRead = null;
  fixtures.agentReadCalls = 0;
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
    await waitFor(() =>
      expect(
        (document.querySelector('[aria-haspopup="listbox"]') as HTMLButtonElement).disabled,
      ).toBe(false),
    );
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

// P8 item 2a: the one settings row that exists has to say what it affects, and
// the story — not an invented surface — records where the other three defaults
// live. The negative case is deliberate: a later slice that adds a model,
// machine or permission row here must do it through a signed story.
const EN_EFFECT = "A new chat starts with this agent until you pick another one in the composer.";
const ZH_EFFECT = "新建对话默认用它，除非你在输入框里另选。";

describe("KIN-SETTINGS-001 · the default agent row says what it affects", () => {
  it("KIN-SETTINGS-001 the default agent row says a new chat starts with it (en + zh)", async () => {
    const user = userEvent.setup();
    pageOnly();
    await openProviders(user);

    // The sentence under the picker says what the saved value does on the next
    // chat; the hint above it only says which agents can be selected.
    expect(await screen.findByText(EN_EFFECT)).toBeTruthy();
    const described = document.getElementById("default-agent-desc");
    expect(described?.textContent).toContain(t("settings.provider.defaultAgentHint"));
    expect(described?.textContent).toContain(EN_EFFECT);

    const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    expect(trigger?.getAttribute("aria-describedby")).toBe("default-agent-desc");

    setLocale("zh");
    expect(await screen.findByText(ZH_EFFECT)).toBeTruthy();
    expect(screen.queryByText(EN_EFFECT)).toBeNull();
    const zhDescribed = document.getElementById("default-agent-desc");
    expect(zhDescribed?.textContent).toContain(t("settings.provider.defaultAgentHint"));
    expect(zhDescribed?.textContent).toContain(ZH_EFFECT);
  });

  it("KIN-SETTINGS-001 the other three defaults are recorded in the story, not invented in settings", async () => {
    const user = userEvent.setup();
    pageOnly();
    await openProviders(user);
    await screen.findByText(t("settings.provider.defaultAgentHint"));

    // Settings owns one default row today: the agent. Model, machine and
    // permission are composer drafts (`kin_draft_model`, `kin_draft_machine`,
    // `kin_permission_mode`); promoting them is a story change, not a row this
    // slice may add quietly. Hidden panels are included so the row cannot be
    // waiting on another tab either.
    for (const name of [
      /default model/i,
      /default (device|machine)/i,
      /default (permission|mode)/i,
    ]) {
      expect(screen.queryByRole("button", { name, hidden: true })).toBeNull();
      expect(screen.queryByRole("combobox", { name, hidden: true })).toBeNull();
    }
  });
});

// The row used to render one option — Auto — until `/api/agents` answered, with
// no loading word, no failure and no retry. A person could open that list,
// choose Auto and save, rewriting the stored default from a catalog that never
// arrived. These four rows pin the row's three states and the last-good list.
function agentTrigger(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    '[aria-haspopup="listbox"]',
  ) as HTMLButtonElement;
}

async function openAgentList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(agentTrigger());
  return screen.findByRole("listbox", { name: t("settings.provider.defaultAgent") });
}

describe("KIN-SETTINGS-001 · the default agent row tells the truth while the catalog is in flight", () => {
  it("KIN-SETTINGS-001 the default agent picker cannot be opened until the agent catalog arrives", async () => {
    fixtures.agentRead = "hold";
    const user = userEvent.setup();
    pageOnly();
    await openProviders(user);

    expect(await screen.findByText(t("settings.provider.agentListLoading"))).toBeTruthy();
    expect(agentTrigger().disabled).toBe(true);
    // An enabled one-option list is the defect: clicking must offer nothing to
    // choose until the catalog can say what exists.
    await user.click(agentTrigger());
    expect(screen.queryByRole("listbox", { name: t("settings.provider.defaultAgent") })).toBeNull();

    await act(async () => {
      fixtures.releaseAgentRead?.();
    });
    await waitFor(() => expect(agentTrigger().disabled).toBe(false));
    expect(screen.queryByText(t("settings.provider.agentListLoading"))).toBeNull();

    const list = await openAgentList(user);
    expect(within(list).getByRole("option", { name: /Claude Code/ })).toBeTruthy();
    expect(within(list).getByRole("option", { name: /Codex CLI/ })).toBeTruthy();
  });

  it("KIN-SETTINGS-001 a failed agent read says so and offers a retry that reloads the catalog", async () => {
    fixtures.agentRead = "reject";
    const user = userEvent.setup();
    pageOnly();
    await openProviders(user);

    expect(await screen.findByText(t("settings.provider.agentListFailed"))).toBeTruthy();
    expect(agentTrigger().disabled).toBe(true);
    await user.click(agentTrigger());
    expect(screen.queryByRole("listbox", { name: t("settings.provider.defaultAgent") })).toBeNull();

    fixtures.agentRead = "ok";
    const readsBeforeRetry = fixtures.agentReadCalls;
    await user.click(screen.getByRole("button", { name: t("common.retry") }));

    await waitFor(() => expect(fixtures.agentReadCalls).toBe(readsBeforeRetry + 1));
    await waitFor(() => expect(agentTrigger().disabled).toBe(false));
    expect(screen.queryByText(t("settings.provider.agentListFailed"))).toBeNull();
    const list = await openAgentList(user);
    expect(within(list).getByRole("option", { name: /Claude Code/ })).toBeTruthy();
    expect(within(list).getByRole("option", { name: /Codex CLI/ })).toBeTruthy();
  });

  it("KIN-SETTINGS-001 the stored default keeps its product name when it cannot run right now", async () => {
    // Installed but not runnable: the daemon reports it, the picker used to
    // drop it, and the trigger printed the bare id.
    fixtures.agents = [
      { ...CLAUDE, installed: true, available: false, reason: "verifying" },
      CODEX,
    ];
    const user = userEvent.setup();
    pageOnly();
    await openProviders(user);
    await waitFor(() => expect(agentTrigger().disabled).toBe(false));

    expect(agentTrigger().textContent).toContain("Claude Code");
    expect(agentTrigger().textContent?.trim()).not.toBe(CLAUDE.id);

    const list = await openAgentList(user);
    const stored = within(list).getByRole("option", { name: /Claude Code/ });
    expect(stored.textContent).toContain(CLAUDE.id);
    expect(stored.textContent).toContain(t("settings.provider.unavailable").trim());
    // A runnable agent is still offered alongside it.
    expect(within(list).getByRole("option", { name: /Codex CLI/ })).toBeTruthy();
  });

  it("KIN-SETTINGS-001 a failed agent read keeps the agents already on screen", async () => {
    const user = userEvent.setup();
    pageOnly();
    await openProviders(user);
    await waitFor(() => expect(agentTrigger().disabled).toBe(false));

    // Saving re-reads the catalog (`/api/agents`). That read failing must not
    // blank the list a person can already see — only say it is stale.
    fixtures.agentRead = "reject";
    await user.click(saveDefaultAgent());

    expect(await screen.findByText(t("settings.provider.agentListFailed"))).toBeTruthy();
    const list = await openAgentList(user);
    expect(within(list).getByRole("option", { name: /Claude Code/ })).toBeTruthy();
    expect(within(list).getByRole("option", { name: /Codex CLI/ })).toBeTruthy();
  });
});
