import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  restoreWindow,
  restoreWindowBounds,
  restoreWindowState,
  savedBoundsFrom,
} from "./window-bounds.ts";

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

  it("clamps a size that JSON can make infinite", () => {
    // `{"width": 1e999}` is valid JSON and parses to Infinity, which
    // Math.round keeps; a finite check is what repairs it.
    assert.deepEqual(
      restoreWindowBounds(
        { width: Number.POSITIVE_INFINITY, height: 760 },
        [LAPTOP],
        LAPTOP,
      ),
      { x: 360, y: 83, width: 720, height: 760 },
    );
  });
});

describe("reading a bounds file", () => {
  it("keeps a rect with two usable sizes", () => {
    assert.deepEqual(savedBoundsFrom({ x: 120, y: 140, width: 1100, height: 760 }), {
      x: 120,
      y: 140,
      width: 1100,
      height: 760,
      maximized: false,
      fullScreen: false,
    });
  });

  it("drops a position it cannot use but keeps the size", () => {
    assert.deepEqual(
      savedBoundsFrom({ x: "left", y: null, width: 1100, height: 760 }),
      { x: undefined, y: undefined, width: 1100, height: 760, maximized: false, fullScreen: false },
    );
  });

  it("keeps a state only when the file says so plainly", () => {
    // The shell wrote these flags itself, so a value that is not a boolean is
    // a hand edit or a half-written file. Guessing at it would move the window
    // into a Space the person did not leave it in.
    assert.deepEqual(
      savedBoundsFrom({ width: 1100, height: 760, maximized: true, fullScreen: false }),
      { x: undefined, y: undefined, width: 1100, height: 760, maximized: true, fullScreen: false },
    );
    assert.deepEqual(
      savedBoundsFrom({ width: 1100, height: 760, maximized: "true", fullScreen: 1 }),
      { x: undefined, y: undefined, width: 1100, height: 760, maximized: false, fullScreen: false },
    );
  });

  it("is nothing at all without two usable sizes", () => {
    for (const value of [
      null,
      undefined,
      "text",
      42,
      [],
      {},
      { width: 1100 },
      { width: 1100, height: 0 },
      { width: -1, height: 760 },
      { width: "1100", height: "760" },
      // JSON.parse gives Infinity here.
      { width: 1e999, height: 760 },
    ]) {
      assert.equal(savedBoundsFrom(value), null, JSON.stringify(value));
    }
  });
});

describe("restoring the state the window was left in", () => {
  const NORMAL = { width: 1100, height: 760 };

  it("comes back full screen when that is how it was left", () => {
    assert.equal(restoreWindowState({ ...NORMAL, fullScreen: true }), "fullscreen");
  });

  it("comes back maximized when that is how it was left", () => {
    assert.equal(restoreWindowState({ ...NORMAL, maximized: true }), "maximized");
  });

  it("comes back normal for a file written before the flags existed", () => {
    assert.equal(restoreWindowState({ ...NORMAL }), "normal");
    assert.equal(restoreWindowState({ ...NORMAL, maximized: false, fullScreen: false }), "normal");
  });

  it("prefers full screen when a file claims both", () => {
    // A full-screen window reports maximized on some platforms; restoring it
    // merely maximized would drop it out of the Space it was left in.
    assert.equal(restoreWindowState({ ...NORMAL, maximized: true, fullScreen: true }), "fullscreen");
  });

  it("does not let the state move the rect", () => {
    // The rect beside the flags is the normal one, and it is restored the same
    // way whatever the state says — the clamp still decides where it lands.
    const saved = { x: 120, y: 140, width: 1100, height: 760, maximized: true };
    assert.deepEqual(restoreWindowBounds(saved, [LAPTOP], LAPTOP), {
      x: 120,
      y: 140,
      width: 1100,
      height: 760,
    });
  });
});

describe("restoring a saved file", () => {
  it("hands back the rect and the state from the same read", () => {
    const saved = { x: 120, y: 140, width: 1100, height: 760, maximized: true };
    assert.deepEqual(restoreWindow(saved, [LAPTOP], LAPTOP), {
      rect: { x: 120, y: 140, width: 1100, height: 760 },
      state: "maximized",
    });
  });

  it("keeps the state when the rect has to be rebuilt", () => {
    // The case that was silently broken: the display the window was saved on
    // is gone, so the rect is clamped to the primary one. The state has to
    // survive that, and it is the rect — not the file — that gets rebuilt.
    const saved = { x: 9000, y: 9000, width: 1100, height: 760, fullScreen: true };
    assert.deepEqual(restoreWindow(saved, [LAPTOP], LAPTOP), {
      rect: { x: 170, y: 83, width: 1100, height: 760 },
      state: "fullscreen",
    });
  });

  it("is normal for a file written before the flags existed", () => {
    assert.equal(restoreWindow({ width: 1100, height: 760 }, [LAPTOP], LAPTOP).state, "normal");
  });
});
