// @vitest-environment jsdom
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDrawerSwipe } from "./useDrawerSwipe";

/**
 * The drawer is the phone's navigation, and its gestures are the difference
 * between "a panel that was opened" and "a panel that came from the edge".
 * These tests drive the hook's own surface: a strip for the edge, a box for
 * the open drawer, and the pointer events a finger would produce.
 */

function Harness({
  initialOpen = false,
  onOpenChange,
}: {
  initialOpen?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const swipe = useDrawerSwipe(open, (next) => {
    setOpen(next);
    onOpenChange(next);
  });
  return (
    <div>
      {!swipe.mounted && (
        <div
          data-testid="edge"
          style={{ position: "absolute", left: 0, top: 0, width: 20, height: 400 }}
          {...swipe.edgeProps}
        />
      )}
      {swipe.mounted && (
        <div data-testid="drawer" {...swipe.drawerProps}>
          <span data-testid="progress">{swipe.progress}</span>
        </div>
      )}
    </div>
  );
}

function pointer(
  node: Element,
  type: string,
  clientX: number,
  clientY = 20,
  pointerType = "touch",
) {
  // jsdom has no PointerEvent; React listens for the native type either way.
  // `pointerType` is defined explicitly because the hook must ignore mice.
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(node, event);
}

describe("useDrawerSwipe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the drawer when an edge drag passes the threshold", () => {
    vi.useFakeTimers();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    pointer(screen.getByTestId("edge"), "pointerdown", 5);
    pointer(screen.getByTestId("edge"), "pointermove", 100);
    // The drawer mounts as soon as the drag starts; the rest of the gesture
    // arrives over it, exactly as it would under the finger.
    const drawer = screen.getByTestId("drawer");
    pointer(drawer, "pointermove", 220);
    pointer(drawer, "pointerup", 220);
    act(() => {
      vi.advanceTimersByTime(220);
    });

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByTestId("progress").textContent).toBe("1");
  });

  it("springs back when the drag stops short", () => {
    vi.useFakeTimers();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    pointer(screen.getByTestId("edge"), "pointerdown", 5);
    pointer(screen.getByTestId("edge"), "pointermove", 60);
    const drawer = screen.getByTestId("drawer");
    pointer(drawer, "pointerup", 60);
    act(() => {
      vi.advanceTimersByTime(220);
    });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("drawer")).toBeNull();
  });

  it("leaves a vertical drag to the list behind the edge", () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    pointer(screen.getByTestId("edge"), "pointerdown", 5, 20);
    pointer(screen.getByTestId("edge"), "pointermove", 8, 120);
    pointer(screen.getByTestId("edge"), "pointerup", 8, 120);

    expect(screen.queryByTestId("drawer")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does not mistake a leftward row swipe for the drawer", () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    pointer(screen.getByTestId("edge"), "pointerdown", 10);
    pointer(screen.getByTestId("edge"), "pointermove", -70);
    pointer(screen.getByTestId("edge"), "pointerup", -70);

    expect(screen.queryByTestId("drawer")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("ignores a mouse drag, which would eat text selection", () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    pointer(screen.getByTestId("edge"), "pointerdown", 5, 20, "mouse");
    pointer(screen.getByTestId("edge"), "pointermove", 220, 20, "mouse");
    pointer(screen.getByTestId("edge"), "pointerup", 220, 20, "mouse");

    expect(screen.queryByTestId("drawer")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes an open drawer when it is pushed back past halfway", () => {
    vi.useFakeTimers();
    const onOpenChange = vi.fn();
    render(<Harness initialOpen onOpenChange={onOpenChange} />);

    const drawer = screen.getByTestId("drawer");
    pointer(drawer, "pointerdown", 300);
    pointer(drawer, "pointermove", 150);
    pointer(drawer, "pointermove", 80);
    pointer(drawer, "pointerup", 80);
    act(() => {
      vi.advanceTimersByTime(220);
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("drawer")).toBeNull();
  });

  it("keeps the drawer open when a push is released early", () => {
    vi.useFakeTimers();
    const onOpenChange = vi.fn();
    render(<Harness initialOpen onOpenChange={onOpenChange} />);

    const drawer = screen.getByTestId("drawer");
    pointer(drawer, "pointerdown", 300);
    pointer(drawer, "pointermove", 280);
    pointer(drawer, "pointerup", 280);
    act(() => {
      vi.advanceTimersByTime(220);
    });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("progress").textContent).toBe("1");
  });
});
