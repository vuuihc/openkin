import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../api/client";
import {
  agentCatalogState,
  isNativeAgent,
  runnableAgents,
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

describe("agentCatalogState", () => {
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
    expect(sortAgentCatalog(list).map((a) => a.id)).toEqual([
      "gemini-cli",
      "pi",
      "cursor",
    ]);
  });
});
