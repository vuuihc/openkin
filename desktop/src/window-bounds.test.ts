import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restoreWindowBounds } from "./window-bounds.ts";

const LAPTOP = { x: 0, y: 25, width: 1440, height: 875 };
const EXTERNAL = { x: 1440, y: 0, width: 2560, height: 1415 };

describe("restoring the main window's bounds", () => {
  it("keeps a window that is still on a screen, exactly where it was", () => {
    const saved = { x: 120, y: 140, width: 1100, height: 760 };

    assert.deepEqual(restoreWindowBounds(saved, [LAPTOP], LAPTOP), saved);
  });

  it("keeps a window on a second display", () => {
    // Negative and beyond-the-primary coordinates are ordinary on a multi-
    // display desk; the test is whether a display covers them, not whether
    // they are positive.
    const saved = { x: 1600, y: 80, width: 900, height: 700 };

    assert.deepEqual(
      restoreWindowBounds(saved, [LAPTOP, EXTERNAL], LAPTOP),
      saved,
    );
  });

  it("brings back a window whose display was unplugged", () => {
    // The saved point names the external display that is no longer there.
    const outcome = restoreWindowBounds(
      { x: 2400, y: 200, width: 1200, height: 800 },
      [LAPTOP],
      LAPTOP,
    );

    assert.deepEqual(outcome, { x: 120, y: 63, width: 1200, height: 800 });
  });

  it("does not leave a window hanging off the edge of the screen", () => {
    // Only a corner overlaps: not enough to grab the title bar.
    const outcome = restoreWindowBounds(
      { x: 1400, y: 860, width: 1200, height: 800 },
      [LAPTOP],
      LAPTOP,
    );

    assert.deepEqual(outcome, { x: 120, y: 63, width: 1200, height: 800 });
  });

  it("brings back a window whose title bar is above the screen", () => {
    // The body still overlaps the display, but the part you drag is gone.
    const outcome = restoreWindowBounds(
      { x: 100, y: -760, width: 1200, height: 800 },
      [LAPTOP],
      LAPTOP,
    );

    assert.deepEqual(outcome, { x: 120, y: 63, width: 1200, height: 800 });
  });

  it("leaves a title bar that only dips under the menu bar alone", () => {
    // 25 of the 40 points are clear of the menu bar: still draggable, and
    // nudging it would undo a deliberate placement.
    const saved = { x: 100, y: 10, width: 1200, height: 800 };

    assert.deepEqual(restoreWindowBounds(saved, [LAPTOP], LAPTOP), saved);
  });

  it("shrinks a window that is larger than the screen it comes back to", () => {
    const outcome = restoreWindowBounds(
      { x: 2400, y: 200, width: 2500, height: 1400 },
      [LAPTOP],
      LAPTOP,
    );

    assert.deepEqual(outcome, { x: 0, y: 25, width: 1440, height: 875 });
  });

  it("centres the first launch, and repairs unusable numbers", () => {
    assert.deepEqual(
      restoreWindowBounds({ width: 1100, height: 760 }, [LAPTOP], LAPTOP),
      { x: 170, y: 83, width: 1100, height: 760 },
    );
    assert.deepEqual(
      restoreWindowBounds({ width: 0, height: 0 }, [LAPTOP], LAPTOP),
      { x: 360, y: 223, width: 720, height: 480 },
    );
    assert.deepEqual(
      restoreWindowBounds(
        { x: Number.NaN, y: 10, width: 1100, height: 760 },
        [LAPTOP],
        LAPTOP,
      ),
      { x: 170, y: 83, width: 1100, height: 760 },
    );
  });
});
