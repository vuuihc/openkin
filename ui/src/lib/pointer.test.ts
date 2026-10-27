import { afterEach, describe, expect, it, vi } from "vitest";
import { hasFinePointer } from "./pointer";

/**
 * The one decision behind the login screen's autofocus.
 *
 * It is a two-line function, which is exactly why it is worth pinning: the
 * failure it prevents (a phone landing on a focused field, and iOS zooming the
 * page before the keyboard has even settled) is invisible on a desktop, and a
 * stub that always answers "fine" turns the guard off without turning any
 * other test red.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasFinePointer", () => {
  it("reports what the media query reports", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(hasFinePointer()).toBe(false);

    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(hasFinePointer()).toBe(true);
  });

  it("asks about the pointer rather than the width", () => {
    // A narrow window on a desktop is still a mouse; a landscape phone is still
    // a finger. Width-based answers get one of those two wrong.
    const queries: string[] = [];
    vi.stubGlobal("window", {
      matchMedia: (query: string) => {
        queries.push(query);
        return { matches: true };
      },
    });
    hasFinePointer();
    expect(queries).toEqual(["(pointer: fine)"]);
  });

  it("treats an environment that cannot answer as precise", () => {
    // The cost of being wrong here is one focused field, so an unknown
    // environment keeps the desktop convenience.
    vi.stubGlobal("window", {});
    expect(hasFinePointer()).toBe(true);

    vi.stubGlobal("window", undefined);
    expect(hasFinePointer()).toBe(true);
  });
});
