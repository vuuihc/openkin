import { describe, expect, it } from "@jest/globals";
import {
  FOLLOW_BAND_PT,
  initialFollow,
  onContentGrew,
  onScroll,
} from "./follow";

/**
 * KIN-MOBILE-001 R4c — the phone's follow-the-stream policy, pure.
 *
 * The story's rule is one sentence: the stream may move the page only while
 * the reader is at the live edge. These cases pin the three transitions that
 * sentence implies — grow while pinned, drag out of the band, come back — and
 * the band itself, so a later refactor cannot quietly widen or drop it.
 */

const VIEWPORT = 800;

/** A scroll event at `offset`, in content `contentHeight` tall. */
function at(offset: number, contentHeight = 2400) {
  return { offset, contentHeight, viewportHeight: VIEWPORT };
}

describe("KIN-MOBILE-001 R4 follow policy", () => {
  it("KIN-MOBILE-001 R4: growth while pinned keeps following the end", () => {
    const state = initialFollow();
    expect(state.pinned).toBe(true);

    // At the end: content 2400, viewport 800, offset 1600.
    const atEnd = onScroll(state, at(1600));
    expect(atEnd.pinned).toBe(true);

    expect(onContentGrew(atEnd)).toEqual({ pinned: true, scrollToEnd: true });
  });

  it("KIN-MOBILE-001 R4: a drag beyond the 48pt band unpins, and growth never scrolls", () => {
    expect(FOLLOW_BAND_PT).toBe(48);
    const pinned = onScroll(initialFollow(), at(1600));

    // One point outside the band: 1600 - 48 - 1.
    const outside = onScroll(pinned, at(1551));
    expect(outside.pinned).toBe(false);
    expect(onContentGrew(outside)).toEqual({ pinned: false, scrollToEnd: false });

    // A drag far up is the same decision, not a different one.
    const farUp = onScroll(outside, at(0));
    expect(onContentGrew(farUp)).toEqual({ pinned: false, scrollToEnd: false });
  });

  it("KIN-MOBILE-001 R4: scrolling back into the band re-pins", () => {
    const unpinned = onScroll(initialFollow(), at(400));
    expect(unpinned.pinned).toBe(false);

    // Exactly on the band's edge still counts as reading the end.
    const edge = onScroll(unpinned, at(1600 - FOLLOW_BAND_PT));
    expect(edge.pinned).toBe(true);
    expect(onContentGrew(edge).scrollToEnd).toBe(true);
  });

  it("KIN-MOBILE-001 R4: content shorter than the viewport counts as the end", () => {
    const short = onScroll(initialFollow(), {
      offset: 0,
      contentHeight: 300,
      viewportHeight: VIEWPORT,
    });
    expect(short.pinned).toBe(true);
    expect(onContentGrew(short).scrollToEnd).toBe(true);
  });
});
