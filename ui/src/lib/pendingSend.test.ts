import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../api/client";
import {
  pendingSend,
  settlePendingSendList,
  settlePendingSends,
  userMessageText,
} from "./pendingSend";

function userEvent(seq: number, text: string): TaskEvent {
  return {
    task_id: "t1",
    event_epoch: 0,
    seq,
    ts: seq,
    type: "message",
    payload: { role: "user", speaker: "user", content: [{ type: "text", text }] },
  };
}

function agentEvent(seq: number, text: string): TaskEvent {
  return {
    task_id: "t1",
    event_epoch: 0,
    seq,
    ts: seq,
    type: "message",
    payload: { role: "assistant", speaker: "kin", content: [{ type: "text", text }] },
  };
}

describe("a pending send", () => {
  it("starts after the transcript's high-water mark", () => {
    const send = pendingSend("hello", [userEvent(3, "earlier"), agentEvent(4, "done")]);
    expect(send.startSeq).toBe(4);
    expect(send.text).toBe("hello");
  });

  it("shows an attachment block the way the transcript will", () => {
    const send = pendingSend("look\n\nAttached file:\n- notes.txt: /Users/me/secret/notes.txt", []);
    expect(send.text).toBe("look\n\nAttached file: notes.txt");
  });
});

describe("userMessageText", () => {
  it("reads content blocks", () => {
    expect(userMessageText(userEvent(1, "hello"))).toBe("hello");
  });

  it("reads a plain text payload", () => {
    expect(
      userMessageText({
        task_id: "t1",
        event_epoch: 0,
        seq: 1,
        ts: 1,
        type: "message",
        payload: { role: "user", text: "plain" },
      }),
    ).toBe("plain");
  });

  it("ignores the agent's own messages and non-message events", () => {
    expect(userMessageText(agentEvent(1, "hi"))).toBeNull();
    expect(
      userMessageText({
        task_id: "t1",
        event_epoch: 0,
        seq: 1,
        ts: 1,
        type: "tool_call",
        payload: { role: "user", speaker: "user", text: "not a message" },
      }),
    ).toBeNull();
  });
});

describe("settling pending sends", () => {
  it("drops a send once its own message lands", () => {
    const send = pendingSend("hello", [agentEvent(1, "ready")]);
    const remaining = settlePendingSends([send], [agentEvent(1, "ready"), userEvent(2, "hello")]);
    expect(remaining).toEqual([]);
  });

  it("keeps a send whose message has not landed", () => {
    const send = pendingSend("hello", []);
    const remaining = settlePendingSends([send], [agentEvent(1, "still working")]);
    expect(remaining).toEqual([send]);
  });

  it("does not let an older message with the same words settle a new send", () => {
    const events = [userEvent(1, "hello"), agentEvent(2, "answered")];
    const send = pendingSend("hello", events);
    expect(settlePendingSends([send], events)).toEqual([send]);
  });

  it("settles two identical sends one for one", () => {
    const first = pendingSend("again", []);
    const second = pendingSend("again", []);
    expect(settlePendingSends([first, second], [userEvent(1, "again")])).toEqual([second]);
    expect(
      settlePendingSends([first, second], [userEvent(1, "again"), userEvent(2, "again")]),
    ).toEqual([]);
  });

  it("returns the same list when nothing settled", () => {
    const send = pendingSend("hello", []);
    const list = [send];
    expect(settlePendingSendList(list, [agentEvent(1, "hi")])).toBe(list);
  });

  it("replaces the list when something settled", () => {
    const send = pendingSend("hello", []);
    const list = [send];
    const next = settlePendingSendList(list, [userEvent(1, "hello")]);
    expect(next).not.toBe(list);
    expect(next).toEqual([]);
  });
});
