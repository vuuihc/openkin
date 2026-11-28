// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TaskEvent } from "../../api/client";
import { setLocale, t } from "../../i18n";
import ChatStream from "./ChatStream";

/**
 * A Stop on a round with a queued follow-up discards that follow-up on
 * purpose, and the daemon reports the count on the "error" channel. The report
 * has to stay — the queued message must not silently vanish — but a deliberate
 * stop is not a failure: the line reads like "Stopped this round", in the
 * reader's language, with the real count and the word "conversation".
 */

function typedEvent(seq: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "t1", event_epoch: 0, seq, ts: seq, type, payload };
}

/** A running round with one follow-up queued, then the discard report. */
const discardEvents = (count: number): TaskEvent[] => [
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
  typedEvent(4, "message", {
    role: "user",
    speaker: "user",
    content: [{ type: "text", text: "排队一条追问" }],
    source: "follow_up",
  }),
  typedEvent(5, "error", {
    message: `${count} queued prompt(s) discarded with the canceled task`,
    count,
  }),
];

describe("the queued-message discard report in the stream", () => {
  it("R-stop-discard-copy: the discard report reads as a quiet localized note in zh", () => {
    setLocale("zh");
    try {
      const { container } = render(<ChatStream events={discardEvents(1)} hostSpeaker="kin" />);

      const note = screen.getByText("已丢弃 1 条排队消息");
      // The quiet meta line, not the red error block.
      expect(note.className).toContain("text-kin-muted");
      expect(container.querySelector(".text-kin-red-ink")).toBeNull();
      expect(container.querySelector(".bg-kin-red\\/10")).toBeNull();
      // The daemon's English sentence does not reach the reader.
      expect(container.textContent).not.toContain("queued prompt(s) discarded");
      // The queued message it reports on is still on screen.
      expect(container.textContent).toContain("排队一条追问");
    } finally {
      setLocale("en");
    }
  });

  it("R-stop-discard-copy: the en note names the conversation, not a task", () => {
    setLocale("en");
    const { container } = render(<ChatStream events={discardEvents(2)} hostSpeaker="kin" />);

    const note = screen.getByText(/queued messages discarded/);
    expect(note.textContent).toContain("2");
    expect(note.textContent).toContain("conversation");
    expect(note.textContent).not.toContain("task");
    expect(container.querySelector(".text-kin-red-ink")).toBeNull();
    expect(container.textContent).not.toContain("queued prompt(s) discarded");
  });

  it("R-stop-discard-copy: an ordinary error still renders as an error", () => {
    // The guard against widening the match: a failure with a count is still a
    // failure and keeps the red block.
    const { container } = render(
      <ChatStream
        events={[
          typedEvent(1, "message", {
            role: "user",
            speaker: "user",
            content: [{ type: "text", text: "写个方案" }],
          }),
          typedEvent(2, "error", { message: "boom", count: 2 }),
        ]}
        hostSpeaker="kin"
      />,
    );

    expect(screen.getByText("boom").className).toContain("text-kin-red-ink");
    expect(container.textContent).not.toContain(t("chat.discardedPrompts", { count: 2 }));
  });
});
