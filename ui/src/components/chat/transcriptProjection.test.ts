import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../api/client";
import {
  buildChatItems,
  groupIntoTurns,
  mergeProcessRuns,
  type ChatItem,
  type ProgressItem,
} from "./transcriptProjection";

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


  it("suppresses cancel error events from steer interrupts", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          content: [{ type: "text", text: "do X" }],
        }),
        ev(2, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          input: { command: "echo hi" },
        }),
        ev(3, "error", { message: "canceled" }),
        ev(4, "message", {
          role: "user",
          content: [{ type: "text", text: "do Y instead" }],
          source: "interrupt",
        }),
      ],
      "kin",
    );
    expect(items.some((i) => i.kind === "error")).toBe(false);
    expect(items.filter((i) => i.kind === "message").map((i) => (i as any).text || (i as any).role)).toBeTruthy();
  });

describe("mergeProcessRuns", () => {
  function progress(key: string, status: "running" | "done" | "error" = "done"): ProgressItem {
    return {
      kind: "progress",
      key,
      speaker: "kin",
      steps: [
        { kind: "tool", key: `${key}-t`, speaker: "kin", name: "bash", summary: "bash", status },
      ],
    };
  }

  function message(key: string, text: string, partial = false): ChatItem {
    return { kind: "message", key, speaker: "kin", text, partial };
  }

  function progressWithNotes(key: string, notes: string[]): ProgressItem {
    return {
      kind: "progress",
      key,
      speaker: "kin",
      steps: [
        { kind: "tool", key: `${key}-t1`, speaker: "kin", name: "bash", summary: "bash", status: "done" as const },
        ...notes.map((text, i) => ({
          kind: "note" as const,
          key: `${key}-n${i}`,
          speaker: "kin",
          text,
          status: "done" as const,
        })),
        { kind: "tool", key: `${key}-t2`, speaker: "kin", name: "read", summary: "read", status: "done" as const },
      ],
    };
  }

  it("expands narration notes into messages and keeps tool blocks as progress", () => {
    // Product behavior (note-group split): a single progress card that mixed
    // tools + narration becomes interleaved message/progress items so host
    // narration stays readable next to worker tool runs.
    const items: ChatItem[] = [
      progressWithNotes("p1", ["Plan loaded.", "Implementing changes."]),
      message("final", "Here is the summary."),
    ];

    const merged = mergeProcessRuns(items);

    expect(merged.map((x) => x.kind)).toEqual([
      "progress",
      "message",
      "message",
      "progress",
      "message",
    ]);
    expect(merged[1]).toMatchObject({ kind: "message", text: "Plan loaded." });
    expect(merged[2]).toMatchObject({
      kind: "message",
      text: "Implementing changes.",
    });
    expect(merged[4]).toMatchObject({
      kind: "message",
      text: "Here is the summary.",
    });
    const firstTools = merged[0] as ProgressItem;
    expect(firstTools.steps.every((s) => s.kind === "tool")).toBe(true);
  });

  it("rewrites a single tool-only progress card key without changing shape", () => {
    const items: ChatItem[] = [progress("p1"), message("final", "done")];
    const merged = mergeProcessRuns(items);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      kind: "progress",
      key: "toolgrp-p1-t",
      speaker: "kin",
    });
    expect((merged[0] as ProgressItem).steps).toEqual((items[0] as ProgressItem).steps);
    expect(merged[1]).toEqual(items[1]);
  });

  it("does not merge across a user message", () => {
    const items: ChatItem[] = [
      { kind: "message", key: "u1", speaker: "user", text: "hi" },
      progress("p1"),
      message("m1", "working"),
      progress("p2"),
      message("final", "done"),
    ];

    const merged = mergeProcessRuns(items);
    expect(merged[0]).toMatchObject({ kind: "message", speaker: "user" });
    expect(merged[1].kind).toBe("progress");
    // Interleaved agent messages stay as messages (not folded into progress).
    expect(merged.map((x) => (x.kind === "message" ? x.text : x.kind))).toEqual([
      "hi",
      "progress",
      "working",
      "progress",
      "done",
    ]);
  });

  it("keeps a still-streaming trailing message live instead of folding it", () => {
    const items: ChatItem[] = [
      progress("p1"),
      message("m1", "working"),
      message("live", "typing...", true),
    ];

    const merged = mergeProcessRuns(items);
    expect(merged).toHaveLength(3);
    expect(merged[0].kind).toBe("progress");
    expect(merged[1]).toMatchObject({ key: "m1", text: "working", partial: false });
    expect(merged[2]).toMatchObject({ key: "live", partial: true });
  });

  it("merges consecutive progress cards then splits notes inside", () => {
    const a: ProgressItem = {
      kind: "progress",
      key: "a",
      speaker: "kin",
      steps: [
        { kind: "tool", key: "a-t", speaker: "kin", name: "bash", summary: "bash", status: "done" },
        { kind: "note", key: "a-n", speaker: "kin", text: "mid note", status: "done" },
      ],
    };
    const b: ProgressItem = {
      kind: "progress",
      key: "b",
      speaker: "kin",
      steps: [
        { kind: "tool", key: "b-t", speaker: "kin", name: "read", summary: "read", status: "done" },
      ],
    };
    const merged = mergeProcessRuns([a, b, message("final", "done")]);
    // Consecutive progresses merge first (a steps + b steps), then expand:
    // tool(a) | note → message | tool(b) | final message
    expect(merged.map((x) => x.kind)).toEqual([
      "progress",
      "message",
      "progress",
      "message",
    ]);
    expect(merged[1]).toMatchObject({ kind: "message", text: "mid note" });
    expect(merged[3]).toMatchObject({ text: "done" });
  });

  // -- Route event rendering (US2, US6, US7: route_decision / route_fallback) --

  it("renders route_decision as a meta item with phase, provider, model, and team", () => {
    const items = buildChatItems(
      [
        ev(1, "route_decision", {
          phase: "execute",
          provider: "prov-a",
          model: "a-smart-1",
          team: "t1",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "meta",
        key: "rd-1",
        label: "Routing: execute → prov-a/a-smart-1 (team: t1)",
      },
    ]);
  });

  it("renders route_decision without team when team is missing", () => {
    const items = buildChatItems(
      [
        ev(1, "route_decision", {
          phase: "plan",
          provider: "prov-b",
          model: "b-fast",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "meta",
        key: "rd-1",
        label: "Routing: plan → prov-b/b-fast",
      },
    ]);
  });

  it("renders route_fallback as a meta item with source and destination", () => {
    const items = buildChatItems(
      [
        ev(1, "route_fallback", {
          provider: "prov-b",
          model: "b-smart",
          fallback_from: { provider: "prov-a", model: "a-smart-1" },
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "meta",
        key: "rf-1",
        label: "Fallback: prov-a/a-smart-1 → prov-b/b-smart",
      },
    ]);
  });

  it("renders route_fallback with unknown source when fallback_from is missing", () => {
    const items = buildChatItems(
      [
        ev(1, "route_fallback", {
          provider: "prov-c",
          model: "c-free",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "meta",
        key: "rf-1",
        label: "Fallback: unknown → prov-c/c-free",
      },
    ]);
  });

  it("route events flush the stream and do not leave a dangling progress", () => {
    // A route_decision between two assistant messages should flush the
    // streaming partial and appear as a standalone meta item.
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          text: "partial",
          partial: true,
        }),
        ev(2, "route_decision", {
          phase: "review",
          provider: "prov-a",
          model: "a-smart-1",
        }),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          text: "final answer",
          partial: false,
        }),
      ],
      "kin",
    );

    // Note: route_decision's flushStream only clears streaming progress buffers,
    // not standalone message partials. The partial remains partial.
    expect(items).toMatchObject([
      { kind: "message", text: "partial" },
      { kind: "meta", key: "rd-2", label: "Routing: review → prov-a/a-smart-1" },
      { kind: "message", text: "final answer" },
    ]);
  });
});
