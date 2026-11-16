// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router-dom";
import AppShell from "./AppShell";
import Sheet from "../mobile/Sheet";
import SettingsPage from "../../pages/SettingsPage";
import { setLocale } from "../../i18n";
import { isLeaveGuardArmed, resetLeaveGuard, runGuardedNavigation } from "../../lib/leaveGuard";
import { useAppStore } from "../../store/appStore";
import type { Settings } from "../../api/client";

/**
 * Settings on a real browser history, where the mechanism lives.
 *
 * Three departures the in-app controls cannot see:
 *
 * - the OAuth callback cleans its query string by rewriting the current entry;
 *   it must not drop React Router's `idx` or the armed leave entry;
 * - a sidebar/palette trip to the screen you are already on must re-arm the
 *   entry, or the system Back after it leaves the edited form without asking;
 * - a sheet opened over a dirty page pushes its own entry, which must not be
 *   mistaken for the page's sentinel — and a shortcut must remove both before
 *   it navigates, not strand them under the new screen.
 */

const baseSettings = {
  "notify.quota_wait_after_secs": "900",
  "ui.base_url": "http://127.0.0.1:7777",
  "relay.url": "",
  price_table: "{}",
  agent_limits: "{}",
  agent_roles: "[]",
  "agent.default": "",
  limit_policy: "wait",
  "limit_policy.fallback_agents": "[]",
  "provider.active_id": "",
  "cloudflare.authenticated": "false",
} as unknown as Settings;

const fixtures = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
}));

vi.mock("../../api/useLiveResources", () => ({
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

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
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
      enabled: true,
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

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
}));

vi.mock("../../hooks/useMinWidth", () => ({
  useMinWidth: () => false,
}));

vi.mock("../../hooks/useAgentSessionImport", () => ({
  useAgentSessionImport: () => ({
    importing: false,
    importEveryMachine: vi.fn(async () => ({ imported: 0, providers: {} })),
  }),
  importsInFlight: () => false,
}));

vi.mock("../../lib/desktop", () => ({
  isKinDesktop: () => false,
}));

vi.mock("../terminal/TerminalPanel", () => ({
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

/** jsdom's history survives between tests in one file. Walk back to the first
 *  entry so each case gets the stack it declares, with nothing behind it. */
async function rewindHistory(): Promise<void> {
  for (let i = 0; i < 20 && (window.history.state?.idx ?? 0) > 0; i += 1) {
    const before = (window.history.state?.idx as number | undefined) ?? 0;
    act(() => window.history.back());
    await waitFor(() => expect(window.history.state?.idx ?? 0).toBeLessThan(before));
  }
  window.history.replaceState({ idx: 0 }, "", "/");
}

/** Seed a real stack: the first entry, then one push per later entry. */
function stack(...entries: Array<{ url: string; state?: Record<string, unknown> }>): void {
  window.history.replaceState({ idx: 0, ...entries[0]?.state }, "", entries[0]!.url);
  entries.slice(1).forEach((entry, index) => {
    window.history.pushState({ idx: index + 1, ...entry.state }, "", entry.url);
  });
}

async function browser(...entries: Array<{ url: string; state?: Record<string, unknown> }>) {
  await rewindHistory();
  stack(...entries);
  return render(
    <BrowserRouter>
      <AppShell pendingApprovals={[]}>
        <SheetProbe />
        <Routes>
          <Route path="/sessions" element={<div>chats page</div>} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/new" element={<div>draft page</div>} />
        </Routes>
      </AppShell>
    </BrowserRouter>,
  );
}

function SameRouteControl() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => runGuardedNavigation(() => navigate("/settings"))}>
        go to settings
      </button>
      <button
        type="button"
        onClick={() => runGuardedNavigation(() => navigate("/settings", { replace: true }))}
      >
        replace with settings
      </button>
    </>
  );
}

function SheetProbe() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open test sheet
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Test sheet">
        Test sheet body
      </Sheet>
    </>
  );
}

async function settingsOnly(...entries: Array<{ url: string; state?: Record<string, unknown> }>) {
  await rewindHistory();
  stack(...entries);
  return render(
    <BrowserRouter>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      <SameRouteControl />
    </BrowserRouter>,
  );
}

async function editRouting(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("tablist");
  await user.click(screen.getByRole("tab", { name: "Routing" }));
  await user.click(screen.getByRole("checkbox", { name: /Enable auto routing/ }));
}

beforeEach(() => {
  resetLeaveGuard();
  vi.restoreAllMocks();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  fixtures.settings = { ...baseSettings } as unknown as Record<string, string>;
  useAppStore.setState({
    reconnectGen: 0,
    account: {
      enabled: true,
      authenticated: true,
      needsBootstrap: false,
      claimable: false,
      providers: [],
      identities: [],
      linked: [],
      email: "owner@example.com",
      displayName: "Owner",
    },
  });
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

describe("the OAuth callback's cleanup", () => {
  it("keeps React Router's stack and arms Back after the query is consumed", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    await browser(
      { url: "/sessions" },
      { url: "/settings?auth_notice=linked", state: { usr: { scenario: "oauth" } } },
    );
    await screen.findByRole("tablist");

    // The callback consumed its parameters…
    await waitFor(() => expect(window.location.search).toBe(""));
    // …without dropping the entry's router state: the system Back still has a
    // stack to protect and an entry to arm.
    expect(window.history.state.idx).toBe(1);
    expect(window.history.state.usr).toEqual({ scenario: "oauth" });

    await editRouting(user);
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));

    act(() => window.history.back());
    await waitFor(() => expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?"));
    expect(window.location.pathname).toBe("/settings");
  });
});

describe("navigating to the screen you are already on", () => {
  it("re-arms the leave entry and asks again on the next system Back", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    await settingsOnly({ url: "/sessions" }, { url: "/settings" });
    await editRouting(user);

    await user.click(screen.getByRole("button", { name: "go to settings" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/settings");

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "go to settings" }));
    expect(window.location.pathname).toBe("/settings");
    // The allowed departure's pop is asynchronous: the draft survives either
    // way, but the panel may have followed the URL back to General and hidden
    // the Routing panel by now, so the query must not require visibility.
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Enable auto routing/,
          hidden: true,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);

    // The same-address navigation released the entry; the next Back must ask
    // again, and so must the one after that, until there is a different screen
    // to land on.
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));
    const asked = confirm.mock.calls.length;
    act(() => window.history.back());
    await waitFor(() => expect(confirm.mock.calls.length).toBe(asked + 1));
    expect(window.location.pathname).toBe("/settings");
    // The allowed pop is asynchronous: press Back again only once the entry is
    // re-armed, or the second press arrives mid-departure.
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));

    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(confirm.mock.calls.length).toBe(asked + 2);
  });

  it("re-arms after a same-pathname push with a different query", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    await settingsOnly({ url: "/sessions" }, { url: "/settings?tab=remote" });
    await screen.findByRole("tablist");

    await editRouting(user);
    confirm.mockReturnValue(true);

    await user.click(screen.getByRole("button", { name: "go to settings" }));
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("");

    // Same route, so the page never unmounted. The panel follows the URL now
    // (General), and the Routing draft is still mounted in its hidden panel.
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Enable auto routing/,
          hidden: true,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);

    // The entry that protected the draft was buried by the push; Back must
    // still find a question to ask.
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));
    confirm.mockReturnValue(false);
    const asked = confirm.mock.calls.length;
    act(() => window.history.back());
    await waitFor(() => expect(confirm.mock.calls.length).toBe(asked + 1));
    expect(window.location.pathname).toBe("/settings");
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Enable auto routing/,
          hidden: true,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it("re-arms after a same-pathname replace with a different query", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    await settingsOnly({ url: "/sessions" }, { url: "/settings?tab=remote" });
    await screen.findByRole("tablist");

    await editRouting(user);
    confirm.mockReturnValue(true);

    await user.click(screen.getByRole("button", { name: "replace with settings" }));
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("");
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Enable auto routing/,
          hidden: true,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);

    // The rewrite dropped the sentinel's marker; a system Back must still ask
    // rather than leave the edited form.
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));
    confirm.mockReturnValue(false);
    const asked = confirm.mock.calls.length;
    act(() => window.history.back());
    await waitFor(() => expect(confirm.mock.calls.length).toBe(asked + 1));
    expect(window.location.pathname).toBe("/settings");
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Enable auto routing/,
          hidden: true,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });
});

describe("a sheet over a dirty page", () => {
  it("does not adopt the sheet's history marker as the page's sentinel", async () => {
    const user = userEvent.setup();
    const confirm = vi.mocked(window.confirm);
    await browser({ url: "/sessions" }, { url: "/settings" });
    await screen.findByRole("tablist");
    await editRouting(user);
    await waitFor(() => expect(isLeaveGuardArmed()).toBe(true));

    await user.click(screen.getByRole("button", { name: "Open test sheet" }));

    await waitFor(() => expect(document.querySelector("[data-kin-sheet]")).toBeTruthy());
    expect(window.history.state.kinSheet).toBeTruthy();
    // The sheet copied the entry below it. Copying the page's sentinel too
    // would make this entry look like the sentinel, and a shortcut would pop
    // the sheet while leaving the sentinel stranded under the new screen.
    expect(window.history.state.kinLeaveGuard).toBeUndefined();

    confirm.mockReturnValue(true);
    fireEvent.keyDown(window, { key: "n", metaKey: true });

    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    expect(window.history.state.kinLeaveGuard).toBeUndefined();
    expect(window.history.state.kinSheet).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(1);

    // Back from the list reaches the list's own predecessor, not a stranded
    // Settings entry the sheet used to sit on.
    act(() => window.history.back());
    await waitFor(() => expect(window.history.state.idx).toBe(0));
    expect(window.location.pathname).toBe("/sessions");
  });
});
