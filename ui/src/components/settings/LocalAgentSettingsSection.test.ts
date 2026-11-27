import { describe, expect, it } from "vitest";
import type { AgentProvider } from "../../api/client";
import { canImportAgentSessions } from "./LocalAgentSettingsSection";

describe("canImportAgentSessions", () => {
  it("requires an available session_list capability", () => {
    const agent = {
      id: "claude",
      name: "Claude Code",
      kind: "cli",
      state: "available",
      installed: true,
      available: true,
      last_scanned_at: "",
      capabilities: [{ capability: "session_list", state: "available" }],
    } satisfies AgentProvider;

    expect(canImportAgentSessions(agent)).toBe(true);
    expect(
      canImportAgentSessions({
        ...agent,
        capabilities: [{ capability: "session_list", state: "unsupported" }],
      }),
    ).toBe(false);
    expect(canImportAgentSessions({ ...agent, capabilities: [] })).toBe(false);
  });
});
