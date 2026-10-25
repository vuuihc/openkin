import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, MachineInfo } from "../api/client";

/**
 * The machine list is cached in module state and refreshed by whoever mounts a
 * consumer of it. That is right for a picker on a page and wrong for an import
 * that is about to name machines: a laptop paired a minute ago is not in a
 * snapshot taken at page load, and an import that misses it reports a count as
 * if the errand were complete. These tests are about that difference.
 */

const client = vi.hoisted(() => ({
  serverVersion: vi.fn(),
  listMachines: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, ...client };
});

const { refreshMachines, resetMachinesCache } = await import("./useMachines");

function machine(id: string, label: string): MachineInfo {
  return { id, label, reachability: "online", agents: [] };
}

beforeEach(() => {
  resetMachinesCache();
  client.serverVersion.mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" });
  client.listMachines.mockResolvedValue([]);
  client.listAgents.mockResolvedValue([] as AgentInfo[]);
});

afterEach(() => {
  vi.clearAllMocks();
  resetMachinesCache();
});

describe("refreshMachines", () => {
  it("reads the machines that exist now, not the ones that existed at page load", async () => {
    client.listMachines.mockResolvedValueOnce([machine("d-2", "laptop")]);
    const first = await refreshMachines();
    expect(first.map((entry) => entry.id)).toEqual(["desktop-hub", "d-2"]);

    // Someone pairs a second machine while the console is open. Nothing mounts
    // in between, which is the case the cache alone gets wrong.
    client.listMachines.mockResolvedValueOnce([machine("d-2", "laptop"), machine("d-3", "studio")]);
    const second = await refreshMachines();
    expect(second.map((entry) => entry.id)).toEqual(["desktop-hub", "d-2", "d-3"]);
    expect(client.listMachines).toHaveBeenCalledTimes(2);
  });

  it("still answers with this machine when the machine list cannot be read", async () => {
    // A console that cannot read the list is not a console that knows of no
    // machines: it is talking to one, and an import that asked nobody would
    // report zero sessions as a complete answer.
    client.listMachines.mockRejectedValue(new Error("offline"));
    const machines = await refreshMachines();
    expect(machines.map((entry) => entry.id)).toEqual(["desktop-hub"]);
  });

  it("keeps the machine list carrying the local agent registry", async () => {
    // The same read feeds the machine picker's view of what this machine can
    // run, so a refresh that dropped the registry would make this machine look
    // like one with no agents installed.
    client.listAgents.mockResolvedValue([
      { id: "claude-code", name: "Claude Code", installed: true, available: true },
    ] as AgentInfo[]);
    const machines = await refreshMachines();
    const here = machines.find((entry) => entry.isSelf);
    expect(here?.agents.map((agent) => agent.id)).toEqual(["claude-code"]);
  });
});
