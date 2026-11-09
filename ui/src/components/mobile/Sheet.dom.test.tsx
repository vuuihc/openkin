// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import Sheet from "./Sheet";

/**
 * The sheet is `md:hidden`: past that width it is invisible but still mounted,
 * and its focus trap and Escape handler are attached to the window. Without a
 * breakpoint close, rotating a tablet (or widening a phone-sized window) leaves
 * a dialog eating keys for a page the user can now see. The console has no
 * other place to notice that, because CSS cannot unmount a component.
 *
 * jsdom has no `matchMedia`; the setup file deliberately does not stub one, so
 * this test brings the smallest one that can answer and be pushed.
 */

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    // A getter, not a copy: the component re-reads `matches` when the change
    // fires, which is how a real MediaQueryList behaves.
    get matches() {
      return matches;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: (fn: () => void) => listeners.add(fn),
    removeListener: (fn: () => void) => listeners.delete(fn),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      for (const fn of listeners) fn();
    },
  };
}

describe("Sheet breakpoint close", () => {
  it("asks to close when the viewport reaches the desktop breakpoint", () => {
    const media = stubMatchMedia(false);
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Model">
        body
      </Sheet>,
    );
    expect(screen.getByRole("dialog", { name: "Model" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    media.set(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on a change that is not the desktop breakpoint", () => {
    const media = stubMatchMedia(false);
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Model">
        body
      </Sheet>,
    );
    media.set(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * Pull-down dismissal.
 *
 * The grabber and title are the handle; the body joins only at the top of its
 * scroll. The threshold is the same shape as the drawer's, so a short pull
 * springs back and a committed one leaves. jsdom has no PointerEvent, so the
 * helpers dispatch MouseEvents with an explicit `pointerType`; the hook's
 * mouse guard must see a finger, not a cursor.
 */
describe("Sheet pull-down", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function pull(node: Element, from: number, to: number) {
    const event = (type: string, y: number) => {
      const next = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: y,
        button: 0,
      });
      Object.defineProperty(next, "pointerType", { value: "touch" });
      return next;
    };
    fireEvent(node, event("pointerdown", from));
    fireEvent(node, event("pointermove", to));
    fireEvent(node, event("pointerup", to));
  }

  it("closes when the title is pulled past the threshold", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Model">
        body
      </Sheet>,
    );

    pull(screen.getByRole("heading", { name: "Model" }), 40, 300);
    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("springs back after a short pull", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Model">
        body
      </Sheet>,
    );

    pull(screen.getByRole("heading", { name: "Model" }), 40, 90);
    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not pull a body that is scrolled away from its top", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Model">
        body
      </Sheet>,
    );
    const body = document.querySelector<HTMLElement>("[data-sheet-body]")!;
    body.scrollTop = 40;

    pull(screen.getByText("body"), 40, 300);
    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pulls from the body when it is already at the top", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Model">
        body
      </Sheet>,
    );
    const body = document.querySelector<HTMLElement>("[data-sheet-body]")!;
    body.scrollTop = 0;

    pull(screen.getByText("body"), 40, 300);
    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores a horizontal drag inside the body", () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Model">
        body
      </Sheet>,
    );
    const event = (type: string, x: number) =>
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 60,
        button: 0,
      });
    const body = screen.getByText("body");
    fireEvent(body, event("pointerdown", 250));
    fireEvent(body, event("pointermove", 100));
    fireEvent(body, event("pointerup", 100));

    expect(onClose).not.toHaveBeenCalled();
  });
});
