// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppShell from "../components/layout/AppShell";
import SettingsPage from "./SettingsPage";
import { setLocale } from "../i18n";
import { resetLeaveGuard } from "../lib/leaveGuard";
import { useAppStore } from "../store/appStore";
import { updateSettings, type Settings } from "../api/client";

/**
 * Settings is a page of forms that only persist on an explicit Save. On a
 * phone, the header's Back and the edge swipe are a thumb away from a
 * half-typed provider, routing profile or notification URL, and the shell
 * unmounts the page on the way out. These tests mount the real page in the
 * real shell at phone width and pin that every unsaved form asks first — and
 * that saving or cancelling stops the question.
 */

const baseSettings = {
  "notify.quota_wait_after_secs": "900",
  "ui.base_url": "http://127.0.0.1:7777",
  "relay.url": "",
  price_table: "{}",
  agent_limits: "{}",
  "agent_roles": "[]",
  "agent.default": "",
  limit_policy: "wait",
  "limit_policy.fallback_agents": "[]",
  "provider.active_id": "",
  "cloudflare.authenticated": "false",
} as unknown as Settings;

const fixtures = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
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
    listProviders: vi.fn(async () => ({ active_id: "", providers: [] })),
    listAgents: vi.fn(async () => []),
    listAgentProviders: vi.fn(async () => []),
    listPushDevices: vi.fn(async () => ({ devices: [], apns_configured: false })),
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
    listAgentSessionsPage: vi.fn(async () => ({ items: [], next_cursor: undefined })),
    listProjects: vi.fn(async () => []),
    listMachines: vi.fn(async () => []),
    isAuthenticated: vi.fn(() => true),
    serverVersion: vi.fn().mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" }),
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

function pointer(node: Element, type: string, clientX: number) {
  fireEvent(
    node,
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: 20,
      button: 0,
    }),
  );
}

function edgeBack(): void {
  const edge = document.querySelector("[data-kin-edge-back]");
  expect(edge).toBeTruthy();
  pointer(edge as Element, "pointerdown", 5);
  pointer(edge as Element, "pointermove", 90);
  pointer(edge as Element, "pointerup", 90);
}

function shell() {
  return render(
    <MemoryRouter initialEntries={["/sessions", "/settings"]}>
      <AppShell pendingApprovals={[]}>
        <Routes>
          <Route path="/sessions" element={<div>chats page</div>} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </AppShell>
    </MemoryRouter>,
  );
}

async function openTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await screen.findByRole("tablist");
  await user.click(await screen.findByRole("tab", { name }));
}

function expectOnSettings() {
  // The shell's header and the page body both name the screen.
  expect(screen.getAllByRole("heading", { name: "Settings" })).not.toHaveLength(0);
}

beforeEach(() => {
  resetLeaveGuard();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  fixtures.settings = { ...baseSettings } as unknown as Record<string, string>;
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

describe("settings forms ask before a phone departure", () => {
  it("asks on the header Back and the edge swipe for an unsaved notification URL, and Save releases it", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    shell();
    await openTab(user, "Notifications");

    const input = screen.getByRole("textbox", { name: /UI base URL/ });
    await user.type(input, "/x");

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
    expectOnSettings();

    edgeBack();
    expect(confirm).toHaveBeenCalledTimes(2);
    expectOnSettings();

    const section = input.closest("section") as HTMLElement;
    await user.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());

    confirm.mockClear();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByText("chats page")).toBeTruthy());
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps an unrelated unsaved field dirty when the relay URL is saved", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    // No base URL to navigate to: this test is about the draft, not the
    // relay's post-save redirect.
    fixtures.settings = { ...fixtures.settings, "ui.base_url": "" };
    shell();
    await openTab(user, "Notifications");
    await user.type(screen.getByRole("textbox", { name: /UI base URL/ }), "http://phone.test:7777");

    // Saving one form on this page must not clear another form's draft: the
    // relay save writes only `relay.url`, and the leave guard must still ask
    // for the base URL that no request carried. A baseline rebased from the
    // draft (rather than from the saved snapshot) would call it clean.
    await openTab(user, "Remote");
    const relay = screen.getByRole("textbox", { name: /Relay Worker URL/ });
    await user.type(relay, "https://relay.example.test");
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() =>
      expect(vi.mocked(updateSettings)).toHaveBeenCalledWith({
        "relay.url": "https://relay.example.test",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
    expectOnSettings();
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByText("chats page")).toBeTruthy());
  });

  it("asks for an unsaved provider and stops asking after Cancel", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    shell();
    await openTab(user, "Providers");

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    await user.type(screen.getByRole("textbox", { name: /Base URL/ }), "https://example.test/v1");

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
    expectOnSettings();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    confirm.mockClear();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByText("chats page")).toBeTruthy());
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks for an unsaved routing profile and stops asking after Cancel", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    shell();
    await openTab(user, "Routing");

    await user.click(screen.getByRole("button", { name: "Add profile" }));
    await user.type(screen.getByRole("textbox", { name: "Profile name" }), "studio");

    edgeBack();
    expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
    expectOnSettings();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    confirm.mockClear();
    edgeBack();
    await waitFor(() => expect(screen.getByText("chats page")).toBeTruthy());
    expect(confirm).not.toHaveBeenCalled();
  });
});
