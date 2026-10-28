// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
