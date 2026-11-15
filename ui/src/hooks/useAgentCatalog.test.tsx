// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  getSettings,
  importAgentSessions,
  listAgents,
  type AgentInfo,
  type AgentSessionImportResult,
  type Settings,
} from "../api/client";
import { useAppStore } from "../store/appStore";
import { refreshMachines } from "./useMachines";
import { useAgentCatalog } from "./useAgentCatalog";
import { useAgentSessionImport } from "./useAgentSessionImport";
import type { Machine } from "../lib/devices";

/**
 * KIN-AGENTS-001: a provider's history sessions only enter Kin when a person
 * imports them.
 *
 * The violation this guards against is temporal, so it cannot be read from the
 * component tree: the shell used to mount, read
 * `agent_sessions.auto_import_mode`, and start a fan-out on startup and every
 * 30 seconds when the stored value was `enabled`. The assertions below are
 * about what is *not* called, at both moments, with that legacy value still in
 * the store — plus the positive half: a manual import still asks the machines
 * and refreshes the catalog it was offered from.
 */

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    listAgents: vi.fn(),
    importAgentSessions: vi.fn(),
    getSettings: vi.fn(),
  };
});

// The machine list is a network read that has nothing to do with the rule
// under test; what matters is which machine an explicit import asks.
vi.mock("./useMachines", () => ({ refreshMachines: vi.fn() }));

const here: Machine = {
  id: "desktop-hub",
  label: "hub",
  isSelf: true,
  online: true,
  roots: [],
  agents: [],
};

const catalog = [
  { id: "codex", name: "Codex", installed: true, available: true },
] as unknown as AgentInfo[];

/** The value an older console left behind. It must not start anything. */
const legacyEnabled = {
  "agent_sessions.auto_import_mode": "enabled",
} as unknown as Settings;

const imported = (count: number): AgentSessionImportResult => ({
  imported: count,
  providers: count > 0 ? { codex: count } : {},
});

beforeEach(() => {
  useAppStore.getState().setWSStatus("connected");
  vi.mocked(refreshMachines).mockReset().mockResolvedValue([here]);
  vi.mocked(listAgents).mockReset().mockResolvedValue(catalog);
  vi.mocked(importAgentSessions).mockReset().mockResolvedValue(imported(1));
  vi.mocked(getSettings).mockReset().mockResolvedValue(legacyEnabled);
});

describe("the agent catalog and automatic import", () => {
  it("does not import on startup or on a 30-second tick, even with the legacy enabled setting", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAgentCatalog());
      // Let the mount read of `listAgents` settle.
      await act(async () => {
        await Promise.resolve();
      });
      expect(vi.mocked(listAgents)).toHaveBeenCalled();

      // Two minutes of clock: four of the old ticks.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(vi.mocked(importAgentSessions)).not.toHaveBeenCalled();
      // The old tick existed to read this setting; nothing reads it now.
      expect(vi.mocked(getSettings)).not.toHaveBeenCalled();
      expect(result.current.catalog).toEqual(catalog);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still imports when a person asks, and refreshes the catalog afterwards", async () => {
    const { result } = renderHook(() => ({
      catalog: useAgentCatalog(),
      importer: useAgentSessionImport(),
    }));
    await waitFor(() => expect(result.current.catalog.catalog).toEqual(catalog));
    const readsBefore = vi.mocked(listAgents).mock.calls.length;

    let answer: AgentSessionImportResult | undefined;
    await act(async () => {
      answer = await result.current.importer.importEveryMachine();
    });

    expect(answer?.imported).toBe(1);
    expect(vi.mocked(importAgentSessions)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getSettings)).not.toHaveBeenCalled();

    // The surfaces publish `changed` after a manual import; the catalog is
    // re-read then, not on a timer.
    act(() => {
      window.dispatchEvent(new CustomEvent("kin:agent-sessions-changed"));
    });
    await waitFor(() => expect(vi.mocked(listAgents).mock.calls.length).toBe(readsBefore + 1));
  });

  it("keeps the catalog it already showed when a refresh fails", async () => {
    const { result } = renderHook(() => useAgentCatalog());
    await waitFor(() => expect(result.current.catalog).toEqual(catalog));

    vi.mocked(listAgents).mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.catalog).toEqual(catalog);
  });
});
