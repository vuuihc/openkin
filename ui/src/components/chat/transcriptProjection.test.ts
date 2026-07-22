import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../api/client";
import { buildChatItems, groupIntoTurns } from "./transcriptProjection";

function ev(seq: number, type: string, payload: unknown): TaskEvent {
  return {
    task_id: "task-1",
    seq,
    ts: seq,
    type,
    payload,
  };
}

describe("transcriptProjection", () => {
  it("replaces partial assistant previews with the final message", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          text: "hel",
          partial: true,
        }),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          text: "hello back",
          partial: false,
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      { kind: "message", speaker: "user", text: "hello" },
      {
        kind: "message",
        speaker: "kin",
        text: "hello back",
      },
    ]);
  });

  it("finalizes a trailing partial when the task is terminal", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          text: "done",
          partial: true,
        }),
      ],
      "kin",
      undefined,
      true,
    );

    expect(items).toMatchObject([
      {
        kind: "message",
        speaker: "kin",
        text: "done",
        partial: false,
      },
    ]);
  });

  it("merges tool_use and tool_result into one progress tool step", () => {
    const items = buildChatItems(
      [
        ev(1, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          input: { command: "npm test" },
          visibility: { user: true, task: true },
        }),
        ev(2, "tool_result", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          output: "ok",
          ok: true,
          visibility: { user: true, task: true },
        }),
      ],
      "kin",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "progress",
      speaker: "kin",
      steps: [
        {
          kind: "tool",
          name: "bash",
          status: "done",
          output: "ok",
        },
      ],
    });
  });

  it("puts delegate chatter in progress and final orchestrator summary in chat", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          source: "delegate",
          speaker: "claude-code",
          text: "→ worker",
        }),
        ev(2, "message", {
          role: "assistant",
          source: "orchestrator",
          speaker: "kin",
          text: "完成：all good",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [{ kind: "note", speaker: "claude-code", text: "→ worker" }],
      },
      {
        kind: "message",
        speaker: "kin",
        text: "完成：all good",
      },
    ]);
  });

  it("shows a synthesized orchestrator summary regardless of its wording", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          source: "orchestrator",
          phase: "summary",
          speaker: "kin",
          text: "The workers found and fixed the root cause.",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "message",
        speaker: "kin",
        text: "The workers found and fixed the root cause.",
      },
    ]);
  });

  it("converts legacy tool dump messages into progress tool steps", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          text: "**bash**\n```text\nERROR: nope\n```",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [
          {
            kind: "tool",
            name: "bash",
            status: "error",
            output: "ERROR: nope",
          },
        ],
      },
    ]);
  });

  it("coalesces multiple partial deltas into one streaming message", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "Hel" }],
          partial: true,
        }),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "lo" }],
          partial: true,
        }),
        ev(4, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "Hello world" }],
          partial: false,
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      { kind: "message", speaker: "user", text: "hi" },
      { kind: "message", speaker: "kin", text: "Hello world" },
    ]);
    // No leftover partial item.
    expect(items.filter((i) => i.kind === "message" && i.partial)).toHaveLength(0);
  });

  it("keeps a live partial while the task is still running", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "Hel" }],
          partial: true,
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "lo" }],
          partial: true,
        }),
      ],
      "kin",
      undefined,
      false,
    );
    expect(items).toMatchObject([
      { kind: "message", speaker: "kin", text: "Hello", partial: true },
    ]);
  });

  
  it("projects an arbitrary plugin host without a speaker whitelist", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          content: [{ type: "text", text: "ship it" }],
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "future-agent",
          text: "host reply from a new plugin",
          visibility: { user: true, task: true },
        }),
      ],
      "future-agent",
    );

    expect(items).toMatchObject([
      { kind: "message", speaker: "user", text: "ship it" },
      {
        kind: "message",
        speaker: "future-agent",
        text: "host reply from a new plugin",
      },
    ]);
  });

  it("accepts explicit agent field for arbitrary plugin speakers", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          agent: "future-agent",
          text: "identity via agent field",
          visibility: { user: true, task: true },
        }),
      ],
      "future-agent",
    );

    expect(items).toMatchObject([
      {
        kind: "message",
        speaker: "future-agent",
        text: "identity via agent field",
      },
    ]);
  });

  it("keeps future-agent worker chatter in progress via visibility metadata", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "future-agent",
          text: "worker scratch notes",
          visibility: { user: false, task: true },
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          text: "host summary after workers",
          visibility: { user: true, task: true },
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        speaker: "kin",
        steps: [
          {
            kind: "note",
            speaker: "future-agent",
            text: "worker scratch notes",
          },
        ],
      },
      {
        kind: "message",
        speaker: "kin",
        text: "host summary after workers",
      },
    ]);
  });

  it("uses future-agent as host while a built-in worker stays in progress", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          source: "delegate",
          speaker: "claude-code",
          text: "→ delegated worker",
          visibility: { user: false, task: true },
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "future-agent",
          text: "host closes the turn",
          visibility: { user: true, task: true },
        }),
      ],
      "future-agent",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        speaker: "future-agent",
        steps: [
          {
            kind: "note",
            speaker: "claude-code",
            text: "→ delegated worker",
          },
        ],
      },
      {
        kind: "message",
        speaker: "future-agent",
        text: "host closes the turn",
      },
    ]);
  });

  it("preserves legacy kin host and built-in worker events without visibility", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          source: "delegate",
          speaker: "codex",
          text: "legacy worker note",
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          text: "legacy host reply",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [{ kind: "note", speaker: "codex", text: "legacy worker note" }],
      },
      {
        kind: "message",
        speaker: "kin",
        text: "legacy host reply",
      },
    ]);
  });

  it("does not treat control source labels as speakers", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          source: "follow_up",
          text: "follow-up reply",
          visibility: { user: true, task: true },
        }),
      ],
      "future-agent",
    );

    expect(items).toMatchObject([
      {
        kind: "message",
        speaker: "future-agent",
        text: "follow-up reply",
      },
    ]);
  });

  it("groups projected items into user and agent turns", () => {
    const items = buildChatItems(
      [
        ev(1, "message", { role: "user", text: "do it" }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          text: "working",
        }),
        ev(3, "approval_requested", {}),
      ],
      "kin",
    );

    const turns = groupIntoTurns(items, "kin");
    expect(turns).toMatchObject([
      { kind: "user" },
      { kind: "agent", speaker: "kin", items: [{ text: "working" }, { kind: "meta" }] },
    ]);
  });

  it("groups turns under an arbitrary plugin host speaker", () => {
    const items = buildChatItems(
      [
        ev(1, "message", { role: "user", text: "go" }),
        ev(2, "message", {
          role: "assistant",
          speaker: "future-agent",
          text: "on it",
          visibility: { user: true, task: true },
        }),
      ],
      "future-agent",
    );

    const turns = groupIntoTurns(items, "future-agent");
    expect(turns).toMatchObject([
      { kind: "user" },
      {
        kind: "agent",
        speaker: "future-agent",
        items: [{ kind: "message", speaker: "future-agent", text: "on it" }],
      },
    ]);
  });
});
