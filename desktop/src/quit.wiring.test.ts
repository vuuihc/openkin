import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * How the shell goes away.
 *
 * The lifecycle events are Electron's, so this cannot be exercised under
 * `node --test`; what is worth pinning is the shape — one handler, one cleanup,
 * one quit, nothing cancelled. The shell used to prevent `will-quit` and call
 * `app.quit()` from inside the handler, and Electron ignored that second
 * request while the first was unwinding: Cmd-Q closed the window and left the
 * process running until it was killed.
 *
 * Comments are stripped before anything is asserted: a commented-out call is
 * not a call, and matching raw source is how the first version of this file
 * stayed green on exactly the bug it was written to catch.
 */
const RAW = readFileSync(
  existsSync("src/main.ts") ? "src/main.ts" : "desktop/src/main.ts",
  "utf8",
);
// Full-line comments only: a `/*` inside a string must not start a comment
// that swallows the rest of the file.
const SOURCE = RAW.replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, "").replace(/^\s*\/\/.*$/gm, "");

/** Every `app.on/once/addListener("event"` registration, whatever the spelling. */
function registrations(event: string): RegExpMatchArray[] {
  return [
    ...SOURCE.matchAll(
      new RegExp(`app\\.(?:on|once|addListener)\\s*\\(\\s*["']${event}["']`, "g"),
    ),
  ];
}

/** The handler body of the one registration of `event`, braces balanced. */
function handlerBody(event: string): string {
  const [match] = registrations(event);
  assert.ok(match, `no ${event} handler`);
  const open = SOURCE.indexOf("{", (match.index ?? 0) + match[0].length);
  assert.ok(open > (match.index ?? 0), `${event} handler has no body`);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === "{") depth += 1;
    else if (SOURCE[i] === "}" && (depth -= 1) === 0) {
      return SOURCE.slice(open, i + 1);
    }
  }
  assert.fail(`unbalanced ${event} handler`);
}

/** A call that is the whole statement on its line, not a branch or a comment. */
function hasStatement(body: string, call: string): boolean {
  return new RegExp(`^\\s*${call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(body);
}

describe("quitting the shell", () => {
  it("registers one quit handler and never cancels a quit", () => {
    // Any second handler, any spelling (`once`, single quotes), any
    // `preventDefault` turns a quit into the zombie this change removed.
    assert.equal(registrations("will-quit").length, 0, "will-quit is handled again");
    assert.equal(registrations("before-quit").length, 1, "expected exactly one before-quit handler");
    const handler = handlerBody("before-quit");
    assert.doesNotMatch(handler, /preventDefault/);
    // Exactly one statement, so a dead branch cannot sit beside the call. New
    // work belongs in beginQuit, where the other quit paths get it too.
    const lines = handler
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && line !== "{" && line !== "}");
    assert.deepEqual(lines, ["beginQuit();"], "before-quit runs more than the cleanup");
  });

  it("does the same work whichever way the quit was asked for", () => {
    const begin = SOURCE.slice(
      SOURCE.indexOf("function beginQuit"),
      SOURCE.indexOf("function quitApp"),
    );
    // The guard has to come before the latch it checks: swapped, the first call
    // sets `quitting` and returns, `prepareQuit` never runs, the close handler
    // hides the window instead, and the quit is cancelled — the original bug.
    const guard = begin.indexOf("if (quitting) return;");
    assert.ok(guard > 0, "beginQuit does not guard against re-entry");
    assert.ok(
      guard < begin.indexOf("quitting = true;"),
      "the re-entry guard runs after the latch it reads",
    );
    for (const call of [
      "mainWindow.prepareQuit();",
      "ws?.disconnect();",
      "sidecar.detach();",
      "popover?.destroy();",
      "tray?.destroy();",
    ]) {
      assert.ok(hasStatement(begin, call), `beginQuit does not run ${call}`);
      assert.ok(guard < begin.indexOf(call), `${call} runs before the re-entry guard`);
    }
  });

  it("asks the app to quit exactly once, after the cleanup", () => {
    // The nested-quit shape needs a second `app.quit()` anywhere; one in the
    // whole file is the invariant, not one inside `quitApp`.
    assert.equal(SOURCE.match(/app\.quit\(\)/g)?.length, 1, "app.quit() is called more than once");
    const quit = SOURCE.slice(
      SOURCE.indexOf("function quitApp"),
      SOURCE.indexOf('console.log("[kin-desktop] main process starting"'),
    );
    const begin = quit.indexOf("beginQuit()");
    const exit = quit.indexOf("app.quit()");
    assert.ok(begin > 0, "quitApp does not clean up");
    assert.ok(exit > begin, "quitApp quits before it cleans up");
  });

  it("sends the tray's Quit through the same path", () => {
    // The tray used to call the cleanup directly; both paths now share it.
    const start = SOURCE.indexOf("quit: () => {");
    const trayQuit = SOURCE.slice(start, SOURCE.indexOf("},", start));
    assert.ok(hasStatement(trayQuit, "quitApp();"), "the tray does not use quitApp");
  });
});
