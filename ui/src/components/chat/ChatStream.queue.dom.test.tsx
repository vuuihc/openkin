// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

function userEventFor(seq: number, text: string): TaskEvent {
  return event(seq, "message", { role: "user", content: [{ type: "text", text }] });
}

/** The transcript row that carries this message text. */
function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest("[data-message-key]") as HTMLElement;
}

function placeOf(text: string): string | null {
  return rowOf(text).querySelector("[data-queue-place]")?.textContent ?? null;
}

describe("ordering a queued message", () => {
  const first = userEventFor(1, "first thought");
  const second = userEventFor(2, "second thought");
  const third = userEventFor(3, "third thought");
  const threeQueued = new Set([1, 2, 3]);
  const threePositions = new Map([
    [1, 1],
    [2, 2],
    [3, 3],
  ]);

  it("shows each queued message's place in line when more than one is waiting", () => {
    // The queue array is the daemon's delivery order; these numbers are the
    // only thing on screen that says which instruction the agent answers next.
    const { rerender } = render(
      <ChatStream
        events={[first, second]}
        hostSpeaker="kin"
        queuedSeqs={new Set([1, 2])}
        queuePositions={
          new Map([
            [1, 1],
            [2, 2],
          ])
        }
        queueLength={2}
        onUnqueue={vi.fn()}
      />,
    );

    expect(placeOf("first thought")).toBe("1");
    expect(placeOf("second thought")).toBe("2");
    // The pill's own label stays its own node, so the existing text (and the
    // name a screen reader hears) survives the number.
    expect(within(rowOf("first thought")).getByText(t("chat.queued"))).toBeTruthy();

    // One waiting message has no order to explain.
    rerender(
      <ChatStream
        events={[first]}
        hostSpeaker="kin"
        queuedSeqs={new Set([1])}
        queuePositions={new Map([[1, 1]])}
        queueLength={1}
        onUnqueue={vi.fn()}
      />,
    );
    expect(placeOf("first thought")).toBeNull();
    expect(within(rowOf("first thought")).getByText(t("chat.queued"))).toBeTruthy();
  });

  it("moves a queued message through the daemon's order call", () => {
    // The row owns the intent, the page owns the call: a row that re-sorted
    // itself would show an order the daemon has not accepted yet.
    const onMoveQueued = vi.fn();
    render(
      <ChatStream
        events={[first, second, third]}
        hostSpeaker="kin"
        queuedSeqs={threeQueued}
        queuePositions={threePositions}
        queueLength={3}
        onUnqueue={vi.fn()}
        onMoveQueued={onMoveQueued}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: t("chat.moveQueuedDownNamed", { text: "second thought" }),
      }),
    );
    expect(onMoveQueued).toHaveBeenCalledWith(2, 1);

    fireEvent.click(
      screen.getByRole("button", {
        name: t("chat.moveQueuedUpNamed", { text: "third thought" }),
      }),
    );
    expect(onMoveQueued).toHaveBeenLastCalledWith(3, -1);

    // Still the daemon's numbers: the answer to the call is what moves them.
    expect(placeOf("first thought")).toBe("1");
    expect(placeOf("second thought")).toBe("2");
    expect(placeOf("third thought")).toBe("3");
  });

  it("the first queued message offers no move-up and the last offers no move-down", () => {
    render(
      <ChatStream
        events={[first, second, third]}
        hostSpeaker="kin"
        queuedSeqs={threeQueued}
        queuePositions={threePositions}
        queueLength={3}
        onUnqueue={vi.fn()}
        onMoveQueued={vi.fn()}
      />,
    );

    const up = (text: string) =>
      screen.queryByRole("button", { name: t("chat.moveQueuedUpNamed", { text }) });
    const down = (text: string) =>
      screen.queryByRole("button", { name: t("chat.moveQueuedDownNamed", { text }) });

    expect(up("first thought")).toBeNull();
    expect(down("first thought")).toBeTruthy();
    expect(up("third thought")).toBeTruthy();
    expect(down("third thought")).toBeNull();
  });

  it("the move controls are keyboard reachable and named with the message excerpt", () => {
    const long = "a queued instruction long enough to need an excerpt";
    render(
      <ChatStream
        events={[first, second, userEventFor(3, long)]}
        hostSpeaker="kin"
        queuedSeqs={threeQueued}
        queuePositions={threePositions}
        queueLength={3}
        onUnqueue={vi.fn()}
        onMoveQueued={vi.fn()}
      />,
    );

    const excerpt = "a queued instruction lon…";
    const up = screen.getByRole("button", {
      name: t("chat.moveQueuedUpNamed", { text: excerpt }),
    });
    // A real button, so Tab reaches it and Enter/Space operate it; the ring is
    // the same token the sibling controls use.
    expect(up.tagName).toBe("BUTTON");
    expect(up.getAttribute("type")).toBe("button");
    expect(up.className).toContain("focus-visible:ring-2");
    expect(up.className).toContain("ring-kin-focus-ring");
    up.focus();
    expect(document.activeElement).toBe(up);

    // The name carries the message, so two queued rows are two controls and
    // not two identical "move" entries in a screen reader's list.
    expect(
      screen.getByRole("button", { name: t("chat.moveQueuedUpNamed", { text: "second thought" }) }),
    ).toBeTruthy();
  });

  it("a transcript the caller only reads shows the place but offers no arrows", () => {
    render(
      <ChatStream
        events={[first, second, third]}
        hostSpeaker="kin"
        queuedSeqs={threeQueued}
        queuePositions={threePositions}
        queueLength={3}
        onMoveQueued={vi.fn()}
      />,
    );

    expect(placeOf("second thought")).toBe("2");
    expect(
      screen.queryByRole("button", {
        name: t("chat.moveQueuedDownNamed", { text: "second thought" }),
      }),
    ).toBeNull();
  });
});

describe("keyboard focus while moving a queued message", () => {
  const first = userEventFor(1, "first thought");
  const second = userEventFor(2, "second thought");
  const third = userEventFor(3, "third thought");
  const threeQueued = new Set([1, 2, 3]);

  function renderQueue(positions: Map<number, number>) {
    return render(
      <ChatStream
        events={[first, second, third]}
        hostSpeaker="kin"
        queuedSeqs={threeQueued}
        queuePositions={positions}
        queueLength={3}
        onUnqueue={vi.fn()}
        onMoveQueued={vi.fn()}
      />,
    );
  }

  const upOf = (text: string) =>
    screen.getByRole("button", { name: t("chat.moveQueuedUpNamed", { text }) });
  const downOf = (text: string) =>
    screen.getByRole("button", { name: t("chat.moveQueuedDownNamed", { text }) });

  it("follows a move into first place to the down arrow that survives", () => {
    const view = renderQueue(
      new Map([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    );
    // Enter/Space on a focused button dispatches a click with the button still
    // focused; moving into place 1 unmounts that up arrow.
    const up = upOf("second thought");
    up.focus();
    fireEvent.click(up);

    view.rerender(
      <ChatStream
        events={[first, second, third]}
        hostSpeaker="kin"
        queuedSeqs={threeQueued}
        queuePositions={
          new Map([
            [1, 2],
            [2, 1],
            [3, 3],
          ])
        }
        queueLength={3}
        onUnqueue={vi.fn()}
        onMoveQueued={vi.fn()}
      />,
    );

    // The badge moved, the focused control did not disappear: focus lands on
    // the arrow that is still there instead of falling to <body>.
    expect(placeOf("second thought")).toBe("1");
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(downOf("second thought"));
  });

  it("follows a move into last place to the up arrow that survives", () => {
    const view = renderQueue(
      new Map([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    );
    const down = downOf("second thought");
    down.focus();
    fireEvent.click(down);

    view.rerender(
      <ChatStream
        events={[first, second, third]}
        hostSpeaker="kin"
        queuedSeqs={threeQueued}
        queuePositions={
          new Map([
            [1, 1],
            [3, 2],
            [2, 3],
          ])
        }
        queueLength={3}
        onUnqueue={vi.fn()}
        onMoveQueued={vi.fn()}
      />,
    );

    expect(placeOf("second thought")).toBe("3");
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(upOf("second thought"));
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
