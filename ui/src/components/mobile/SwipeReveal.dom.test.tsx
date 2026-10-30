// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import SwipeReveal from "./SwipeReveal";
import SessionRowActions, { SESSION_ROW_ACTIONS_WIDTH } from "./SessionRowActions";

/**
 * The reveal is sized by the actions a row actually carries. A strip wider
 * than the slide leaves its last chip under the row's own opaque cover —
 * mounted, clickable in the DOM, and invisible. The slide and the strip come
 * from one number, and that number has to equal the chips it uncovers, so
 * this measures the real chips rather than trusting the constant.
 */
describe("SwipeReveal width", () => {
  it("slides the cover exactly as far as the actions it uncovers are wide", () => {
    const { container } = render(
      <SwipeReveal
        open
        onOpenChange={() => {}}
        width={SESSION_ROW_ACTIONS_WIDTH}
        actions={<SessionRowActions onPin={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />}
      >
        <span>row</span>
      </SwipeReveal>,
    );

    const chips = screen.getAllByRole("button");
    const measured = chips.reduce(
      (sum, chip) => sum + parseFloat((chip as HTMLElement).style.width),
      0,
    );
    expect(chips).toHaveLength(3);
    expect(measured).toBe(SESSION_ROW_ACTIONS_WIDTH);
    expect(parseFloat(chips[0].parentElement!.style.width)).toBe(measured);

    // The last child is the opaque cover the row sits on.
    const cover = container.firstElementChild?.lastElementChild as HTMLElement;
    expect(cover.style.transform).toBe(`translateX(-${measured}px)`);
  });

  it("leaves a closed row where it was", () => {
    const { container } = render(
      <SwipeReveal
        open={false}
        onOpenChange={() => {}}
        width={SESSION_ROW_ACTIONS_WIDTH}
        actions={null}
      >
        <span>row</span>
      </SwipeReveal>,
    );
    const cover = container.firstElementChild?.lastElementChild as HTMLElement;
    expect(cover.style.transform).toBe("translateX(0px)");
  });
});

/**
 * Who receives the click.
 *
 * A captured pointer reports its `pointerup` — and per the pointer-events
 * specification the `click` derived from it — to the element that took the
 * capture, not the button under the finger. Taking capture on pointerdown
 * therefore made every tap inside the row land on this wrapper: the row could
 * not be opened and its action chips could not be pressed, while the DOM and
 * every class-based test looked correct. Capture belongs to a drag, which is
 * the only gesture that needs moves after the pointer leaves the row.
 *
 * jsdom does not retarget clicks the way a browser does, so the guard is the
 * capture call itself: it must not happen on pointerdown, and must happen
 * once the drag moves.
 */
describe("SwipeReveal gestures", () => {
  // A mouse event carries the client coordinates React reads; jsdom has no
  // PointerEvent constructor, and React listens for the native type either
  // way. `pointerType` stays undefined, so the left-button guard passes.
  function pointer(node: Element, type: string, clientX: number, clientY = 20) {
    fireEvent(
      node,
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
      }),
    );
  }

  function setup(onLongPress?: () => void, open = false) {
    const onClick = vi.fn();
    const onOpenChange = vi.fn();
    const { container } = render(
      <SwipeReveal
        open={open}
        onOpenChange={onOpenChange}
        onLongPress={onLongPress}
        actions={null}
      >
        <button type="button" onClick={onClick}>
          Open
        </button>
      </SwipeReveal>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    const capture = vi.fn();
    wrapper.setPointerCapture = capture;
    const button = screen.getByRole("button", { name: "Open" });
    return { capture, button, onClick, onOpenChange };
  }

  it("leaves a tap to the button inside the row", () => {
    const { capture, button, onClick } = setup();

    pointer(button, "pointerdown", 200);
    pointer(button, "pointerup", 200);
    fireEvent.click(button);

    // No capture on pointerdown: in a browser that would retarget the click
    // away from the button, and nothing in the row would be tappable.
    expect(capture).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("takes the pointer once the drag actually moves", () => {
    const { capture, button, onOpenChange } = setup();

    pointer(button, "pointerdown", 200);
    expect(capture).not.toHaveBeenCalled();
    pointer(button, "pointermove", 100);
    expect(capture).toHaveBeenCalledTimes(1);

    pointer(button, "pointerup", 100);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("swallows the click that ends a drag", () => {
    const { button, onClick } = setup();

    pointer(button, "pointerdown", 200);
    pointer(button, "pointermove", 100);
    pointer(button, "pointerup", 100);
    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });

  it("swallows the click that ends a long press", () => {
    // The press already selected the row; the click that follows the lift
    // would toggle that selection straight back off.
    vi.useFakeTimers();
    try {
      const onLongPress = vi.fn();
      const { button, onClick } = setup(onLongPress);

      pointer(button, "pointerdown", 200);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(onLongPress).toHaveBeenCalledTimes(1);

      pointer(button, "pointerup", 200);
      fireEvent.click(button);
      expect(onClick).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
