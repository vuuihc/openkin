// @vitest-environment jsdom
// KIN-AGENTS-002 — 看清安装探测与会话/角色导入的边界（J6）：本套件持有
// 「打开 tab 才读 provider、只读一次」「迟到的读不覆盖新的」「三种动作各自
// 只做自己的事」的页面验收行。
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listAgentProviders,
  listAgents,
  importAgentSessions,
  updateSettings,
  type AgentInfo,
  type AgentProvider,
  type AgentSessionImportResult,
  type ProviderEntry,
  type Settings,
} from "../api/client";
import { setLocale, t } from "../i18n";
import { AGENT_ROLES_CHANGED_EVENT } from "../lib/agentRoles";
import { resetLeaveGuard } from "../lib/leaveGuard";
import type { Machine } from "../lib/devices";
import { refreshMachines } from "../hooks/useMachines";
import { useAgentSessionImport } from "../hooks/useAgentSessionImport";
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
    importAgentSessions: vi.fn(),
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

// The import hook reads the same machine list as the sidebar, so the whole
// surface must agree on which machines one errand asks.
vi.mock("../hooks/useMachines", () => ({
  refreshMachines: vi.fn(),
  useMachines: () => ({ machines: [], agents: [], loading: false, failed: false, refresh: () => {} }),
  resetMachinesCache: () => {},
}));

vi.mock("../hooks/useMinWidth", () => ({
  useMinWidth: () => false,
}));

vi.mock("../lib/desktop", () => ({
  isKinDesktop: () => false,
}));

vi.mock("../components/terminal/TerminalPanel", () => ({
  default: () => null,
}));

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

const here = {
  id: "desktop-hub",
  label: "hub",
  isSelf: true,
  online: true,
  roots: [],
  agents: [],
} as Machine;

const laptop = {
  id: "desk-2",
  label: "Laptop",
  isSelf: false,
  online: true,
  roots: [],
  agents: [],
} as Machine;

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
  const heading = screen.getByRole("heading", { name: title, level: 2 });
  return heading.closest("section") as HTMLElement;
}

// Read through the translator at call time: this file sets the locale in
// `beforeEach`, so a module-level constant would freeze the default language.
const detectionHeading = () => t("settings.localAgents.detectionHeading");
const importHeading = () => t("settings.localAgents.importHeading");
const rolesHeading = () => t("settings.roles.heading");

/** A second surface using the real shared import flag, standing in for the
 *  sidebar's per-provider menu. */
function ImportProbe() {
  const { importing, importEveryMachine } = useAgentSessionImport();
  return (
    <button type="button" onClick={() => void importEveryMachine()}>
      {importing ? "probe importing" : "probe import"}
    </button>
  );
}

beforeEach(() => {
  resetLeaveGuard();
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setLocale("en");
  fixtures.settings = { ...baseSettings } as unknown as Record<string, unknown>;
  fixtures.providers = [];
  fixtures.agents = [];
  vi.mocked(listAgentProviders).mockReset().mockResolvedValue([codex]);
  vi.mocked(importAgentSessions)
    .mockReset()
    .mockResolvedValue({ imported: 1, providers: { codex: 1 } });
  vi.mocked(refreshMachines).mockReset().mockResolvedValue([here]);
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

    // Leaving and coming back keeps the rows and the timestamp; it does not
    // start another probe.
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

describe("KIN-AGENTS-002 · the three actions each do only their own job", () => {
  it("KIN-AGENTS-002 a failed import keeps the existing index and offers a retry", async () => {
    const user = userEvent.setup();
    vi.mocked(importAgentSessions).mockRejectedValue(new Error("codex is not signed in"));
    pageAt("?tab=agents");
    await screen.findAllByText("Codex");

    await user.click(screen.getByRole("button", { name: t("settings.localAgents.import") }));

    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    const toast = useAppStore.getState().toasts[0];
    expect(toast.tone).toBe("error");
    // The source is named, and the reason is the provider's own sentence.
    expect(toast.message).toContain(t("machine.thisMachine"));
    expect(toast.message).toContain("codex is not signed in");

    // The rows and the button are still there, so pressing again is the retry;
    // the failure did not blank the group or re-read the providers.
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(
      (screen.getByRole("button", { name: t("settings.localAgents.import") }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(vi.mocked(listAgentProviders)).toHaveBeenCalledTimes(1);
  });

  it("KIN-AGENTS-002 the group import asks every paired machine", async () => {
    const user = userEvent.setup();
    vi.mocked(refreshMachines).mockResolvedValue([here, laptop]);
    pageAt("?tab=agents");
    await screen.findAllByText("Codex");

    await user.click(screen.getByRole("button", { name: t("settings.localAgents.import") }));

    await waitFor(() => expect(vi.mocked(importAgentSessions)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(importAgentSessions)).toHaveBeenNthCalledWith(1, undefined, "");
    expect(vi.mocked(importAgentSessions)).toHaveBeenNthCalledWith(2, undefined, "desk-2");
  });

  it("KIN-AGENTS-002 a sidebar import in flight disables this tab's imports", async () => {
    const user = userEvent.setup();
    let releaseImport: ((value: AgentSessionImportResult) => void) | null = null;
    vi.mocked(importAgentSessions).mockImplementation(
      () =>
        new Promise<AgentSessionImportResult>((resolve) => {
          releaseImport = resolve;
        }),
    );

    render(<ImportProbe />);
    await user.click(screen.getByRole("button", { name: "probe import" }));
    expect(await screen.findByRole("button", { name: "probe importing" })).not.toBeNull();

    pageAt("?tab=agents");
    await screen.findAllByText("Codex");

    const rowImport = within(group(importHeading())).getByRole("button", {
      name: t("settings.localAgents.importProviderLabel", { name: "Codex" }),
    });
    expect((rowImport as HTMLButtonElement).disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: t("settings.localAgents.importing"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      releaseImport?.({ imported: 0, providers: {} });
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: t("settings.localAgents.import"),
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  it("KIN-AGENTS-002 saving a role sends it, emits AGENT_ROLES_CHANGED_EVENT, and starts no probe or import", async () => {
    const user = userEvent.setup();
    const rolesChanged = vi.fn();
    window.addEventListener(AGENT_ROLES_CHANGED_EVENT, rolesChanged);
    try {
      pageAt("?tab=agents");
      await screen.findAllByText("Codex");

      await user.click(screen.getByRole("button", { name: t("settings.roles.add") }));
      await user.type(screen.getByLabelText(t("settings.roles.name", { index: 1 })), "Reviewer");
      await user.type(screen.getByLabelText(t("settings.roles.prompt", { index: 1 })), "Review it.");
      await user.click(
        within(group(rolesHeading())).getByRole("button", {
          name: t("settings.localAgents.save"),
        }),
      );

      await waitFor(() => expect(vi.mocked(updateSettings)).toHaveBeenCalled());
      expect(vi.mocked(updateSettings)).toHaveBeenCalledWith(
        expect.objectContaining({ agent_roles: expect.stringContaining("Reviewer") }),
      );
      expect(rolesChanged).toHaveBeenCalledTimes(1);
      expect(vi.mocked(listAgentProviders)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(importAgentSessions)).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(AGENT_ROLES_CHANGED_EVENT, rolesChanged);
    }
  });

  it("KIN-AGENTS-002 removing the probe group leaves row import and role saving working", async () => {
    const user = userEvent.setup();
    pageAt("?tab=agents");
    await screen.findAllByText("Codex");

    // The import half renders from the page's provider read, not from the
    // detection half's rows: taking that group off the screen leaves the
    // import rows, the per-provider errand and the role editor intact.
    group(detectionHeading()).remove();
    const imports = group(importHeading());
    await user.click(
      within(imports).getByRole("button", {
        name: t("settings.localAgents.importProviderLabel", { name: "Codex" }),
      }),
    );
    await waitFor(() => expect(vi.mocked(importAgentSessions)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(importAgentSessions)).toHaveBeenCalledWith(["codex"], "");

    await user.click(screen.getByRole("button", { name: t("settings.roles.add") }));
    await user.type(screen.getByLabelText(t("settings.roles.name", { index: 1 })), "Reviewer");
    await user.type(screen.getByLabelText(t("settings.roles.prompt", { index: 1 })), "Review it.");
    await user.click(
      within(group(rolesHeading())).getByRole("button", {
        name: t("settings.localAgents.save"),
      }),
    );
    await waitFor(() => expect(vi.mocked(updateSettings)).toHaveBeenCalled());
    expect(vi.mocked(updateSettings)).toHaveBeenCalledWith(
      expect.objectContaining({ agent_roles: expect.stringContaining("Reviewer") }),
    );
  });
});
