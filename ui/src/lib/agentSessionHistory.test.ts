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
    const chatItems = mergeProcessRuns(buildChatItems(events, "claude-code", undefined, true));

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
    expect(chatItems[1].steps.map((entry) => entry.kind)).toEqual(["note", "note", "tool"]);
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

  it("carries the cut flag from any chunk of a merged message", () => {
    // One message, two records, and the machine could not send the second whole:
    // the reader is reading one message, so the warning belongs to the whole of
    // it rather than to a fragment they cannot see.
    const merged = mergeAgentSessionMessageChunks([
      item("a1:0", "assistant", "first half"),
      { ...item("a1:1", "assistant", "second half"), truncated: true },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].truncated).toBe(true);
  });
});

// A message the machine could not send whole looks finished. The marker after it
// is the only thing that says otherwise, so it has to be in the transcript at the
// point where the reader stops reading, and it has to be absent when there is
// nothing to report.
describe("truncated history", () => {
  const cut = (id: string, text: string): AgentSessionHistoryItem => ({
    ...item(id, "assistant", text),
    truncated: true,
  });

  it("says so after the message that was cut", () => {
    const events = agentSessionHistoryToTaskEvents(
      [item("u1", "user", "Long question"), cut("a1", "An answer that stops")],
      "agent-session-1",
      "claude-code",
      { truncatedNotice: "cut off" },
    );

    const kinds = events.map((event) => event.type);
    expect(kinds).toEqual(["message", "message", "notice", "result"]);
    const notice = events.find((event) => event.type === "notice");
    expect(notice?.payload).toMatchObject({ message: "cut off" });
    // Third, which is after the message that was cut and before the turn's
    // result: the reader learns why the text stopped once they have read as far
    // as it goes.
    expect(kinds.indexOf("notice")).toBe(2);
  });

  it("says nothing when the caller has nowhere to show it", () => {
    const events = agentSessionHistoryToTaskEvents(
      [cut("a1", "An answer that stops")],
      "agent-session-1",
      "claude-code",
    );

    expect(events.some((event) => event.type === "notice")).toBe(false);
  });

  it("says nothing about a message that arrived whole", () => {
    const events = agentSessionHistoryToTaskEvents(
      [item("a1", "assistant", "All of it")],
      "agent-session-1",
      "claude-code",
      { truncatedNotice: "cut off" },
    );

    expect(events.some((event) => event.type === "notice")).toBe(false);
  });
});
