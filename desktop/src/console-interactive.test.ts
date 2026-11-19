import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createConsoleInteractiveRecorder } from "./console-interactive.ts";

/**
 * `console-interactive` is the moment the person stops looking at the boot
 * surface. The renderer knows when React committed; the shell owns the clock,
 * so the renderer only says "now" over IPC and this recorder decides whether
 * the message is the one the startup measurement should keep.
 *
 * Both inputs are injected — the trace writer and the URL rule — so the
 * once-per-launch rule and the document check are held without Electron.
 */

const CONSOLE = "http://127.0.0.1:7777/";
const BOOT = "file:///Applications/Kin.app/Contents/Resources/app.asar/dist/boot.html";

function setup() {
  const traces: string[] = [];
  const recorder = createConsoleInteractiveRecorder({
    trace: (name) => {
      traces.push(name);
    },
    isConsoleURL: (url) => url.startsWith("http://127.0.0.1:7777/"),
  });
  return { traces, recorder };
}

describe("the console-interactive mark", () => {
  it("stamps console-interactive for the console document only", () => {
    const { traces, recorder } = setup();

    assert.equal(recorder(CONSOLE), true);
    assert.deepEqual(traces, ["console-interactive"]);
  });

  it("stamps at most once per launch", () => {
    // A reload or an in-page route change loads the document again; the
    // startup runner requires every mark exactly once, so the second report
    // must be dropped rather than averaged into the run.
    const { traces, recorder } = setup();

    assert.equal(recorder(CONSOLE), true);
    assert.equal(recorder(`${CONSOLE}tasks/abc`), false);
    assert.deepEqual(traces, ["console-interactive"]);
  });

  it("ignores the boot page and about:blank", () => {
    // The boot page and the window's initial about:blank share the window and
    // its preload; neither is the console committing a screen.
    const { traces, recorder } = setup();

    assert.equal(recorder(BOOT), false);
    assert.equal(recorder("about:blank"), false);
    assert.deepEqual(traces, []);

    // A rejected document does not spend the one mark.
    assert.equal(recorder(CONSOLE), true);
    assert.deepEqual(traces, ["console-interactive"]);
  });
});
