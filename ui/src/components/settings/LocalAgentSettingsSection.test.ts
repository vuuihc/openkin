import { describe, expect, it } from "vitest";
import type { AgentProvider } from "../../api/client";
import {
  canImportAgentSessions,
  isAutoImportSnapshot,
  localAgentStatusKey,
} from "./LocalAgentSettingsSection";

describe("localAgentStatusKey", () => {
  it("maps every known provider state to a translation key", () => {
    expect(localAgentStatusKey("available")).toBe("settings.localAgents.available");
    expect(localAgentStatusKey("unsupported")).toBe("settings.localAgents.unsupported");
    expect(localAgentStatusKey("not_detected")).toBe("settings.localAgents.notDetected");
    expect(localAgentStatusKey("degraded")).toBe("settings.localAgents.degraded");
    expect(localAgentStatusKey("permission_required")).toBe(
      "settings.localAgents.permissionRequired",
    );
    expect(localAgentStatusKey("detected")).toBe("settings.localAgents.unavailable");
  });
});

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

describe("isAutoImportSnapshot", () => {
  it("accepts bounded sync metadata and rejects malformed values", () => {
    expect(
      isAutoImportSnapshot({
        synced_at: 1710000000000,
        imported: 3,
        providers: {},
      }),
    ).toBe(true);

    expect(isAutoImportSnapshot({ synced_at: "now", imported: 3, providers: {} })).toBe(false);
    expect(isAutoImportSnapshot(null)).toBe(false);
  });
});
