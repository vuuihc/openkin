// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TaskEvent } from "../../api/client";
import { t } from "../../i18n";
import ChatStream from "./ChatStream";

function event(seq: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "task-queue", event_epoch: 0, seq, ts: seq, type, payload };
}

const waiting = event(1, "message", {
  role: "user",
  content: [{ type: "text", text: "hold that thought" }],
});

describe("withdrawing a queued message", () => {
  it("offers the control on a message that is still waiting", () => {
    const onUnqueue = vi.fn();
    render(
      <ChatStream
        events={[waiting]}
        hostSpeaker="kin"
        queuedSeqs={new Set([1])}
        onUnqueue={onUnqueue}
      />,
    );

    expect(screen.getByText(t("chat.queued"))).toBeTruthy();
    // The name carries the message, so a screen-reader user with several queued
    // messages can tell the controls apart instead of hearing "withdraw" three
    // times.
    fireEvent.click(
      screen.getByRole("button", {
        name: t("chat.withdrawNamed", { text: "hold that thought" }),
      }),
    );
    // The seq, not the row key: the queue row is anchored to the message event.
    expect(onUnqueue).toHaveBeenCalledWith(1);
  });

  it("hides the control where nothing can be withdrawn", () => {
    // A message that has been answered has no control to offer...
    const { rerender } = render(
      <ChatStream
        events={[waiting]}
        hostSpeaker="kin"
        queuedSeqs={new Set()}
        onUnqueue={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: t("chat.withdrawNamed", { text: "hold that thought" }),
      }),
    ).toBeNull();

    // ...and neither does a queued one in a transcript the caller only reads.
    rerender(<ChatStream events={[waiting]} hostSpeaker="kin" queuedSeqs={new Set([1])} />);
    expect(screen.getByText(t("chat.queued"))).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: t("chat.withdrawNamed", { text: "hold that thought" }),
      }),
    ).toBeNull();
  });

  it("drops the control when the caller stops offering it, with the message unchanged", () => {
    // The row is memoized on a comparator that compares presence, not identity.
    // If it ignored the prop, a queued message that keeps its badge but loses
    // the action would keep the old button — or, coming back, never get one.
    const withdrawButton = () =>
      screen.queryByRole("button", {
        name: t("chat.withdrawNamed", { text: "hold that thought" }),
      });
    const { rerender } = render(
      <ChatStream
        events={[waiting]}
        hostSpeaker="kin"
        queuedSeqs={new Set([1])}
        onUnqueue={vi.fn()}
      />,
    );
    expect(withdrawButton()).toBeTruthy();

    rerender(<ChatStream events={[waiting]} hostSpeaker="kin" queuedSeqs={new Set([1])} />);
    expect(screen.getByText(t("chat.queued"))).toBeTruthy();
    expect(withdrawButton()).toBeNull();

    rerender(
      <ChatStream
        events={[waiting]}
        hostSpeaker="kin"
        queuedSeqs={new Set([1])}
        onUnqueue={vi.fn()}
      />,
    );
    expect(withdrawButton()).toBeTruthy();
  });
});

describe("queued row tap targets", () => {
  it("keeps the queued row actions on the phone tap floor instead of the mini opt-out", () => {
    render(
      <ChatStream
        events={[waiting]}
        hostSpeaker="kin"
        queuedSeqs={new Set([1])}
        onUnqueue={vi.fn()}
        onEditQueued={vi.fn()}
      />,
    );

    // The floor is `.touch-lg button:not([data-touch-mini])` in index.css:
    // inside that media query, any button under the console's `.touch-lg` roots
    // gets a 44px phone target unless it opts out by name. These two sit in a
    // `排队中` badge on a primary mid-run surface, and
    // one of them discards the message, so a thumb a few pixels off the 10px
    // glyph has to land inside the target rather than beside it. The opt-out's
    // sanctioned home is a control on a tile too small to grow, not this row.
    for (const name of [
      t("chat.withdrawNamed", { text: "hold that thought" }),
      t("chat.editQueuedNamed", { text: "hold that thought" }),
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button.hasAttribute("data-touch-mini")).toBe(false);
      expect(button.className).not.toContain("touch-mini");
    }
  });
});

describe("editing a queued message", () => {
  const editButton = () =>
    screen.queryByRole("button", {
      name: t("chat.editQueuedNamed", { text: "hold that thought" }),
    });

  it("offers the control beside the withdraw control and passes the seq", () => {
    const onEditQueued = vi.fn();
    render(
      <ChatStream
        events={[waiting]}
        hostSpeaker="kin"
        queuedSeqs={new Set([1])}
        onUnqueue={vi.fn()}
        onEditQueued={onEditQueued}
      />,
    );

    // Two controls with two names: a reader hears which one edits and which
    // one throws the message away.
    expect(
      screen.getByRole("button", { name: t("chat.withdrawNamed", { text: "hold that thought" }) }),
    ).toBeTruthy();
    fireEvent.click(editButton()!);
    expect(onEditQueued).toHaveBeenCalledWith(1);
  });

  it("is absent until the caller offers it", () => {
    // Same presence rule as the ×: a transcript the caller only reads has
    // neither control, and the memoized row has to notice one arriving.
    const { rerender } = render(
      <ChatStream
        events={[waiting]}
        hostSpeaker="kin"
        queuedSeqs={new Set([1])}
        onUnqueue={vi.fn()}
      />,
    );
    expect(editButton()).toBeNull();

    rerender(
      <ChatStream
        events={[waiting]}
        hostSpeaker="kin"
        queuedSeqs={new Set([1])}
        onUnqueue={vi.fn()}
        onEditQueued={vi.fn()}
      />,
    );
    expect(editButton()).toBeTruthy();
  });
});
