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
});
