// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppShell from "./AppShell";
import { setLocale } from "../../i18n";
import { getSettings, importAgentSessions, listAgents, type Settings } from "../../api/client";
import { refreshMachines } from "../../hooks/useMachines";
import { useAppStore } from "../../store/appStore";

/**
 * KIN-AGENTS-001 at the shell, with the real catalog and import hooks.
 *
 * A hook test can show that `useAgentCatalog` has no timer; it cannot show
 * that the shell that renders it does not import. This mounts the real
 * `AppShell`, with the legacy `enabled` value still in settings, and watches
 * the network: nothing on mount, nothing on a clock, one fan-out on the real
 * manual control.
 */

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
    listAgentSessionsPage: vi.fn(async () => ({ items: [], next_cursor: undefined })),
    listProjects: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "project-1", name: "alpha" })),
    getSettings: vi.fn(),
    getUsageSummary: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    importAgentSessions: vi.fn(async () => ({ imported: 1, providers: { codex: 1 } })),
    serverVersion: vi.fn().mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" }),
    listMachines: vi.fn().mockResolvedValue([]),
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
  refreshMachines: vi.fn(),
}));

vi.mock("../../hooks/useMinWidth", () => ({ useMinWidth: () => true }));
vi.mock("../../hooks/useApprovalDecision", () => ({
  useApprovalDecision: () => ({ busy: {}, decide: vi.fn() }),
}));
vi.mock("../../lib/desktop", () => ({ isKinDesktop: () => false }));
vi.mock("../terminal/TerminalPanel", () => ({ default: () => null }));

const legacyEnabled = {
  "agent_sessions.auto_import_mode": "enabled",
} as unknown as Settings;

const here = {
  id: "mac-1",
  label: "MacBook",
  isSelf: true,
  online: true,
  roots: [],
  agents: [],
};

function viewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width: 768px"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function shell() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <AppShell pendingApprovals={[]}>
        <Routes>
          <Route path="/sessions" element={<div>list page</div>} />
          <Route path="*" element={<div>other page</div>} />
        </Routes>
      </AppShell>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("en");
  useAppStore.getState().setWSStatus("connected");
  localStorage.clear();
  viewport();
  vi.mocked(refreshMachines).mockReset().mockResolvedValue([here]);
  vi.mocked(listAgents).mockReset().mockResolvedValue([]);
  vi.mocked(importAgentSessions)
    .mockReset()
    .mockResolvedValue({
      imported: 1,
      providers: { codex: 1 },
    });
  vi.mocked(getSettings).mockReset().mockResolvedValue(legacyEnabled);
});

describe("the shell and automatic Agent-session import", () => {
  it("never imports on startup or on a clock, even with the legacy enabled setting", async () => {
    vi.useFakeTimers();
    try {
      shell();
      await act(async () => {
        await Promise.resolve();
      });
      expect(vi.mocked(listAgents)).toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(vi.mocked(importAgentSessions)).not.toHaveBeenCalled();
      expect(vi.mocked(getSettings)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("imports once when the person uses the sidebar's import control", async () => {
    const user = userEvent.setup();
    shell();
    await screen.findByText("list page");

    await user.click(screen.getByRole("button", { name: "Import Agent sessions" }));
    await user.click(screen.getByRole("button", { name: "Import all available Agents" }));

    await waitFor(() => expect(vi.mocked(importAgentSessions)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(importAgentSessions)).toHaveBeenCalledWith(undefined, "");
  });
});
