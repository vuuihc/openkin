// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEdgeSwipeBack } from "./useEdgeSwipeBack";

/**
 * KIN-CONTINUE-002: the left-edge gesture is Back.
 *
 * It replaced the drawer's edge swipe. The gesture must commit on a rightward
 * drag past the threshold or a rightward fling, and must leave vertical
 * scrolling, leftward row swipes, and gestures that start away from the edge
 * alone. jsdom has no PointerEvent constructor; a MouseEvent carries the
 * coordinates React reads, and `pointerType` stays undefined so the mouse
 * guard does not fire.
 */
function Harness({
  enabled = true,
  onBack,
}: {
  enabled?: boolean;
  onBack: () => void;
}) {
  const props = useEdgeSwipeBack(enabled, onBack);
  return (
    <div data-testid="edge" style={{ position: "fixed", left: 0, width: 20 }} {...props} />
  );
}

function pointer(node: Element, type: string, clientX: number, clientY = 20, time = 0) {
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
  // fireEvent does not let us set timeStamp; distance is the commit path the
  // tests exercise, and the fling path is covered by the shared gesture math.
  void time;
}

describe("useEdgeSwipeBack", () => {
  it("goes back on a rightward edge drag past the threshold", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", 40);
    pointer(edge, "pointermove", 90);
    pointer(edge, "pointerup", 90);

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("does not go back when the drag is mostly vertical", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5, 20);
    pointer(edge, "pointermove", 20, 120);
    pointer(edge, "pointerup", 20, 120);

    expect(onBack).not.toHaveBeenCalled();
  });

  it("does not mistake a leftward row swipe for Back", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", -40);
    pointer(edge, "pointerup", -40);

    expect(onBack).not.toHaveBeenCalled();
  });

  it("ignores a gesture that starts away from the edge", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 60);
    pointer(edge, "pointermove", 140);
    pointer(edge, "pointerup", 140);

    expect(onBack).not.toHaveBeenCalled();
  });

  it("treats a cancelled pointer as an abort, not a Back", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", 90);
    // The OS edge gesture (or the browser) claimed the touch. Committing here
    // would pop a second screen on top of the system's own Back.
    pointer(edge, "pointercancel", 90);

    expect(onBack).not.toHaveBeenCalled();
  });

  it("ignores a mouse drag from the edge", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    // jsdom has no PointerEvent constructor; a plain Event with the pointer
    // fields React reads is enough to exercise the guard.
    const mouse = (type: string, clientX: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { clientX, clientY: 20, button: 0, pointerId: 1, pointerType: "mouse" });
      fireEvent(edge, event);
    };
    mouse("pointerdown", 5);
    mouse("pointermove", 140);
    mouse("pointerup", 140);

    expect(onBack).not.toHaveBeenCalled();
  });

  it("is inert on the list page, which has no parent", () => {
    const onBack = vi.fn();
    render(<Harness enabled={false} onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", 120);
    pointer(edge, "pointerup", 120);

    expect(onBack).not.toHaveBeenCalled();
  });
});
