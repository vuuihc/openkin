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
const MAIN = readFileSync(
  existsSync("src/main.ts") ? "src/main.ts" : "desktop/src/main.ts",
  "utf8",
);

/** The source between two anchors, so assertions are scoped, not global. */
function slice(from: string, to: string): string {
  return sliceOf(SOURCE, from, to);
}

function sliceOf(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  assert.ok(start >= 0, `missing anchor ${from}`);
  assert.ok(end > start, `missing anchor ${to} after ${from}`);
  return source.slice(start, end);
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

/**
 * P10 item 2 — the window opens before the daemon answers.
 *
 * The coordinator's order is proven in `boot-window.test.ts`. What only the
 * wiring can hold is *where* those calls sit: the boot page's load must not be
 * mistaken for the console's first load (the startup measurement reads that
 * mark), and `main.ts` must show the window before it awaits the sidecar, with
 * the background branch deciding first.
 */
describe("the boot window opens before the daemon is awaited", () => {
  it("the boot page's load is not the console's window-first-load", () => {
    // `scripts/desktop-startup.sh` reads `window-first-load` as "the console's
    // first load" and requires it exactly once. The boot page is a file:// URL
    // and must not emit it, or every run would report two.
    const finished = sliceOf(SOURCE, 'on("did-finish-load"', 'on("did-navigate-in-page"');
    const guard = finished.indexOf("isConsoleURL(");
    const mark = finished.indexOf('traceStartup("window-first-load")');
    assert.ok(guard > 0, "the mark is not guarded by the console URL check");
    assert.ok(
      mark > guard,
      "the boot page's load would be counted as the console's first load",
    );
  });

  it("the window is shown before the sidecar is awaited", () => {
    // `await sidecar.ensureRunning()` is the gate that used to hold the window
    // back for the whole daemon start. In the same startup body, the boot show
    // must come first.
    const body = sliceOf(
      MAIN,
      'traceStartup("sidecar-start")',
      'traceStartup("sidecar-ready")',
    );
    const boot = body.indexOf("boot.start(");
    const awaited = body.indexOf("await sidecar.ensureRunning()");
    assert.ok(boot >= 0, "main.ts never starts the boot window");
    assert.ok(awaited > 0, "the sidecar is no longer awaited at startup");
    assert.ok(
      boot < awaited,
      "the boot window is shown only after the sidecar was awaited",
    );
  });

  it("a background launch never shows a boot window", () => {
    // A login-item launch idles in the menu bar. The branch has to decide
    // before the boot show, not after it put a window on screen.
    const body = sliceOf(
      MAIN,
      'traceStartup("sidecar-start")',
      'traceStartup("sidecar-ready")',
    );
    const background = body.indexOf("isBackgroundLaunch()");
    const boot = body.indexOf("boot.start(");
    assert.ok(background > 0, "the background-launch branch is gone");
    assert.ok(
      background < boot,
      "a background launch would show the boot window before checking",
    );
  });
});
