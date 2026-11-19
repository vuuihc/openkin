import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../api/client";
import {
  agentCatalogState,
  catalogProducts,
  CATALOG_LIMIT,
  discoveredStatus,
  isNativeAgent,
  planAgentCatalog,
  runnableAgents,
  seedCatalogFamilies,
  sortAgentCatalog,
} from "./agentCatalog";

function agent(partial: Partial<AgentInfo> & Pick<AgentInfo, "id" | "name">): AgentInfo {
  return {
    installed: false,
    available: false,
    default: false,
    model_list_source: "none",
    model_list_status: "unavailable",
    ...partial,
  };
}

describe("agentCatalogState (KIN-AGENTS-001)", () => {
  it("classifies native available agents", () => {
    const a = agent({
      id: "claude-code",
      name: "Claude Code",
      available: true,
      installed: true,
      capabilities: ["run", "approvals", "tools"],
    });
    expect(isNativeAgent(a)).toBe(true);
    expect(agentCatalogState(a)).toBe("native");
  });

  it("classifies generic available agents", () => {
    const a = agent({
      id: "gemini-cli",
      name: "Gemini CLI",
      available: true,
      installed: true,
      kind: "cli",
      capabilities: ["run"],
    });
    expect(agentCatalogState(a)).toBe("generic");
  });

  it("classifies verifying agents", () => {
    const a = agent({
      id: "pi",
      name: "Pi",
      installed: true,
      available: false,
      reason: "detected; awaiting Kin maintainer smoke test before enabling",
    });
    expect(agentCatalogState(a)).toBe("verifying");
  });

  it("classifies not installed", () => {
    const a = agent({
      id: "cursor",
      name: "Cursor",
      installed: false,
      available: false,
      install_url: "https://cursor.com",
    });
    expect(agentCatalogState(a)).toBe("not_installed");
  });
});

describe("discoveredStatus", () => {
  it("calls a runnable product not in the catalog, not disconnected", () => {
    // The machine can run it right now; the only thing missing is a person's
    // decision to put it in the ten-slot catalog.
    expect(
      discoveredStatus(
        agent({ id: "claude-code", name: "Claude Code", installed: true, available: true }),
      ),
    ).toBe("notInCatalog");
  });

  it("calls a product the machine cannot run not connected", () => {
    expect(
      discoveredStatus(agent({ id: "claude-code", name: "Claude Code", installed: true })),
    ).toBe("notConnected");
    expect(discoveredStatus(agent({ id: "claude-code", name: "Claude Code" }))).toBe(
      "notConnected",
    );
  });
});

describe("catalog products and the ten-product cap (KIN-AGENTS-001)", () => {
  function product(partial: Partial<AgentInfo> & Pick<AgentInfo, "id" | "name">): AgentInfo {
    return agent({ installed: true, permission_modes: ["default"], ...partial });
  }

  it("separates products Kin can host from presence-only sightings", () => {
    const list = [
      product({ id: "claude-code", name: "Claude Code", available: true }),
      // A presence-only row: installed, but no permission ladder, because Kin
      // has no adapter to run a turn in.
      agent({
        id: "cursor",
        name: "Cursor",
        installed: true,
        reason: "installed; no known headless CLI mode",
      }),
    ];
    expect(catalogProducts(list).map((a) => a.id)).toEqual(["claude-code"]);
  });

  it("falls back to availability when the daemon predates the ladder field", () => {
    const list = [
      agent({ id: "claude-code", name: "Claude Code", installed: true, available: true }),
      agent({
        id: "gemini-cli",
        name: "Gemini CLI",
        installed: true,
        available: false,
        reason: "smoke failed",
      }),
      agent({ id: "cursor", name: "Cursor", installed: true }),
    ];
    expect(catalogProducts(list).map((a) => a.id)).toEqual(["claude-code"]);
  });

  it("seeds one family per product, never a sighting", () => {
    const list = [
      product({ id: "claude-code", name: "Claude Code", available: true }),
      product({ id: "claude-acp", name: "Claude Code (ACP)", available: true }),
      product({ id: "agent-0", name: "Agent 0" }),
      agent({ id: "cursor", name: "Cursor", installed: true }),
    ];
    const seeded = seedCatalogFamilies(list);
    // The ACP variant is the same product as the native one.
    expect(seeded.filter((id) => id === "claude")).toHaveLength(1);
    expect(seeded).toHaveLength(2);
    // A sighting is not seed material.
    expect(seeded).not.toContain("cursor");
  });

  it("never seeds more than ten products", () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      product({ id: `agent-${i}`, name: `Agent ${String(i).padStart(2, "0")}` }),
    );
    expect(seedCatalogFamilies(list)).toHaveLength(CATALOG_LIMIT);
  });

  it("shows the stored families in stored order and only hostable installed discoveries", () => {
    const list = [
      product({ id: "codex", name: "Codex", available: true }),
      product({ id: "claude-code", name: "Claude Code", available: true }),
      product({ id: "gemini-cli", name: "Gemini CLI", available: true }),
      // A sighting: present, but no adapter to run a turn in. Connecting it
      // would spend a slot on a row that can never be available.
      agent({ id: "cursor", name: "Cursor", installed: true }),
      // A product nobody installed: an install suggestion, not a discovery.
      product({ id: "goose", name: "Goose", installed: false, available: false }),
    ];
    const plan = planAgentCatalog(list, ["claude", "codex"], CATALOG_LIMIT);
    expect(plan.connected.map((a) => a.id)).toEqual(["claude-code", "codex"]);
    expect(plan.discovered.map((a) => a.id)).toEqual(["gemini-cli"]);
    expect(plan.full).toBe(false);
    expect(plan.missing).toEqual([]);
  });

  it("spends a slot on a stored family the machine no longer reports", () => {
    // Nine rows plus a family that vanished: the catalog is still full, because
    // the stored list is the person's decision. Hiding the hole would let an
    // eleventh product in while an invisible tenth still occupied a slot.
    const list = Array.from({ length: 9 }, (_, i) =>
      product({ id: `agent-${i}`, name: `Agent ${i}`, available: true }),
    );
    const families = [...list.map((a) => a.id), "vanished"];
    const plan = planAgentCatalog(list, families, CATALOG_LIMIT);
    expect(plan.connected).toHaveLength(9);
    expect(plan.full).toBe(true);
    expect(plan.missing).toEqual(["vanished"]);
  });

  it("reports a stored family past the cap instead of an eleventh row", () => {
    const list = Array.from({ length: 10 }, (_, i) =>
      product({ id: `agent-${i}`, name: `Agent ${i}`, available: true }),
    );
    const families = list.map((a) => a.id);
    const plan = planAgentCatalog(list, [...families, "vanished"], CATALOG_LIMIT);
    expect(plan.connected).toHaveLength(10);
    expect(plan.full).toBe(true);
    expect(plan.missing).toEqual(["vanished"]);
  });

  it("puts the default agent first even when other rows look more usable", () => {
    const list = [
      agent({ id: "codex", name: "Codex", available: true, installed: true }),
      agent({ id: "gemini", name: "Gemini" }),
      agent({ id: "claude-code", name: "Claude Code", default: true }),
    ];
    expect(sortAgentCatalog(list).map((a) => a.id)).toEqual(["claude-code", "codex", "gemini"]);
  });
});

describe("runnableAgents / sortAgentCatalog", () => {
  it("filters runnable and sorts", () => {
    const list = [
      agent({ id: "cursor", name: "Cursor", installed: false }),
      agent({ id: "gemini-cli", name: "Gemini", available: true, installed: true }),
      agent({
        id: "pi",
        name: "Pi",
        installed: true,
        reason: "awaiting smoke test",
      }),
    ];
    expect(runnableAgents(list).map((a) => a.id)).toEqual(["gemini-cli"]);
    expect(sortAgentCatalog(list).map((a) => a.id)).toEqual(["gemini-cli", "pi", "cursor"]);
  });
});
