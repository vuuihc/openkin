import { describe, expect, it } from "vitest";
import { isImeKeyEvent } from "./ime";

/**
 * The two signals behind every keyboard guard in the console.
 *
 * The 229 case is the one worth pinning: it is invisible on a desktop with an
 * IME that sets `isComposing` in time, and dropping it looks like removing a
 * legacy branch. It is not — some IMEs and older Safari report the composing
 * keydown before the flag flips, and the handlers this predicate feeds would
 * then submit a half-typed Chinese word.
 */

describe("isImeKeyEvent", () => {
  it("trusts isComposing", () => {
    expect(isImeKeyEvent({ isComposing: true })).toBe(true);
  });

  it("treats the 229 sentinel as composing even when isComposing is false", () => {
    // The stale-flag case: the composing keydown arrives before the flag flips.
    expect(isImeKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("leaves ordinary keys alone", () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  it("survives a missing event", () => {
    expect(isImeKeyEvent(null)).toBe(false);
    expect(isImeKeyEvent(undefined)).toBe(false);
  });
});
