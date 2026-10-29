// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCloseOnWideScreen } from "./useCloseOnWideScreen";

/**
 * The viewport crossed the `md` breakpoint while a `md:hidden` overlay was
 * open. What is pinned: the overlay is closed, not merely hidden — its state
 * is what other surfaces key on.
 */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => media);
  return {
    listeners,
    setMatches(next: boolean) {
      media.matches = next;
      act(() => listeners.forEach((fn) => fn()));
    },
  };
}

describe("useCloseOnWideScreen", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("closes an overlay that is already wide when it opens", () => {
    stubMatchMedia(true);
    const close = vi.fn();
    renderHook(() => useCloseOnWideScreen(true, close));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes when the viewport becomes wide", () => {
    const media = stubMatchMedia(false);
    const close = vi.fn();
    renderHook(() => useCloseOnWideScreen(true, close));
    expect(close).not.toHaveBeenCalled();

    media.setMatches(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves a closed overlay alone", () => {
    const media = stubMatchMedia(false);
    const close = vi.fn();
    renderHook(() => useCloseOnWideScreen(false, close));
    media.setMatches(true);
    expect(close).not.toHaveBeenCalled();
    expect(media.listeners.size).toBe(0);
  });

  it("stops listening when it unmounts", () => {
    const media = stubMatchMedia(false);
    const { unmount } = renderHook(() => useCloseOnWideScreen(true, vi.fn()));
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });
});
