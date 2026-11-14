import { describe, expect, it } from "vitest";
import {
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

describe("agent session resumability", () => {
  it("marks unlinked sessions with cwd and attach support as resumable", () => {
    expect(
      canContinueAgentSession({
        linked: false,
        cwd: "/repo",
        capabilities: ["session_attach"],
      }),
    ).toBe(true);
  });

  it("keeps linked, missing-cwd and non-attachable sessions out", () => {
    expect(
      canContinueAgentSession({
        linked: true,
        cwd: "/repo",
        capabilities: ["session_attach"],
      }),
    ).toBe(false);
    expect(
      canContinueAgentSession({
        linked: false,
        cwd: "",
        capabilities: ["session_attach"],
      }),
    ).toBe(false);
    expect(
      canContinueAgentSession({
        linked: false,
        cwd: "/repo",
        capabilities: [],
      }),
    ).toBe(false);
  });
});
