// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import AgentsPage from "./AgentOperationsSection";
import { setLocale } from "../../i18n";
import { importAgentSessions, listAgents, type AgentSessionImportResult } from "../../api/client";
import { refreshMachines } from "../../hooks/useMachines";

/**
 * KIN-AGENTS-001: Agent Ops is where a person imports Agent history.
 *
 * The manual entry was only in Settings, while the signed KIN-CONTINUE-002
 * flow walks through Agent Ops. These tests drive the real page and the real
 * import hook: one click is one fan-out, the list re-reads, and nothing on the
 * page imports by itself.
 */

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    isAuthenticated: vi.fn(() => true),
    getUsageSummary: vi.fn(async () => []),
    getUsageLimits: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    listAgentManagement: vi.fn(async () => []),
    importAgentSessions: vi.fn(),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  refreshMachines: vi.fn(),
}));

const here = {
  id: "desktop-hub",
  label: "hub",
  isSelf: true,
  online: true,
  roots: [],
  agents: [],
};

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  vi.mocked(refreshMachines).mockReset().mockResolvedValue([here]);
  vi.mocked(listAgents).mockReset().mockResolvedValue([]);
  vi.mocked(importAgentSessions)
    .mockReset()
    .mockResolvedValue({ imported: 2, providers: { codex: 2 } });
});

function page() {
  return render(
    <MemoryRouter>
      <AgentsPage />
    </MemoryRouter>,
  );
}

describe("manual import on Agent Ops", () => {
  it("imports exactly once when the person asks, and refreshes the list", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    window.addEventListener("kin:agent-sessions-changed", changed);
    try {
      page();
      const button = await screen.findByRole("button", { name: "Import sessions" });
      const readsBefore = vi.mocked(listAgents).mock.calls.length;

      await user.click(button);

      expect(vi.mocked(importAgentSessions)).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(vi.mocked(listAgents).mock.calls.length).toBeGreaterThan(readsBefore),
      );
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("kin:agent-sessions-changed", changed);
    }
  });

  it("keeps its name and reports busy while the fan-out runs", async () => {
    const user = userEvent.setup();
    let resolveImport: ((value: AgentSessionImportResult) => void) | null = null;
    vi.mocked(importAgentSessions).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    );
    page();
    await user.click(await screen.findByRole("button", { name: "Import sessions" }));

    // TASTE 18: the button keeps the action's name while it works; the busy
    // state is `aria-busy`, not a label swapped to "Loading…".
    await waitFor(() => {
      const busy = screen.getByRole("button", { name: "Import sessions" });
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      expect(busy.getAttribute("aria-busy")).toBe("true");
    });

    await act(async () => {
      resolveImport?.({ imported: 0, providers: {} });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import sessions" })).toBeTruthy(),
    );
  });

  it("says so when the machine list cannot be read, instead of pretending it imported", async () => {
    const user = userEvent.setup();
    vi.mocked(refreshMachines).mockRejectedValue(new Error("hub offline"));
    page();
    await user.click(await screen.findByRole("button", { name: "Import sessions" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Failed to import Agent sessions");
    expect(alert.textContent).toContain("hub offline");
    expect(vi.mocked(importAgentSessions)).not.toHaveBeenCalled();
  });

  it("does not import on its own while the page sits open", async () => {
    vi.useFakeTimers();
    try {
      page();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(vi.mocked(importAgentSessions)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
