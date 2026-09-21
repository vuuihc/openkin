import { describe, expect, it } from "vitest";
import {
  agentSessionAvailability,
  canContinueAgentSession,
  displayAgentSessionTitle,
  isOpaqueAgentSessionTitle,
} from "./agentSessionTitle";

describe("agent session titles", () => {
  it("recognizes UUIDs and source IDs as opaque", () => {
    expect(
      isOpaqueAgentSessionTitle(
        "6d8f4e35-3b8f-4a6a-8e1a-7ce0fca2d6f4",
        "6d8f4e35-3b8f-4a6a-8e1a-7ce0fca2d6f4",
      ),
    ).toBe(true);
    expect(isOpaqueAgentSessionTitle("Review auth flow", "session-1")).toBe(false);
  });

  it("falls back to the Agent and project for old imported rows", () => {
    expect(
      displayAgentSessionTitle(
        {
          agent_id: "claude-code",
          external_ref: "6d8f4e35-3b8f-4a6a-8e1a-7ce0fca2d6f4",
          project_label: "openkin",
          title: "6d8f4e35-3b8f-4a6a-8e1a-7ce0fca2d6f4",
        },
        "Untitled session",
      ),
    ).toBe("Claude Code · openkin · 6d8f4e35…d6f4");
  });
});

describe("agent session availability", () => {
  it("marks unlinked sessions with cwd and attach support as resumable", () => {
    expect(
      canContinueAgentSession({
        linked: false,
        cwd: "/repo",
        capabilities: ["session_attach"],
      }),
    ).toBe(true);
    expect(
      agentSessionAvailability({
        linked: false,
        cwd: "/repo",
        capabilities: ["session_attach"],
      }),
    ).toBe("resumable");
  });

  it("keeps linked and missing-cwd sessions visually distinct from resumable sessions", () => {
    expect(
      agentSessionAvailability({
        linked: true,
        cwd: "/repo",
        capabilities: ["session_attach"],
      }),
    ).toBe("linked");
    expect(
      agentSessionAvailability({
        linked: false,
        cwd: "",
        capabilities: ["session_attach"],
      }),
    ).toBe("read_only");
    expect(
      agentSessionAvailability({
        linked: false,
        cwd: "/repo",
        capabilities: [],
      }),
    ).toBe("read_only");
  });
});
