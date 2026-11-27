import { describe, expect, it } from "@jest/globals";
import type {
  ChatItem,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import {
  lastAgentTurnIndex,
  roundEndedUncleanly,
  spineFor,
  type SpineContext,
} from "./turnSpine";

/**
 * KIN-MOBILE-002 R4b — one case per rule in the spine's decision table, plus
 * the case that makes "the running turn" mean the newest agent turn.
 */

const message = (key: string, text: string): ChatItem => ({
  kind: "message",
  key,
  speaker: "kin",
  text,
});
const agentTurn = (...items: ChatItem[]): Turn => ({
  kind: "agent",
  speaker: "kin",
  items,
});
const userTurn = (text: string): Turn => ({
  kind: "user",
  item: { kind: "message", key: `user-${text}`, speaker: "you", text },
});
const standalone = (item: Extract<ChatItem, { kind: "error" | "meta" }>): Turn => ({
  kind: "standalone",
  item,
});

const STOPPED = "已停止本轮";

function ctx(overrides: Partial<SpineContext> = {}): SpineContext {
  return {
    lastAgentIndex: 1,
    running: false,
    failed: false,
    awaitingApproval: false,
    stoppedNote: STOPPED,
    ...overrides,
  };
}

describe("KIN-MOBILE-002 R4b spine decision table", () => {
  it("KIN-MOBILE-002 R4b: a person's turn and a standalone error or stop note carry no spine", () => {
    const error = standalone({ kind: "error", key: "e1", message: "读取失败" });
    const stopped = standalone({ kind: "meta", key: "s1", label: STOPPED });

    expect(spineFor(userTurn("问"), 0, ctx())).toBeNull();
    expect(spineFor(error, 0, ctx())).toBeNull();
    expect(spineFor(stopped, 0, ctx())).toBeNull();
  });

  it("KIN-MOBILE-002 R4b: an agent turn holding an error item is failed", () => {
    const turn = agentTurn(message("m1", "开始"), {
      kind: "error",
      key: "e1",
      message: "命令失败",
    });

    expect(spineFor(turn, 1, ctx())).toBe("failed");
    // The error outranks every thread flag, even on a non-last turn.
    expect(spineFor(turn, 1, ctx({ lastAgentIndex: 3, running: true }))).toBe(
      "failed",
    );
  });

  it("KIN-MOBILE-002 R4b: the last agent turn is orange while an approval waits, blue while it runs, red after a failed or stopped round", () => {
    const turn = agentTurn(message("m1", "做到一半"));

    // Approval outranks running: the node is blocked, not working.
    expect(spineFor(turn, 1, ctx({ running: true, awaitingApproval: true }))).toBe(
      "approval",
    );
    expect(spineFor(turn, 1, ctx({ running: true }))).toBe("running");
    expect(spineFor(turn, 1, ctx({ failed: true }))).toBe("failed");
  });

  it("KIN-MOBILE-002 R4b: every other agent turn is done, and a non-last running thread paints only its last agent turn", () => {
    const running = ctx({ lastAgentIndex: 3, running: true, failed: true });

    // The flags are about the newest round only.
    expect(spineFor(agentTurn(message("m1", "更早的答复")), 1, ctx())).toBe("done");
    expect(spineFor(agentTurn(message("m2", "上一轮")), 1, running)).toBe("done");
    expect(spineFor(agentTurn(message("m3", "这一轮")), 3, running)).toBe("running");
  });

  it("KIN-MOBILE-002 R4b: a trailing person turn means no earlier agent turn is live", () => {
    const waitingForAgent = [
      userTurn("问"),
      agentTurn(message("m1", "上一轮答完了")),
      userTurn("再问"),
    ];

    expect(lastAgentTurnIndex(waitingForAgent)).toBe(-1);
    expect(
      spineFor(
        waitingForAgent[1]!,
        1,
        ctx({
          lastAgentIndex: lastAgentTurnIndex(waitingForAgent),
          running: true,
        }),
      ),
    ).toBe("done");
    expect(
      lastAgentTurnIndex([userTurn("问"), agentTurn(message("m2", "这轮在做"))]),
    ).toBe(1);
  });

  it("KIN-MOBILE-002 R4b: a stop note inside an agent turn stays failed after a newer ask arrives", () => {
    const stoppedAgent = agentTurn(message("m1", "做到一半"), {
      kind: "meta",
      key: "stopped-9",
      label: STOPPED,
    });
    const afterNewAsk = [userTurn("问"), stoppedAgent, userTurn("再问")];

    expect(roundEndedUncleanly(afterNewAsk, STOPPED)).toBe(false);
    expect(
      spineFor(
        stoppedAgent,
        1,
        ctx({
          lastAgentIndex: lastAgentTurnIndex(afterNewAsk),
          running: true,
        }),
      ),
    ).toBe("failed");
  });
});

describe("KIN-MOBILE-002 R4b round outcome", () => {
  it("KIN-MOBILE-002 R4b: only a note inside the newest agent turn marks the round unclean", () => {
    const stopped = [
      userTurn("问"),
      agentTurn(message("m1", "做到一半"), {
        kind: "meta",
        key: "stopped-9",
        label: STOPPED,
      }),
    ];
    const errored = [
      userTurn("问"),
      agentTurn(message("m1", "开始"), {
        kind: "error",
        key: "err-9",
        message: "命令失败",
      }),
    ];
    const clean = [userTurn("问"), agentTurn(message("m1", "答完了"))];
    // The note belongs to a newer ask with no agent work: it must not repaint
    // the older answer red.
    const laterStop = [
      userTurn("问"),
      agentTurn(message("m1", "答完了")),
      userTurn("再问"),
      standalone({ kind: "meta", key: "stopped-9", label: STOPPED }),
    ];

    expect(roundEndedUncleanly(stopped, STOPPED)).toBe(true);
    expect(roundEndedUncleanly(errored, STOPPED)).toBe(true);
    expect(roundEndedUncleanly(clean, STOPPED)).toBe(false);
    expect(roundEndedUncleanly(laterStop, STOPPED)).toBe(false);
  });
});
