import { describe, expect, it } from "vitest";
import {
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
