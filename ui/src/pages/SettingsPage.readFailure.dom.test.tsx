// @vitest-environment jsdom
// KIN-SETTINGS-001 — 设置第一步「慢 / 空 / 失败 / 断线」。
// 本套件持有的验收行：
//   1. 首次读取失败 → 有名字的失败态（标题 + 说明 + 重试），不渲染 tab / 表单 /
//      Save，原始错误只作为次要细节；
//   2. 重试 → 回到骨架，成功后正常渲染表单；重试期间没有第二个可点的重试；
//   3. 表单已读到之后重载失败 → 保留已加载的值与草稿，顶部一行「已断线」，
//      不把原生错误当横幅正文；下一次成功重载清掉它。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getSettings, type ProviderEntry, type Settings } from "../api/client";
import { setLocale } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { useAppStore } from "../store/appStore";
import SettingsPage from "./SettingsPage";

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
    getSettings: vi.fn(),
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
  refreshMachines: vi.fn(async () => []),
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
  vi.mocked(getSettings).mockReset();
  vi.mocked(getSettings).mockResolvedValue(baseSettings);
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

describe("reading settings when the daemon or link is not there", () => {
  it("shows a named failure and a retry instead of the form when the first read fails", async () => {
    vi.mocked(getSettings).mockRejectedValueOnce(new ApiError(500, "provider registry unreadable"));
    pageOnly();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't read settings");
    expect(alert.textContent).toContain("Your saved settings were not changed");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save price table" })).toBeNull();

    // The daemon's own text is a secondary detail, never the whole message.
    expect(screen.getByText(/provider registry unreadable/)).toBeTruthy();
    expect(alert.textContent?.trim()).not.toBe("provider registry unreadable");
  });

  it("retries the read from the failure state and renders the form on success", async () => {
    const user = userEvent.setup();
    vi.mocked(getSettings).mockRejectedValueOnce(new ApiError(500, "provider registry unreadable"));
    pageOnly();

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("tab", { name: "General" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(2);
  });

  it("shows the loading state, not a second retry, while the retry is in flight", async () => {
    const user = userEvent.setup();
    let resolveRead!: (value: Settings) => void;
    const pending = new Promise<Settings>((resolve) => {
      resolveRead = resolve;
    });
    vi.mocked(getSettings)
      .mockRejectedValueOnce(new ApiError(500, "provider registry unreadable"))
      .mockReturnValueOnce(pending);
    pageOnly();

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRead(baseSettings);
    });
    expect(await screen.findByRole("tab", { name: "General" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("returns to the same failure state when the retry fails too", async () => {
    const user = userEvent.setup();
    vi.mocked(getSettings)
      .mockRejectedValueOnce(new ApiError(500, "provider registry unreadable"))
      .mockRejectedValueOnce(new ApiError(500, "still unreadable"));
    pageOnly();

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("still unreadable"),
    );
    expect(screen.getByRole("alert").textContent).toContain("Couldn't read settings");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(2);
  });

  it("leaves a 401 to the auth layer and shows no read failure", async () => {
    vi.mocked(getSettings).mockRejectedValueOnce(new ApiError(401, "unauthorized"));
    pageOnly();

    await waitFor(() => expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("drops a stale first read that fails after a newer read has landed", async () => {
    let rejectFirst!: (reason: unknown) => void;
    const first = new Promise<Settings>((_, reject) => {
      rejectFirst = reject;
    });
    vi.mocked(getSettings).mockReturnValueOnce(first).mockResolvedValueOnce(baseSettings);
    pageOnly();

    // Two reads are in flight: the mount read and the reconnect read.
    act(() => useAppStore.setState({ reconnectGen: 1 }));
    expect(await screen.findByRole("tab", { name: "General" })).toBeTruthy();

    // The older read answers last. It must not paint a failure over the form.
    await act(async () => {
      rejectFirst(new Error("late failure"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("tab", { name: "General" })).toBeTruthy();
  });

  it("does not re-read on mount for a reconnect that happened before the page opened", async () => {
    useAppStore.setState({ reconnectGen: 3 });
    pageOnly();

    expect(await screen.findByRole("tab", { name: "General" })).toBeTruthy();
    expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the loaded values and says it is disconnected when a reload fails", async () => {
    pageOnly("/settings?tab=advanced");

    const price = (await screen.findAllByDisplayValue("{}"))[0] as HTMLTextAreaElement;
    fireEvent.change(price, { target: { value: '{"mine":true}' } });

    vi.mocked(getSettings).mockRejectedValueOnce(new Error("socket closed"));
    act(() => useAppStore.setState({ reconnectGen: 1 }));

    await waitFor(() => expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(2));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Disconnected — showing the last values");
    // The raw failure is not the banner's body.
    expect(alert.textContent).not.toContain("socket closed");

    // The form and the draft are still there; nothing fell back to a skeleton.
    expect(screen.getByRole("tab", { name: "General" })).toBeTruthy();
    expect(screen.getByDisplayValue('{"mine":true}')).toBeTruthy();

    act(() => useAppStore.setState({ reconnectGen: 2 }));
    await waitFor(() => expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("tab", { name: "General" })).toBeTruthy();
  });
});
