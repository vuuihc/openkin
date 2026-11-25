// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProvider,
  getSettings,
  updateSettings,
  type ProviderEntry,
  type Settings,
} from "../api/client";
import AppShell from "../components/layout/AppShell";
import { setLocale } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { useAppStore } from "../store/appStore";
import SettingsPage from "./SettingsPage";

/**
 * Settings has several forms that persist only through explicit Save actions.
 * Settings is a peer root (KIN-CONTINUE-002), so its bottom tabs and blank
 * tab swipes ask rather than quietly unmount those drafts.
 *
 * KIN-CONTINUE-003 row 14: leaving or reshaping Settings asks before dropping a
 * draft, and a section keeps its fields on return.
 *
 * KIN-CONTRACT-001 row 4: the `agents` tab keeps its import action and its
 * roles editor, mounted through the real page rather than the section alone.
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
  importEveryMachine: vi.fn(async () => ({ imported: 0, providers: {} })),
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
  refreshMachines: vi.fn(async () => []),
}));

vi.mock("../hooks/useMinWidth", () => ({
  useMinWidth: () => false,
}));

vi.mock("../hooks/useAgentSessionImport", () => ({
  useAgentSessionImport: () => ({
    importing: false,
    importEveryMachine: fixtures.importEveryMachine,
  }),
  importsInFlight: () => false,
}));

vi.mock("../lib/desktop", () => ({
  isKinDesktop: () => false,
}));

vi.mock("../components/terminal/TerminalPanel", () => ({
  default: () => null,
}));

function viewport() {
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
}

function shell(settingsURL = "/settings") {
  window.history.replaceState({}, "", settingsURL);
  return render(
    <MemoryRouter initialEntries={["/sessions", settingsURL]}>
      <AppShell pendingApprovals={[]}>
        <Routes>
          <Route path="/sessions" element={<div>chats page</div>} />
          <Route path="/agents" element={<div>agents page</div>} />
          <Route path="/routines" element={<div>routines page</div>} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </AppShell>
    </MemoryRouter>,
  );
}

function expectOnSettings() {
  expect(screen.getAllByRole("heading", { name: "Settings" })).not.toHaveLength(0);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function provider(id: string, name: string): ProviderEntry {
  return {
    id,
    name,
    kind: "openai-compatible",
    base_url: "https://api.example.com/v1",
    model: "model-a",
    stream: false,
    active: true,
  } as ProviderEntry;
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
  fixtures.importEveryMachine.mockClear();
  useAppStore.setState({ reconnectGen: 0 });
  viewport();
  vi.spyOn(window, "confirm").mockReturnValue(false);
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

describe("settings forms ask before a phone departure", () => {
  it("keeps the vertical root from cancelling the shell's horizontal tab gesture", () => {
    shell();
    expect(document.querySelector("main > .overflow-y-auto")?.className).toContain(
      "overflow-x-hidden",
    );
  });

  it("asks on every root departure for Advanced, then Save releases it", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    shell("/settings?tab=advanced");

    const price = (await screen.findAllByDisplayValue("{}"))[0];
    fireEvent.change(price, { target: { value: '{"model":{"in":1}}' } });

    await user.click(screen.getByRole("link", { name: "Routines" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
    expectOnSettings();
    // The tab bar is the only way between areas on a phone; the guard answers
    // the tap just as it answered the old sideways drag.
    await user.click(screen.getByRole("link", { name: "Agent Ops" }));
    expect(confirm).toHaveBeenCalledTimes(2);

    const section = price.closest("section") as HTMLElement;
    await user.click(within(section).getByRole("button", { name: "Save price table" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((price as HTMLTextAreaElement).value).toBe(
        JSON.stringify({ model: { in: 1 } }, null, 2),
      ),
    );

    await user.click(screen.getByRole("link", { name: "Chats" }));
    await waitFor(() => expect(screen.getByText("chats page")).toBeTruthy());
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("asks before discarding an opened provider form", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    shell("/settings?tab=providers");

    await user.click(await screen.findByRole("button", { name: "Add provider" }));
    await user.type(screen.getByPlaceholderText(/OpenAI · Ollama/), "Local");
    await user.click(screen.getByRole("link", { name: "Chats" }));

    expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
    expectOnSettings();
    expect(screen.getByDisplayValue("Local")).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "Routines" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
  });

  it("keeps a provider edit made while its save request is out", async () => {
    const user = userEvent.setup();
    const created = deferred<{ active_id: string; providers: ProviderEntry[] }>();
    vi.mocked(createProvider).mockReturnValueOnce(created.promise);
    shell("/settings?tab=providers");

    await user.click(await screen.findByRole("button", { name: "Add provider" }));
    await user.type(screen.getByPlaceholderText(/OpenAI · Ollama/), "Local");
    await user.type(screen.getByPlaceholderText(/api\.openai\.com/), "https://api.example.com/v1");
    await user.type(screen.getByPlaceholderText(/gpt-4\.1-mini/), "model-a");
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));

    const model = screen.getByPlaceholderText(/gpt-4\.1-mini/);
    await user.clear(model);
    await user.type(model, "model-b");

    await act(async () => {
      const saved = provider("provider-1", "Local");
      fixtures.providers = [saved];
      created.resolve({ active_id: saved.id, providers: [saved] });
      await created.promise;
    });

    expect((screen.getByPlaceholderText(/gpt-4\.1-mini/) as HTMLInputElement).value).toBe(
      "model-b",
    );
    fireEvent.click(screen.getByRole("link", { name: "Chats" }));
    expect(window.confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
    expectOnSettings();
  });

  it("treats a half-written role row as a draft", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    shell("/settings?tab=agents");

    await user.click(await screen.findByRole("button", { name: "Add role" }));
    await user.type(screen.getByLabelText("Role 1 name"), "Reviewer");
    await user.click(screen.getByRole("link", { name: "Chats" }));

    expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
    expectOnSettings();
    expect(screen.getByDisplayValue("Reviewer")).toBeTruthy();
  });

  it("keeps edited fields across a reconnect and fills untouched fields", async () => {
    shell("/settings?tab=advanced");

    const price = (await screen.findAllByDisplayValue("{}"))[0];
    fireEvent.change(price, { target: { value: '{"mine":true}' } });

    fixtures.settings = {
      ...fixtures.settings,
      price_table: '{"server":true}',
      agent_limits: '{"server":true}',
    };
    act(() => useAppStore.setState({ reconnectGen: 1 }));

    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByDisplayValue('{"mine":true}')).toBeTruthy();
    const values = screen
      .getAllByRole("textbox")
      .map((element) => (element as HTMLTextAreaElement | HTMLInputElement).value);
    expect(values).toContain('{\n  "server": true\n}');

    fireEvent.click(screen.getByRole("link", { name: "Chats" }));
    expect(window.confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
  });

  it("asks for an unsaved Routing change and leaves manual import as the only import action", async () => {
    const user = userEvent.setup();
    shell("/settings?tab=routing");

    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("link", { name: "Chats" }));
    expect(window.confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
    expectOnSettings();
    expect(fixtures.importEveryMachine).not.toHaveBeenCalled();
  });
});

describe("the agents tab keeps the capabilities that live only there", () => {
  // KIN-CONTRACT-001 row 4: retiring the tab would delete two capabilities
  // nothing else offers — importing provider sessions and the roles editor —
  // so both are asserted through the real page at the tab's own URL.
  it("keeps the import-sessions action inside the agents tab", async () => {
    shell("/settings?tab=agents");

    expect(await screen.findByRole("button", { name: "Import sessions now" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Add role" })).toBeTruthy();
  });

  it("does not offer the agents tab's import action from another tab", async () => {
    shell("/settings?tab=general");

    // The anchor first: a null below must mean "another tab", never "the page
    // never mounted".
    expect((await screen.findAllByRole("heading", { name: "Settings" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Import sessions now" })).toBeNull();
  });
});
