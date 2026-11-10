// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/*
 * Every sheet that closes on its own gives its history entry back. jsdom
 * queues a real traversal for `history.back()`, and its popstate can arrive
 * during the next test and close a sheet there. The mock keeps each test's
 * history deterministic; the tests that care about the traversal simulate
 * where it lands with `replaceState`.
 */
const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
beforeEach(() => {
  back.mockClear();
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

  it("gives one Escape to the sheet in front", () => {
    // A sheet can open another sheet — a run-settings choice chip, or any
    // SheetSelect inside a sheet. Both attach an Escape handler to the window;
    // without the stack guard one Escape closes both.
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    render(
      <>
        <Sheet open onClose={outerClose} title="Outer">
          outer
        </Sheet>
        <Sheet open onClose={innerClose} title="Inner">
          inner
        </Sheet>
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });

  it("stays open at every width when asked, for a coarse-pointer tablet", () => {
    const media = stubMatchMedia(false);
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Model" anyWidth>
        body
      </Sheet>,
    );
    // The width cap is the wide-screen shape; the phone's `md:hidden` would
    // make the layer invisible on the one device that asked for it.
    const root = document.querySelector("[data-kin-sheet]");
    expect(root?.className).not.toContain("md:hidden");
    media.set(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes when it stops opting out after the breakpoint already passed", () => {
    // A coarse pointer can disappear (a mouse is connected) while the sheet is
    // open and the window is already wide. The sheet becomes `md:hidden` at
    // that rerender; waiting for the next media event would leave an invisible
    // dialog eating keys.
    stubMatchMedia(true);
    const onClose = vi.fn();
    const { rerender } = render(
      <Sheet open onClose={onClose} title="Model" anyWidth>
        body
      </Sheet>,
    );
    expect(onClose).not.toHaveBeenCalled();
    rerender(
      <Sheet open onClose={onClose} title="Model">
        body
      </Sheet>,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not churn its history entry when the width policy changes", () => {
    // `anyWidth` is the sidebar's window into the sheet: a coarse tablet can
    // flip it while the sheet is open. The history entry, focus and keyboard
    // belong to the open/close effect; re-running that because a media query
    // changed would give the entry back and can close the sheet on the
    // traversal. The spy makes the failed hand-back visible.
    stubMatchMedia(false);
    const onClose = vi.fn();
    const { rerender } = render(
      <Sheet open onClose={onClose} title="Model">
        body
      </Sheet>,
    );
    rerender(
      <Sheet open onClose={onClose} title="Model" anyWidth>
        body
      </Sheet>,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });
});

describe("nested sheets", () => {
  it("gives one Back to the sheet in front", () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    render(
      <>
        <Sheet open onClose={outerClose} title="Outer">
          outer
        </Sheet>
        <Sheet open onClose={innerClose} title="Inner">
          inner
        </Sheet>
      </>,
    );
    act(() => {
      // A real Back pops the inner entry and lands on the outer entry, whose
      // state is not the inner sheet's marker. `{}` stands in for "an entry
      // below me"; the stack guard is what decides here.
      window.history.replaceState({}, "");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });

  it("keeps the sheet below when the inner one gives its entry back", () => {
    // Closing the inner sheet queues `history.back()`. That traversal lands on
    // the outer sheet's own history entry; the popstate the browser delivers
    // must not be read by the outer sheet as its own Back.
    function Nested() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setInnerOpen(true)}>
            open inner
          </button>
          <Sheet open={outerOpen} onClose={() => setOuterOpen(false)} title="Outer">
            outer
          </Sheet>
          <Sheet open={innerOpen} onClose={() => setInnerOpen(false)} title="Inner">
            <button type="button" onClick={() => setInnerOpen(false)}>
              close inner
            </button>
          </Sheet>
        </>
      );
    }
    render(<Nested />);
    const outerMarker = (window.history.state as { kinSheet?: string }).kinSheet;
    expect(outerMarker).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "open inner" }));
    expect(screen.getByRole("dialog", { name: "Inner" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "close inner" }));
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);

    act(() => {
      // The traversal the mock replaced: the browser moves back to the outer
      // entry and fires popstate with that entry's state.
      window.history.replaceState({ kinSheet: outerMarker }, "");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
  });

  it("lets only the sheet in front claim aria-modal", () => {
    render(
      <>
        <Sheet open onClose={() => undefined} title="Outer">
          outer
        </Sheet>
        <Sheet open onClose={() => undefined} title="Inner">
          inner
        </Sheet>
      </>,
    );
    expect(screen.getByRole("dialog", { name: "Outer" }).getAttribute("aria-modal")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Inner" }).getAttribute("aria-modal")).toBe("true");
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
