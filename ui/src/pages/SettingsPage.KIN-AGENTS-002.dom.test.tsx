// @vitest-environment jsdom
// KIN-AGENTS-002 — agents tab 的页面验收：打开 tab 才读、只读一次、迟到不覆盖；
// 导入失败点名来源并可重试、组底导入问所有已配对机器、别处的导入禁用本页按钮、
// 角色保存不探测不导入、检测组删除后导入组自立。
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  importAgentSessions,
  listAgentProviders,
  listAgents,
  updateSettings,
  type AgentProvider,
  type AgentSessionImportResult,
  type Settings,
} from "../api/client";
import { useAgentSessionImport } from "../hooks/useAgentSessionImport";
import { refreshMachines } from "../hooks/useMachines";
import { setLocale, t } from "../i18n";
import { AGENT_ROLES_CHANGED_EVENT } from "../lib/agentRoles";
import type { Machine } from "../lib/devices";
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

const fixtures = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

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
    listAgents: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ active_id: "", providers: [] })),
    listAgentProviders: vi.fn(),
    importAgentSessions: vi.fn(),
    updateSettings: vi.fn(),
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

/** The same section, after the page's first settings read has painted it. */
async function findGroup(title: string): Promise<HTMLElement> {
  return (await screen.findByRole("heading", { name: title, level: 2 })).closest(
    "section",
  ) as HTMLElement;
}

// Read through the translator at call time: this file sets the locale in
// `beforeEach`, so module-level constants would freeze the default language.
const importHeading = () => t("settings.localAgents.importHeading");
const rolesHeading = () => t("settings.roles.heading");

/** This console's machine list, with two machines paired beyond this one. */
function machines(): Machine[] {
  const machine = (id: string, label: string, isSelf: boolean): Machine => ({
    id,
    label,
    isSelf,
    online: true,
    roots: [],
    agents: [],
  });
  return [
    machine("self-1", "This Mac", true),
    machine("node-a", "Laptop", false),
    machine("node-b", "Studio", false),
  ];
}

/** An import held open, so a test can look at the screens while it is out. */
function deferredImport() {
  let release: ((result: AgentSessionImportResult) => void) | null = null;
  vi.mocked(importAgentSessions).mockImplementation(
    () =>
      new Promise<AgentSessionImportResult>((resolve) => {
        release = resolve;
      }),
  );
  return (result: AgentSessionImportResult = { imported: 0, providers: {} }) => release?.(result);
}

beforeEach(() => {
  resetLeaveGuard();
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  setLocale("en");
  fixtures.settings = { ...baseSettings } as unknown as Record<string, unknown>;
  vi.mocked(listAgentProviders).mockReset().mockResolvedValue([codex]);
  vi.mocked(listAgents).mockReset().mockResolvedValue([]);
  vi.mocked(importAgentSessions).mockReset().mockResolvedValue({ imported: 0, providers: {} });
  vi.mocked(refreshMachines).mockReset().mockResolvedValue([]);
  vi.mocked(updateSettings).mockReset().mockResolvedValue({ ...baseSettings } as unknown as Settings);
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

    expect(await screen.findByText(t("settings.localAgents.importRule"))).not.toBeNull();
    expect(screen.getByText(t("settings.localAgents.rolesRule"))).not.toBeNull();
    await waitFor(() => expect(vi.mocked(listAgentProviders)).toHaveBeenCalledTimes(1));

    // The import rows (and only they) render from that one read.
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

  it("KIN-AGENTS-002 a failed provider import names the source, keeps the rows and can be retried", async () => {
    const user = userEvent.setup();
    vi.mocked(importAgentSessions).mockRejectedValue(new Error("daemon went away"));
    pageAt("?tab=agents");

    const rowImport = await screen.findByRole("button", {
      name: t("settings.localAgents.importProviderLabel", { name: "Codex" }),
    });
    await user.click(rowImport);

    // The failure is reported as a toast that names the machine that did not
    // answer and quotes its own reason — not a page-wide "something failed".
    await waitFor(() => {
      expect(useAppStore.getState().toasts).toEqual([
        expect.objectContaining({
          tone: "error",
          message: t("settings.localAgents.importPartialSource", {
            imported: 0,
            source: t("machine.thisMachine"),
            reason: "daemon went away",
          }),
        }),
      ]);
    });
    // A failed import writes nothing: the rows it would have indexed stay.
    expect(within(group(importHeading())).getByText("Codex")).not.toBeNull();

    // Retry is the same row button, live again, and a second press asks again.
    await waitFor(() => expect((rowImport as HTMLButtonElement).disabled).toBe(false));
    await user.click(rowImport);
    await waitFor(() => expect(vi.mocked(importAgentSessions)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(importAgentSessions).mock.calls.map(([agents]) => agents)).toEqual([
      ["codex"],
      ["codex"],
    ]);
  });

  it("KIN-AGENTS-002 the group-bottom import asks every paired machine, not only this one", async () => {
    const user = userEvent.setup();
    vi.mocked(refreshMachines).mockResolvedValue(machines());
    vi.mocked(importAgentSessions).mockResolvedValue({ imported: 1, providers: { codex: 1 } });
    pageAt("?tab=agents");

    const imports = await findGroup(importHeading());
    await user.click(
      within(imports).getByRole("button", { name: t("settings.localAgents.import") }),
    );

    // This machine is asked by the empty device id; each paired machine by its
    // own id, in the order the machine list shows them.
    await waitFor(() => expect(vi.mocked(importAgentSessions)).toHaveBeenCalledTimes(3));
    expect(vi.mocked(importAgentSessions).mock.calls.map(([, deviceId]) => deviceId)).toEqual([
      "",
      "node-a",
      "node-b",
    ]);
    // "Index my sessions" is not a named provider errand: no agents filter.
    expect(vi.mocked(importAgentSessions).mock.calls.every(([agents]) => agents === undefined)).toBe(
      true,
    );
  });

  it("KIN-AGENTS-002 an import in flight from another surface disables this tab's import buttons", async () => {
    const user = userEvent.setup();
    const release = deferredImport();
    // A second surface (the sidebar's menu) offers the same errand through the
    // same hook. It is not given the page's state by hand: the shared counter in
    // `useAgentSessionImport` is the only thing that can disable both.
    function OtherSurface() {
      const { importing, importEveryMachine } = useAgentSessionImport();
      return (
        <button type="button" disabled={importing} onClick={() => void importEveryMachine()}>
          sidebar import
        </button>
      );
    }

    window.history.replaceState({}, "", "/settings?tab=agents");
    render(
      <MemoryRouter initialEntries={["/settings?tab=agents"]}>
        <OtherSurface />
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const rowImport = await screen.findByRole("button", {
      name: t("settings.localAgents.importProviderLabel", { name: "Codex" }),
    });
    await user.click(screen.getByRole("button", { name: "sidebar import" }));

    await waitFor(() => {
      expect(vi.mocked(importAgentSessions)).toHaveBeenCalled();
      expect((rowImport as HTMLButtonElement).disabled).toBe(true);
    });
    const busy = within(group(importHeading())).getByRole("button", {
      name: t("settings.localAgents.importing"),
    });
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    await act(async () => release());

    await waitFor(() => expect((rowImport as HTMLButtonElement).disabled).toBe(false));
    expect(
      (
        within(group(importHeading())).getByRole("button", {
          name: t("settings.localAgents.import"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("KIN-AGENTS-002 saving a role sends it and emits the composer event without a probe or import", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    window.addEventListener(AGENT_ROLES_CHANGED_EVENT, changed);
    try {
      pageAt("?tab=agents");
      await waitFor(() => expect(vi.mocked(listAgentProviders)).toHaveBeenCalledTimes(1));
      await act(async () => {});

      const roles = await findGroup(rolesHeading());
      await user.click(within(roles).getByRole("button", { name: t("settings.roles.add") }));
      await user.type(screen.getByLabelText(t("settings.roles.name", { index: 1 })), "Reviewer");
      await user.type(
        screen.getByLabelText(t("settings.roles.prompt", { index: 1 })),
        "Review this diff.",
      );

      const reads = vi.mocked(listAgentProviders).mock.calls.length;
      const imports = vi.mocked(importAgentSessions).mock.calls.length;
      await user.click(
        within(roles).getByRole("button", { name: t("settings.localAgents.save") }),
      );

      await waitFor(() => expect(vi.mocked(updateSettings)).toHaveBeenCalledTimes(1));
      const body = vi.mocked(updateSettings).mock.calls[0][0];
      expect(JSON.parse(body.agent_roles ?? "[]")).toEqual([
        { id: expect.any(String), name: "Reviewer", prompt: "Review this diff." },
      ]);
      // The composer reads roles once and stays mounted: without this event the
      // saved role is invisible to its `/` menu until a reload.
      expect(changed).toHaveBeenCalledTimes(1);
      // Saving a role is a settings write and nothing else.
      expect(vi.mocked(listAgentProviders).mock.calls.length).toBe(reads);
      expect(vi.mocked(importAgentSessions).mock.calls.length).toBe(imports);
    } finally {
      window.removeEventListener(AGENT_ROLES_CHANGED_EVENT, changed);
    }
  });

  it("KIN-AGENTS-002 the import group reads providers and imports on its own with the detection group gone", async () => {
    const user = userEvent.setup();
    vi.mocked(importAgentSessions).mockResolvedValue({ imported: 2, providers: { codex: 2 } });
    pageAt("?tab=agents");

    // The agents panel holds exactly the two groups the story keeps: the import
    // group first, the role group second, and no detection group ahead of them.
    await waitFor(() => expect(vi.mocked(listAgentProviders)).toHaveBeenCalledTimes(1));
    const panel = document.getElementById("settings-panel-agents") as HTMLElement;
    expect(
      within(panel)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual([importHeading(), rolesHeading()]);

    // One read feeds the rows, and the read entry lives in the same group as
    // them — that is what lets the group stand without a detection half.
    const imports = await findGroup(importHeading());
    expect(within(imports).getByText("Codex")).not.toBeNull();
    expect(
      within(imports).getByRole("button", { name: t("settings.localAgents.refresh") }),
    ).not.toBeNull();

    // A row import sends its named request; the role save sends the settings
    // write — each group its own errand, on the same tab.
    await user.click(
      within(imports).getByRole("button", {
        name: t("settings.localAgents.importProviderLabel", { name: "Codex" }),
      }),
    );
    await waitFor(() =>
      expect(vi.mocked(importAgentSessions)).toHaveBeenCalledWith(["codex"], ""),
    );

    const roles = await findGroup(rolesHeading());
    await user.click(within(roles).getByRole("button", { name: t("settings.roles.add") }));
    await user.type(screen.getByLabelText(t("settings.roles.name", { index: 1 })), "Reviewer");
    await user.type(
      screen.getByLabelText(t("settings.roles.prompt", { index: 1 })),
      "Review this diff.",
    );
    await user.click(within(roles).getByRole("button", { name: t("settings.localAgents.save") }));
    await waitFor(() => expect(vi.mocked(updateSettings)).toHaveBeenCalledTimes(1));
    expect(JSON.parse(vi.mocked(updateSettings).mock.calls[0][0].agent_roles ?? "[]")).toHaveLength(
      1,
    );
    expect(vi.mocked(listAgentProviders)).toHaveBeenCalledTimes(1);
  });
});
