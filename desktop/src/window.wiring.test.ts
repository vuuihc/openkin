import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * The wiring no unit can hold.
 *
 * `window-bounds.test.ts` covers which rect and which state a saved file asks
 * for, but only `window.ts` can ask Electron. It imports electron, so it cannot
 * be loaded outside the shell — what is worth pinning here is *what* it saves,
 * *when*, and *where in the window's life* the restore runs.
 */
// Read from desktop/ or from the repository root, so the suite does not
// depend on where it was started.
const SOURCE = readFileSync(
  existsSync("src/window.ts") ? "src/window.ts" : "desktop/src/window.ts",
  "utf8",
);

/** The source between two anchors, so assertions are scoped, not global. */
function slice(from: string, to: string): string {
  const start = SOURCE.indexOf(from);
  const end = SOURCE.indexOf(to, start + 1);
  assert.ok(start >= 0, `missing anchor ${from}`);
  assert.ok(end > start, `missing anchor ${to} after ${from}`);
  return SOURCE.slice(start, end);
}

describe("the window remembers how it was left", () => {
  it("saves the normal rect, not the one on screen", () => {
    // `getBounds()` while maximized or full screen is the screen's rect;
    // saving it would lose the size the window goes back to.
    const persist = slice("private persistBounds", "private showDock");
    assert.match(persist, /getNormalBounds\(\)/);
    assert.doesNotMatch(persist, /getBounds\(\)/);
    assert.match(persist, /maximized:\s*this\.win\.isMaximized\(\)/);
    assert.match(persist, /fullScreen:\s*this\.win\.isFullScreen\(\)/);
  });

  it("stops saving once the app is quitting", () => {
    // Quitting from full screen makes macOS leave the Space; recording the
    // `leave-full-screen` that follows would bring the window back normal,
    // which is not how the person left it. The guard has to run before the
    // write, or it guards nothing.
    const persist = slice("private persistBounds", "private showDock");
    const guard = persist.indexOf("if (this.allowClose) return;");
    assert.ok(guard > 0, "persistBounds does not stop while quitting");
    assert.ok(guard < persist.indexOf("saveBounds({"), "the guard runs after the write");
  });

  it("takes the state from the file, not from the restored rect", () => {
    // `restoreWindowBounds` returns a bare rect and the flags are optional, so
    // reading the state back off that rect type-checks and always says
    // `normal`. That shape shipped once and the whole feature was dead; the
    // one helper is what keeps the two answers coming from the same read.
    assert.match(SOURCE, /restoreWindow\(/);
    assert.doesNotMatch(SOURCE, /restoreWindowState\(/);
  });

  it("records the transitions that do not resize the window", () => {
    // macOS full screen keeps the normal bounds and moves to another Space, so
    // no resize fires. A handler with an empty body would leave the string in
    // the file and forget the state all the same, hence the full call.
    for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
      assert.ok(
        SOURCE.includes(`this.win.on("${event}", () => this.persistBounds());`),
        `the ${event} transition is not recorded, so the next launch forgets it`,
      );
    }
  });

  it("restores the state inside ready-to-show, never before the first paint", () => {
    // `maximize()` shows a hidden window by itself, so doing it in `create()`
    // would put a blank dark window on screen before the renderer has anything
    // to draw. Both restores belong after the first paint; `show()` stays
    // between them because `maximize()` shows without focusing, and full
    // screen is ignored for a window that is not on screen yet.
    const restore = slice('once("ready-to-show"', "this.showDock();");
    // The condition is part of the assertion: an unconditional maximize would
    // look identical to a scan for `maximize()` alone.
    const maximize = restore.indexOf('if (state === "maximized") this.win?.maximize();');
    const show = restore.indexOf("this.win?.show()");
    const fullScreen = restore.indexOf('if (state === "fullscreen") this.win?.setFullScreen(true);');
    assert.ok(maximize > 0, "maximize is not inside ready-to-show");
    assert.ok(show > 0, "show is not inside ready-to-show");
    assert.ok(fullScreen > 0, "full screen is not inside ready-to-show");
    assert.ok(maximize < show, "maximize must run before show");
    assert.ok(fullScreen > show, "full screen must run after show");
    assert.equal(SOURCE.match(/\.maximize\(\)/g)?.length, 1, "maximize is called outside ready-to-show");
  });
});
