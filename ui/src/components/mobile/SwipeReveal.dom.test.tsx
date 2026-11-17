// @vitest-environment jsdom
import { useState } from "react";
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
      <SwipeReveal open={open} onOpenChange={onOpenChange} onLongPress={onLongPress} actions={null}>
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
    // The press opened the row's own sheet; the click that follows the lift
    // would otherwise reach the row underneath the modal and open the
    // conversation (or toggle a selection) the person never asked for.
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

/**
 * Reorder shares the hold with the swipe but owns the vertical axis.
 *
 * A completed hold on a row that can be reordered starts a drag instead of
 * opening the row's sheet; the moves that follow are the drag's, not a
 * horizontal swipe. The wrapper keeps the pointer-capture and click-swallowing
 * rules the swipe already established. Rows whose container offers no reorder
 * keep the old hold behaviour (`onLongPress`).
 */
describe("SwipeReveal reorder", () => {
  function pointer(node: Element, type: string, clientX: number, clientY: number) {
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

  function setup(reorder: {
    onStart: () => void;
    onMove: (clientY: number) => void;
    onEnd: (cancelled: boolean) => void;
  }) {
    const onOpenChange = vi.fn();
    const { container } = render(
      <SwipeReveal open={false} onOpenChange={onOpenChange} reorder={reorder} actions={null}>
        <button type="button">Row</button>
      </SwipeReveal>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    const capture = vi.fn();
    const release = vi.fn();
    wrapper.setPointerCapture = capture;
    wrapper.releasePointerCapture = release;
    return { capture, release, onOpenChange, row: screen.getByRole("button", { name: "Row" }) };
  }

  it("a hold that moves vertically reports a reorder instead of a long press", () => {
    vi.useFakeTimers();
    try {
      const onStart = vi.fn();
      const onMove = vi.fn();
      const onEnd = vi.fn();
      const onLongPress = vi.fn();
      const { container } = render(
        <SwipeReveal
          open={false}
          onOpenChange={() => {}}
          onLongPress={onLongPress}
          reorder={{ onStart, onMove, onEnd }}
          actions={null}
        >
          <button type="button">Row</button>
        </SwipeReveal>,
      );
      container.firstElementChild!.setPointerCapture = vi.fn();
      container.firstElementChild!.releasePointerCapture = vi.fn();
      const row = screen.getByRole("button", { name: "Row" });

      pointer(row, "pointerdown", 200, 20);
      act(() => vi.advanceTimersByTime(500));
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onLongPress).not.toHaveBeenCalled();

      // A vertical move belongs to the drag: it must not become a horizontal
      // reveal, and it must not be read as breaking the hold.
      pointer(row, "pointermove", 202, 80);
      expect(onMove).toHaveBeenCalledWith(80);

      pointer(row, "pointerup", 202, 80);
      expect(onEnd).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hold released without moving still calls onLongPress when no reorder is offered", () => {
    vi.useFakeTimers();
    try {
      const onLongPress = vi.fn();
      const { container } = render(
        <SwipeReveal open={false} onOpenChange={() => {}} onLongPress={onLongPress} actions={null}>
          <button type="button">Row</button>
        </SwipeReveal>,
      );
      container.firstElementChild!.setPointerCapture = vi.fn();
      const row = screen.getByRole("button", { name: "Row" });

      pointer(row, "pointerdown", 200, 20);
      act(() => vi.advanceTimersByTime(500));

      expect(onLongPress).toHaveBeenCalledTimes(1);
      pointer(row, "pointerup", 200, 20);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pointercancel reports the drag as cancelled", () => {
    vi.useFakeTimers();
    try {
      const onStart = vi.fn();
      const onMove = vi.fn();
      const onEnd = vi.fn();
      const { capture, release, row } = setup({ onStart, onMove, onEnd });

      pointer(row, "pointerdown", 200, 20);
      act(() => vi.advanceTimersByTime(500));
      pointer(row, "pointermove", 200, 60);
      pointer(row, "pointercancel", 200, 60);

      expect(capture).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("movement past the tolerance before 500ms cancels the hold", () => {
    vi.useFakeTimers();
    try {
      const onStart = vi.fn();
      const onLongPress = vi.fn();
      const { container } = render(
        <SwipeReveal
          open={false}
          onOpenChange={() => {}}
          onLongPress={onLongPress}
          reorder={{ onStart, onMove: vi.fn(), onEnd: vi.fn() }}
          actions={null}
        >
          <button type="button">Row</button>
        </SwipeReveal>,
      );
      container.firstElementChild!.setPointerCapture = vi.fn();
      const row = screen.getByRole("button", { name: "Row" });

      pointer(row, "pointerdown", 200, 20);
      pointer(row, "pointermove", 200, 40);
      act(() => vi.advanceTimersByTime(600));

      expect(onStart).not.toHaveBeenCalled();
      expect(onLongPress).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims the scroll while a drag is live", () => {
    vi.useFakeTimers();
    try {
      const { row } = setup({ onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn() });

      pointer(row, "pointerdown", 200, 20);
      act(() => vi.advanceTimersByTime(500));

      // `touch-action: pan-y` was fixed at gesture start, so the wrapper takes
      // the scroll back with a non-passive touchmove for the drag's duration.
      const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
      row.dispatchEvent(touchMove);
      expect(touchMove.defaultPrevented).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the drag when the release lands outside the row", () => {
    // Rows re-order in the DOM while the finger moves, and a browser drops
    // pointer capture when the capturing node moves. The lift must still end
    // — a drag that never hears its release leaves the row raised forever.
    vi.useFakeTimers();
    try {
      const onStart = vi.fn();
      const onMove = vi.fn();
      const onEnd = vi.fn();
      const { row } = setup({ onStart, onMove, onEnd });

      pointer(row, "pointerdown", 200, 20);
      act(() => vi.advanceTimersByTime(500));
      pointer(row, "pointermove", 200, 60);

      fireEvent(window, new MouseEvent("pointerup", { bubbles: true, cancelable: true }));

      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The reveal has to start with the finger.
 *
 * `open` is the parent's answer, so a strip mounted only when `open` is true
 * appears after release: the row slides over an empty slot and the chips pop
 * in. These tests hold the row mid-drag and read the DOM, then follow the
 * strip through the 180ms slide back.
 */
describe("SwipeReveal reveal continuity", () => {
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

  /** Width 100 puts half-way at 50px, so the drag numbers read directly. */
  function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
    const [open, setOpen] = useState(initialOpen);
    return (
      <SwipeReveal
        open={open}
        onOpenChange={setOpen}
        width={100}
        actions={<button type="button">Pin</button>}
      >
        <button type="button">Row</button>
      </SwipeReveal>
    );
  }

  // While the row covers the strip it is `aria-hidden` on purpose, so the
  // action chip is only reachable with `hidden: true`; when committed open,
  // the query without it must succeed. Both are part of the contract.
  function strip() {
    return screen.getByRole("button", { name: "Pin", hidden: true }).parentElement as HTMLElement;
  }

  it("mounts the actions as soon as the row moves, before release", () => {
    const { container } = render(<Harness />);
    expect(screen.queryByRole("button", { name: "Pin", hidden: true })).toBeNull();

    const row = screen.getByRole("button", { name: "Row" });
    pointer(row, "pointerdown", 200);
    pointer(row, "pointermove", 150);

    const actions = strip();
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.hasAttribute("inert")).toBe(true);
    expect(actions.style.pointerEvents).toBe("none");
    // Not in the accessibility tree before the open is committed.
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    // The cover followed the finger, so these chips are already uncovered.
    const cover = container.firstElementChild?.lastElementChild as HTMLElement;
    expect(cover.style.transform).toBe("translateX(-50px)");
  });

  it("makes the actions reachable only once the open is committed", () => {
    render(<Harness />);
    const row = screen.getByRole("button", { name: "Row" });
    pointer(row, "pointerdown", 200);
    pointer(row, "pointermove", 140);
    expect(strip().hasAttribute("inert")).toBe(true);

    pointer(row, "pointerup", 140);

    expect(strip().hasAttribute("inert")).toBe(false);
    expect(strip().getAttribute("aria-hidden")).toBeNull();
    expect(strip().style.pointerEvents).toBe("");
    expect(screen.getByRole("button", { name: "Pin" })).not.toBeNull();
  });

  it("keeps the strip through the slide back and drops it after 180ms", () => {
    vi.useFakeTimers();
    try {
      render(<Harness initialOpen />);
      expect(strip().hasAttribute("inert")).toBe(false);

      // Half-way is 50px; +60 from an open row is a committed close.
      const row = screen.getByRole("button", { name: "Row" });
      pointer(row, "pointerdown", 200);
      pointer(row, "pointermove", 260);
      pointer(row, "pointerup", 260);

      // Closed in the parent, still on screen while the cover slides over it.
      expect(strip().hasAttribute("inert")).toBe(true);
      act(() => vi.advanceTimersByTime(179));
      expect(screen.queryByRole("button", { name: "Pin", hidden: true })).not.toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByRole("button", { name: "Pin", hidden: true })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the strip when the parent closes the row", () => {
    vi.useFakeTimers();
    try {
      const actions = <button type="button">Pin</button>;
      const view = render(
        <SwipeReveal open onOpenChange={() => {}} width={100} actions={actions}>
          <button type="button">Row</button>
        </SwipeReveal>,
      );
      view.rerender(
        <SwipeReveal open={false} onOpenChange={() => {}} width={100} actions={actions}>
          <button type="button">Row</button>
        </SwipeReveal>,
      );

      expect(screen.queryByRole("button", { name: "Pin", hidden: true })).not.toBeNull();
      act(() => vi.advanceTimersByTime(180));
      expect(screen.queryByRole("button", { name: "Pin", hidden: true })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
