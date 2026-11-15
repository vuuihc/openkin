// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TaskEvent } from "../../api/client";
import { setLocale, t } from "../../i18n";
import ChatStream from "./ChatStream";

/**
 * The local copy of a send is an ordinary user bubble at the end of the stream,
 * and the waiting row is drawn under it — not folded into the previous agent
 * turn, which would put "thinking" above the message it is answering.
 */

function agentMessage(seq: number, text: string): TaskEvent {
  return {
    task_id: "t1",
    event_epoch: 0,
    seq,
    ts: seq,
    type: "message",
    payload: { role: "assistant", speaker: "kin", content: [{ type: "text", text }] },
  };
}

describe("a pending send in the stream", () => {
  it("draws the bubble after the last turn and the waiting row after it", () => {
    setLocale("en");
    const { container } = render(
      <ChatStream
        events={[agentMessage(1, "ready when you are")]}
        hostSpeaker="kin"
        loading
        pendingUserMessages={[{ key: "pending-1", text: "hello" }]}
      />,
    );

    const bubble = screen.getByText("hello");
    const thinking = screen.getByRole("status", { name: t("chat.thinking") });
    expect(bubble).toBeTruthy();
    expect(thinking).toBeTruthy();
    // Document order is what the reader sees: the message, then the wait.
    expect(
      bubble.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.textContent).toContain("ready when you are");
  });

  it("shows no waiting row when the caller is not loading", () => {
    setLocale("en");
    render(
      <ChatStream
        events={[]}
        hostSpeaker="kin"
        pendingUserMessages={[{ key: "pending-1", text: "hello" }]}
      />,
    );
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.queryByRole("status", { name: t("chat.thinking") })).toBeNull();
  });
});
