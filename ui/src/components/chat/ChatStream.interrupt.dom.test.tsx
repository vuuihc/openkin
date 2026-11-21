// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TaskEvent } from "../../api/client";
import { setLocale, t } from "../../i18n";
import ChatStream from "./ChatStream";

/**
 * A round cut short by an interrupt has to leave a line in the transcript, not
 * only a toast: the toast is gone on reload, and the reader is left with a
 * question that never got answered.
 */

function event(seq: number, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "t1", event_epoch: 0, seq, ts: seq, type: "message", payload };
}

function typedEvent(seq: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "t1", event_epoch: 0, seq, ts: seq, type, payload };
}

describe("an interrupted round in the stream", () => {
  it("shows the interrupt mark in the transcript", () => {
    setLocale("zh");
    try {
      const { container } = render(
        <ChatStream
          events={[
            event(1, { role: "user", content: [{ type: "text", text: "写个方案" }] }),
            event(2, {
              role: "assistant",
              speaker: "kin",
              partial: true,
              message_id: "m1",
              index: 0,
              content: [{ type: "text", text: "我先看一遍代码" }],
            }),
            event(3, {
              role: "user",
              speaker: "user",
              content: [{ type: "text", text: "等等，换个方向" }],
              source: "interrupt",
              interrupted: true,
            }),
          ]}
          hostSpeaker="kin"
        />,
      );

      expect(screen.getByText(t("chat.interruptedNote"))).toBeTruthy();
      expect(container.textContent).toContain("已打断");
      // The cut round's text and the message that cut it both stay.
      expect(container.textContent).toContain("我先看一遍代码");
      expect(container.textContent).toContain("等等，换个方向");
    } finally {
      setLocale("en");
    }
  });

  it("keeps the interrupt mark when a queued follow-up sits above it", () => {
    setLocale("zh");
    try {
      const { container } = render(
        <ChatStream
          events={[
            event(1, { role: "user", content: [{ type: "text", text: "写个方案" }] }),
            typedEvent(2, "task_started", {}),
            event(3, {
              role: "assistant",
              speaker: "kin",
              partial: true,
              message_id: "m1",
              index: 0,
              content: [{ type: "text", text: "我先看一遍代码" }],
            }),
            // Queued while the round above was still running: it has not started
            // a round of its own, so the round a later interrupt cuts is still
            // the one `task_started` opened.
            event(4, {
              role: "user",
              speaker: "user",
              content: [{ type: "text", text: "再加一节" }],
              source: "follow_up",
            }),
            event(5, {
              role: "user",
              speaker: "user",
              content: [{ type: "text", text: "等等，换个方向" }],
              source: "interrupt",
              interrupted: true,
            }),
          ]}
          hostSpeaker="kin"
        />,
      );

      const mark = screen.getByText(t("chat.interruptedNote"));
      const interrupting = screen.getByText("等等，换个方向");
      // The mark closes the cut round: it sits above the message that cut it,
      // not below it and not nowhere.
      expect(
        mark.compareDocumentPosition(interrupting) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // The cut answer and both prompts remain readable.
      expect(container.textContent).toContain("我先看一遍代码");
      expect(container.textContent).toContain("再加一节");
      expect(container.textContent).toContain("写个方案");
    } finally {
      setLocale("en");
    }
  });
});
