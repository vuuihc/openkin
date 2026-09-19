import { describe, expect, it } from "vitest";
import type { AgentSessionHistoryItem } from "../api/client";
import {
  groupAgentSessionHistory,
  mergeAgentSessionMessageChunks,
} from "./agentSessionHistory";

function item(
  message_id: string,
  role: AgentSessionHistoryItem["role"],
  text: string,
  kind: AgentSessionHistoryItem["kind"] = "message",
): AgentSessionHistoryItem {
  return {
    agent_id: "claude-code",
    external_ref: "session-1",
    message_id,
    kind,
    role,
    text,
    occurred_at: 1,
    source_rev: "rev-1",
  };
}

describe("groupAgentSessionHistory", () => {
  it("keeps process events collapsed separately from the final assistant message", () => {
    const turns = groupAgentSessionHistory([
      item("u1", "user", "Draw a diagram"),
      item("a1", "assistant", "I will inspect the workspace"),
      item("r1", "assistant", "thinking", "reasoning"),
      item("t1", "tool", "call draw", "tool_call"),
      item("tr1", "tool", "draw complete", "tool_result"),
      item("a2", "assistant", "# Result\n\nDone"),
      item("u2", "user", "Make it larger"),
      item("a3", "assistant", "## Updated\n\nDone"),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].userItems.map((entry) => entry.text)).toEqual(["Draw a diagram"]);
    expect(turns[0].finalAssistant?.text).toBe("# Result\n\nDone");
    expect(turns[0].processItems.map((entry) => entry.message_id)).toEqual([
      "a1",
      "r1",
      "t1",
      "tr1",
    ]);
    expect(turns[1].finalAssistant?.text).toBe("## Updated\n\nDone");
    expect(turns[1].processItems).toEqual([]);
  });

  it("keeps assistant process events when a turn has no final message", () => {
    const [turn] = groupAgentSessionHistory([
      item("u1", "user", "Draw"),
      item("r1", "assistant", "thinking", "reasoning"),
      item("t1", "tool", "call draw", "tool_call"),
    ]);

    expect(turn.finalAssistant).toBeNull();
    expect(turn.processItems).toHaveLength(2);
  });
});

describe("mergeAgentSessionMessageChunks", () => {
  it("merges blocks from one provider message without merging separate turns", () => {
    const merged = mergeAgentSessionMessageChunks([
      item("user-1:0", "user", "first"),
      item("user-1:1", "user", "second"),
      item("user-2", "user", "new turn"),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe("first\n\nsecond");
    expect(merged[1].text).toBe("new turn");
  });
});
