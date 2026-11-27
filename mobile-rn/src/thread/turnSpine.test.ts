import { describe, expect, it } from "@jest/globals";
import type {
  ChatItem,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import {
  roundEndedUncleanly,
  spineFor,
  type SpineContext,
} from "./turnSpine";

/**
 * KIN-MOBILE-002 R4b — the activity spine's decision table.
 *
 * One case per rule, plus the case that makes "the running turn" mean the
 * newest agent turn rather than every agent turn. The helper is DOM-free, so
 * the table is checked without a renderer.
 */

function message(key: string, text: string): ChatItem {
  return { kind: "message", key, speaker: "kin", text };
}

function agentTurn(...items: ChatItem[]): Turn {
  return { kind: "agent", speaker: "kin", items };
}

function userTurn(text: string): Turn {
  return {
    kind: "user",
    item: { kind: "message", key: `user-${text}`, speaker: "you", text },
  };
}

function standalone(item: Extract<ChatItem, { kind: "error" | "meta" }>): Turn {
  return { kind: "standalone", item };
}

const STOPPED = "已停止本轮";

function ctx(overrides: Partial<SpineContext> = {}): SpineContext {
  return {
    lastAgentIndex: 1,
    running: false,
    failed: false,
    awaitingApproval: false,
    ...overrides,
  };
}

describe("KIN-MOBILE-002 R4b spine decision table", () => {
  it("KIN-MOBILE-002 R4b: the person's own turn carries no spine", () => {
    expect(spineFor(userTurn("问"), 0, ctx())).toBeNull();
  });

  it("KIN-MOBILE-002 R4b: a standalone error or stop note carries no spine of its own", () => {
    const error = standalone({ kind: "error", key: "e1", message: "读取失败" });
    const stopped = standalone({
      kind: "meta",
      key: "s1",
      label: STOPPED,
    });

    expect(spineFor(error, 0, ctx())).toBeNull();
    expect(spineFor(stopped, 0, ctx())).toBeNull();
  });

  it("KIN-MOBILE-002 R4b: an agent turn holding an error item is failed", () => {
    const turn = agentTurn(
      message("m1", "开始"),
      { kind: "error", key: "e1", message: "命令失败" },
    );

    expect(spineFor(turn, 1, ctx())).toBe("failed");
  });

  it("KIN-MOBILE-002 R4b: the last agent turn waiting on an approval is orange, even while the round runs", () => {
    const turn = agentTurn(message("m1", "在等批准"));

    expect(
      spineFor(
        turn,
        1,
        ctx({ running: true, awaitingApproval: true }),
      ),
    ).toBe("approval");
  });

  it("KIN-MOBILE-002 R4b: the last agent turn of an open round is running", () => {
    const turn = agentTurn(message("m1", "在做"));

    expect(spineFor(turn, 1, ctx({ running: true }))).toBe("running");
  });

  it("KIN-MOBILE-002 R4b: the last agent turn of a round that failed or was stopped is failed", () => {
    const turn = agentTurn(message("m1", "做到一半"));

    expect(spineFor(turn, 1, ctx({ failed: true }))).toBe("failed");
  });

  it("KIN-MOBILE-002 R4b: every other agent turn is done", () => {
    expect(spineFor(agentTurn(message("m1", "答完了")), 1, ctx())).toBe("done");
    // The flag is about the newest round only: an earlier agent turn is green
    // even when the thread's last round failed.
    expect(
      spineFor(
        agentTurn(message("m2", "更早的答复")),
        1,
        ctx({ lastAgentIndex: 3, failed: true }),
      ),
    ).toBe("done");
  });

  it("KIN-MOBILE-002 R4b: a non-last running thread paints only its last agent turn", () => {
    const context = ctx({ lastAgentIndex: 3, running: true });

    expect(spineFor(agentTurn(message("m1", "上一轮")), 1, context)).toBe("done");
    expect(spineFor(agentTurn(message("m2", "这一轮")), 3, context)).toBe(
      "running",
    );
  });
});

describe("KIN-MOBILE-002 R4b round outcome", () => {
  it("KIN-MOBILE-002 R4b: a stop note inside the newest agent turn marks the round unclean", () => {
    const turns = [
      userTurn("问"),
      agentTurn(message("m1", "做到一半"), {
        kind: "meta",
        key: "stopped-9",
        label: STOPPED,
      }),
    ];

    expect(roundEndedUncleanly(turns, STOPPED)).toBe(true);
  });

  it("KIN-MOBILE-002 R4b: an error item inside the newest agent turn marks the round unclean", () => {
    const turns = [
      userTurn("问"),
      agentTurn(message("m1", "开始"), {
        kind: "error",
        key: "err-9",
        message: "命令失败",
      }),
    ];

    expect(roundEndedUncleanly(turns, STOPPED)).toBe(true);
  });

  it("KIN-MOBILE-002 R4b: a settled answer with no error is clean", () => {
    const turns = [userTurn("问"), agentTurn(message("m1", "答完了"))];

    expect(roundEndedUncleanly(turns, STOPPED)).toBe(false);
  });

  it("KIN-MOBILE-002 R4b: a standalone stop note does not repaint the older agent turn", () => {
    const turns = [
      userTurn("问"),
      agentTurn(message("m1", "答完了")),
      userTurn("再问"),
      standalone({ kind: "meta", key: "stopped-9", label: STOPPED }),
    ];

    expect(roundEndedUncleanly(turns, STOPPED)).toBe(false);
  });
});
