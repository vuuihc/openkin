// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TaskEvent } from "../../api/client";
import { setLocale, t } from "../../i18n";
import ChatStream from "./ChatStream";

/**
 * A Stop on an adapter that records no cancel error and no result still has to
 * leave a line in the transcript: the toast is gone on reload, and the reader
 * is left with an answer that simply stops. The task's terminal status is the
 * durable fact the line is derived from.
 */

function typedEvent(seq: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "t1", event_epoch: 0, seq, ts: seq, type, payload };
}

/** The claude-code / fake-agent shape: a started round that just stops. */
const silentlyStopped = (): TaskEvent[] => [
  typedEvent(1, "message", {
    role: "user",
    speaker: "user",
    content: [{ type: "text", text: "写个方案" }],
  }),
  typedEvent(2, "task_started", {}),
  typedEvent(3, "message", {
    role: "assistant",
    speaker: "kin",
    partial: true,
    message_id: "m1",
    index: 0,
    content: [{ type: "text", text: "我先看一遍代码" }],
  }),
  typedEvent(4, "tool_use", {
    speaker: "kin",
    tool_use_id: "call-1",
    name: "bash",
    visibility: { user: true, task: true },
  }),
];

describe("a stopped round the adapter never recorded", () => {
  it("closes the round from the task's canceled status", () => {
    setLocale("zh");
    try {
      const { container } = render(
        <ChatStream
          events={silentlyStopped()}
          hostSpeaker="kin"
          loading={false}
          taskStatus="canceled"
        />,
      );

      expect(screen.getByText(t("chat.stoppedNote"))).toBeTruthy();
      expect(container.textContent).toContain("已停止本轮");
      // The cut half of the answer stays readable above the line.
      expect(container.textContent).toContain("我先看一遍代码");
    } finally {
      setLocale("en");
    }
  });

  it("shows no line while the task is live or ended another way", () => {
    const { container, rerender } = render(
      <ChatStream events={silentlyStopped()} hostSpeaker="kin" loading taskStatus="canceled" />,
    );
    expect(screen.queryByText(t("chat.stoppedNote"))).toBeNull();

    rerender(
      <ChatStream
        events={silentlyStopped()}
        hostSpeaker="kin"
        loading={false}
        taskStatus="succeeded"
      />,
    );
    expect(screen.queryByText(t("chat.stoppedNote"))).toBeNull();
    expect(container.textContent).toContain("我先看一遍代码");
  });
});
