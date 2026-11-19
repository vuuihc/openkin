import { afterEach, describe, expect, it, vi } from "vitest";
import { addPanel, panelOpenCount, removePanel, subscribePanels } from "./panelPresence";

/**
 * How many visible panels are open, as one value.
 *
 * The floating approval reads this to give up its decision card while a panel
 * owns the screen. It is a count rather than a boolean because two panels can
 * be open at once, and closing one must not hand the card back over the other.
 * The symmetry pinned here — every register paired with exactly one release —
 * is also what keeps React's dev-mode double-invoked effects from leaving the
 * count at 1 forever.
 */
afterEach(() => {
  // A test that leaks a registration would make the next one pass for the
  // wrong reason; the components remember to clean up, so the tests should too.
  while (panelOpenCount() > 0) removePanel();
});

describe("panelPresence", () => {
  it("registers and unregisters a visible panel", () => {
    const notify = vi.fn();
    const unsubscribe = subscribePanels(notify);
    try {
      expect(panelOpenCount()).toBe(0);

      addPanel();
      expect(panelOpenCount()).toBe(1);
      expect(notify).toHaveBeenCalledTimes(1);

      removePanel();
      expect(panelOpenCount()).toBe(0);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("keeps a count for overlapping panels", () => {
    addPanel();
    addPanel();
    expect(panelOpenCount()).toBe(2);

    // Closing one leaves the other open: the strip stays, the card stays away.
    removePanel();
    expect(panelOpenCount()).toBe(1);
  });
});
