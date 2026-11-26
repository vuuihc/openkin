// @vitest-environment jsdom
// R-settings-coarse-links — 2026-11-26 dogfood defect, entry 3 of the 18:00 walk:
// on an iPad in portrait (820×1180, coarse pointer) the two settings links that
// leave the page — Providers' 「管理 Agents →」 and Advanced's 「LiteLLM ↗」 —
// measured 16.5px tall. `sm:` is a width breakpoint (≥640), so it cancelled the
// `min-h-11` floor regardless of pointer type, and a fingertip landing 14px
// above or below the words hit nothing. Both links now name `.touch-floor`, the
// same class the `/new` cover chip uses: inside `(pointer: coarse) and
// (max-width: 1023.98px)` it floors the box at 44×44 and beats the trailing
// `sm:min-h-0` utility. A 1100 Mac with a mouse keeps the compact text row.
//
// This suite asserts the wiring only; the rendered 44px box and the 16.5px Mac
// row are the measured proof from the browser walk, not this jsdom test. The
// coarse arm itself (pointer, width band, 44×44) is already pinned by
// `src/design/tailwind.test.ts` and is deliberately not duplicated here.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, ProviderEntry, Settings } from "../api/client";
import { setLocale, t } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { resetMachinesCache } from "../hooks/useMachines";
import { useAppStore } from "../store/appStore";
import SettingsPage from "./SettingsPage";

const fixtures = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  providers: [] as ProviderEntry[],
  agents: [] as Array<Partial<AgentInfo> & { id: string; name: string }>,
}));

const baseSettings = {
  price_table: "{}",
  agent_limits: "{}",
  agent_roles: "[]",
  "agent.default": "",
  limit_policy: "ask",
  "limit_policy.fallback_agents": "[]",
  "provider.active_id": "",
} as unknown as Settings;

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
    updateSettings: vi.fn(async () => fixtures.settings as unknown as Settings),
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

vi.mock("../hooks/useMachines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useMachines")>();
  return {
    ...actual,
    useMachines: () => ({
      machines: [],
      agents: [],
      loading: false,
      failed: false,
      refresh: () => {},
    }),
    refreshMachines: vi.fn(async () => []),
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

/** Whole class tokens, never substrings: `sm:min-h-10` must not satisfy `min-h-10`. */
function classes(element: HTMLElement): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

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

async function openTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await screen.findByRole("tab", { name });
  await user.click(screen.getByRole("tab", { name }));
}

/** The Providers 「管理 Agents →」 link; rendered once an agent is unavailable. */
async function manageAgentsLink(): Promise<HTMLElement> {
  return screen.findByRole("link", { name: t("agents.manageLink") });
}

/** The Advanced 「LiteLLM ↗」 action link, not the prose link with the same label. */
function litellmActionLink(): HTMLElement {
  const link = document.querySelector<HTMLElement>(
    '#settings-panel-advanced a[href="https://github.com/BerriAI/litellm"]',
  );
  if (!link) throw new Error("the Advanced LiteLLM action link is not rendered");
  return link;
}

beforeEach(() => {
  resetLeaveGuard();
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setLocale("en");
  resetMachinesCache();
  fixtures.settings = { ...baseSettings } as unknown as Record<string, unknown>;
  fixtures.providers = [];
  // One installed-but-not-runnable agent: the Providers tab renders its
  // 「管理 Agents →」 link only when some agent is unavailable
  // (ProviderSettingsSection.tsx, `agentList.some((agent) => !agent.available)`).
  fixtures.agents = [
    { id: "claude-code", name: "Claude Code", available: false, reason: "verifying" },
  ];
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

describe("R-settings-coarse-links · the two links that leave settings", () => {
  it("R-settings-coarse-links: the Providers 管理 Agents link takes a 44px coarse hit area on the 820 tablet", async () => {
    const user = userEvent.setup();
    pageOnly();
    await openTab(user, t("settings.tabs.providers"));

    const link = await manageAgentsLink();
    const tokens = classes(link);

    // `min-height` does not apply to a non-replaced inline box, so the display
    // class carries the floor as much as `min-h-11` does. `sm:min-h-0` keeps
    // the Mac's compact row from 640px up; `touch-floor` is what opts back in
    // on a coarse pointer between 768 and 1023.98. The rendered 44px box is
    // the measured proof, not this test.
    expect(tokens).toContain("inline-flex");
    expect(tokens).toContain("min-h-11");
    expect(tokens).toContain("sm:min-h-0");
    expect(tokens).toContain("touch-floor");
  });

  it("R-settings-coarse-links: the Advanced LiteLLM link takes a 44px coarse hit area on the 820 tablet", async () => {
    const user = userEvent.setup();
    pageOnly();
    await openTab(user, t("settings.tabs.advanced"));

    const link = litellmActionLink();
    // Anchor the query to the named link, so this test cannot silently pass on
    // the prose link that carries the same label inside the price paragraph.
    expect(link.textContent).toContain(t("settings.price.sourceName"));
    expect(link.getAttribute("target")).toBe("_blank");

    const tokens = classes(link);
    expect(tokens).toContain("inline-flex");
    expect(tokens).toContain("min-h-11");
    expect(tokens).toContain("sm:min-h-0");
    expect(tokens).toContain("touch-floor");
  });

  it("R-settings-coarse-links: both links keep the Mac's compact density on a fine pointer", async () => {
    const user = userEvent.setup();
    pageOnly();
    await openTab(user, t("settings.tabs.providers"));
    const manage = await manageAgentsLink();
    await openTab(user, t("settings.tabs.advanced"));
    const litellm = litellmActionLink();

    // Removing `sm:min-h-0` instead of adding `touch-floor` would put 44px back
    // on the 1100 Mac; the compact row is carried by that utility, and the
    // coarse arm stays scoped to `.touch-floor`'s pointer query (pinned by
    // `src/design/tailwind.test.ts`).
    expect(classes(manage)).toContain("sm:min-h-0");
    expect(classes(litellm)).toContain("sm:min-h-0");
  });
});
