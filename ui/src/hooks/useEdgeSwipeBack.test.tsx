// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEdgeSwipeBack } from "./useEdgeSwipeBack";

/**
 * KIN-CONTINUE-002: the left-edge gesture is Back, and it follows the finger.
 *
 * It replaced the drawer's edge swipe. The gesture must commit on a rightward
 * drag past the threshold or a rightward fling, and must leave vertical
 * scrolling, leftward row swipes, and gestures that start away from the edge
 * alone. While a rightward drag is active the hook exposes the distance the
 * page should travel, so the screen moves with the finger instead of staying
 * frozen until release.
 *
 * jsdom has no PointerEvent constructor; a MouseEvent carries the coordinates
 * React reads, and `pointerType` stays undefined so the mouse guard does not
 * fire. The shared `moveVelocity` tests cover the fling math; the fling case
 * here only proves the release path still commits and clears the offset.
 */
function Harness({
  enabled = true,
  onBack,
}: {
  enabled?: boolean;
  onBack: () => void;
}) {
  const { handlers, offset, dragging } = useEdgeSwipeBack(enabled, onBack);
  return (
    <div
      data-testid="edge"
      data-offset={offset}
      data-dragging={dragging ? "1" : "0"}
      style={{ position: "fixed", left: 0, width: 20 }}
      {...handlers}
    />
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
  // fireEvent does not let us set timeStamp; a helper below defines it on the
  // native event for the one test that needs the fling path.
  void time;
}

/** A pointer event whose timestamp this test owns, for the fling path. */
function pointerAt(node: Element, type: string, clientX: number, timeStamp: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 20,
    button: 0,
  });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  fireEvent(node, event);
}

/** px the page is asked to travel right, read from the hook's exposed state. */
function offset(): number {
  return Number(screen.getByTestId("edge").getAttribute("data-offset"));
}

function dragging(): boolean {
  return screen.getByTestId("edge").getAttribute("data-dragging") === "1";
}

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function stubReducedMotion(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
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

  it("exposes a positive bounded offset while a rightward edge drag is active", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", 30);
    const first = offset();
    expect(first).toBeGreaterThan(0);
    expect(dragging()).toBe(true);

    // Well past a third of the viewport: the page must not be dragged off
    // screen, and a cancelling rebound must not have a screen of distance to
    // travel.
    pointer(edge, "pointermove", 900);
    expect(offset()).toBeGreaterThan(first);
    expect(offset()).toBeLessThanOrEqual(Math.ceil(window.innerWidth / 3));
    expect(onBack).not.toHaveBeenCalled();
  });

  it("returns the offset to zero without navigating below the commit threshold", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", 40);
    expect(offset()).toBeGreaterThan(0);
    pointer(edge, "pointerup", 40);

    expect(offset()).toBe(0);
    expect(dragging()).toBe(false);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("clears the offset and does not navigate when the active drag is cancelled", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", 40);
    expect(offset()).toBeGreaterThan(0);
    pointer(edge, "pointercancel", 40);

    expect(offset()).toBe(0);
    expect(dragging()).toBe(false);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("commits once and clears the offset on a threshold or fling release", () => {
    const onBack = vi.fn();
    const first = render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", 90);
    expect(offset()).toBeGreaterThan(0);
    pointer(edge, "pointerup", 90);

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(offset()).toBe(0);
    first.unmount();

    // A short, fast rightward flick commits before the distance threshold.
    const flingBack = vi.fn();
    render(<Harness onBack={flingBack} />);
    const flingEdge = screen.getByTestId("edge");
    pointerAt(flingEdge, "pointerdown", 5, 1000);
    pointerAt(flingEdge, "pointermove", 20, 1100);
    pointerAt(flingEdge, "pointermove", 35, 1120);
    pointerAt(flingEdge, "pointerup", 35, 1125);

    expect(flingBack).toHaveBeenCalledTimes(1);
    expect(offset()).toBe(0);
  });

  it("keeps reduced-motion gestures stationary while still committing on release", () => {
    stubReducedMotion(true);
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", 30);
    pointer(edge, "pointermove", 90);
    expect(offset()).toBe(0);
    pointer(edge, "pointerup", 90);

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(offset()).toBe(0);
  });

  it("clears active movement when disabled or unmounted", () => {
    const onBack = vi.fn();
    const view = render(<Harness enabled onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", 40);
    expect(offset()).toBeGreaterThan(0);

    // The route stops owning the gesture (the list page is now underneath):
    // whatever the finger does next must not keep a page offset alive.
    view.rerender(<Harness enabled={false} onBack={onBack} />);
    expect(offset()).toBe(0);
    expect(dragging()).toBe(false);

    view.unmount();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("does not go back when the drag is mostly vertical", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5, 20);
    pointer(edge, "pointermove", 20, 120);
    expect(offset()).toBe(0);
    pointer(edge, "pointerup", 20, 120);

    expect(onBack).not.toHaveBeenCalled();
  });

  it("does not mistake a leftward row swipe for Back", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const edge = screen.getByTestId("edge");

    pointer(edge, "pointerdown", 5);
    pointer(edge, "pointermove", -40);
    expect(offset()).toBe(0);
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
