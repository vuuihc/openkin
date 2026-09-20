import { describe, expect, it } from "vitest";
import type { AgentSessionHistoryItem } from "../api/client";
import {
  buildChatItems,
  groupIntoTurns,
  mergeProcessRuns,
} from "../components/chat/transcriptProjection";
import {
  agentSessionHistoryToTaskEvents,
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

describe("agentSessionHistoryToTaskEvents", () => {
  it("projects imported history into the shared chat transcript model", () => {
    const events = agentSessionHistoryToTaskEvents(
      [
        item("u1", "user", "Draw a diagram"),
        item("a1", "assistant", "I will inspect the workspace"),
        item("r1", "assistant", "thinking", "reasoning"),
        item("t1", "tool", "call draw", "tool_call"),
        item("t1", "tool", "draw complete", "tool_result"),
        item("a2", "assistant", "# Result\n\nDone"),
        item("u2", "user", "Make it larger"),
        item("a3", "assistant", "## Updated\n\nDone"),
      ],
      "agent-session-1",
      "claude-code",
    );
    const chatItems = mergeProcessRuns(
      buildChatItems(events, "claude-code", undefined, true),
    );

    expect(chatItems.map((entry) => entry.kind)).toEqual([
      "message",
      "progress",
      "message",
      "message",
      "message",
    ]);
    expect(chatItems[0]).toMatchObject({ kind: "message", speaker: "user" });
    expect(chatItems[1]).toMatchObject({ kind: "progress" });
    if (chatItems[1].kind !== "progress") throw new Error("expected progress");
    expect(chatItems[1].steps.map((entry) => entry.kind)).toEqual([
      "note",
      "note",
      "tool",
    ]);
    expect(chatItems[2]).toMatchObject({
      kind: "message",
      speaker: "claude-code",
      text: "# Result\n\nDone",
    });
    expect(chatItems[4]).toMatchObject({
      kind: "message",
      speaker: "claude-code",
      text: "## Updated\n\nDone",
    });
  });

  it("keeps assistant process events when a page ends mid-turn", () => {
    const events = agentSessionHistoryToTaskEvents(
      [
        item("u1", "user", "Draw"),
        item("r1", "assistant", "thinking", "reasoning"),
        item("t1", "tool", "call draw", "tool_call"),
      ],
      "agent-session-1",
      "claude-code",
    );
    const turns = groupIntoTurns(
      mergeProcessRuns(buildChatItems(events, "claude-code", undefined, true)),
      "claude-code",
    );

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ kind: "agent" });
    if (turns[1].kind !== "agent") throw new Error("expected agent turn");
    expect(turns[1].items).toHaveLength(1);
    expect(turns[1].items[0]).toMatchObject({ kind: "progress" });
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
