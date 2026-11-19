import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBootWindow } from "./boot-window.ts";

/**
 * The window goes up before the daemon answers.
 *
 * `main.ts` used to await `sidecar.ensureRunning()` before showing anything, so
 * a launch showed no window for as long as the daemon took (median 1.5 s, and
 * no window at all when it never came up). The decision — boot surface first,
 * console in place when the daemon settles — lives in `boot-window.ts` so it
 * can be proven here, with a fictional host, without Electron.
 */

/** A host that records what the coordinator asked for, in order. */
function fakeHost() {
  const calls: string[] = [];
  let window = false;
  return {
    calls,
    host: {
      hasWindow: () => window,
      showBoot: (path: string) => {
        calls.push(`boot:${path}`);
        window = true;
      },
      showConsole: (path: string) => {
        calls.push(`console:${path}`);
        window = true;
      },
      showBootFailure: (reason: string) => {
        calls.push(`failure:${reason}`);
        window = true;
      },
      reveal: () => {
        calls.push("reveal");
      },
    },
  };
}

describe("the window opens before the daemon answers", () => {
  it("a foreground launch shows the boot surface before the daemon answers", () => {
    const { calls, host } = fakeHost();
    const boot = createBootWindow(host);

    boot.start();
    assert.deepEqual(calls, ["boot:/"], "the boot surface is up before the daemon settles");
    assert.equal(
      calls.filter((c) => c.startsWith("console:")).length,
      0,
      "the console must not load while the daemon is still starting",
    );

    boot.settle("ready");
    assert.deepEqual(calls, ["boot:/", "console:/"]);
  });

  it("a background launch stays in the tray with no window", () => {
    const { calls, host } = fakeHost();
    const boot = createBootWindow(host);

    boot.start({ background: true });
    boot.settle("ready");

    assert.deepEqual(calls, [], "a login-item launch must not put a window on screen");
  });

  it("the console replaces the boot surface once, at the deep-link path", () => {
    const linked = fakeHost();
    const withLink = createBootWindow(linked.host);
    withLink.start({ deepLinkPath: "/tasks/abc?tab=log" });
    withLink.settle("ready");
    withLink.settle("ready");

    assert.deepEqual(linked.calls, ["boot:/tasks/abc?tab=log", "console:/tasks/abc?tab=log"]);

    const plain = fakeHost();
    const withoutLink = createBootWindow(plain.host);
    withoutLink.start();
    withoutLink.settle("ready");
    withoutLink.settle("ready");

    assert.deepEqual(plain.calls, ["boot:/", "console:/"]);
  });

  it("an unavailable daemon keeps the boot surface, and recovery swaps it in place", () => {
    const { calls, host } = fakeHost();
    const boot = createBootWindow(host);

    boot.start();
    boot.settle("unavailable");
    assert.deepEqual(
      calls,
      ["boot:/"],
      "an unavailable daemon must not load a URL nothing answers",
    );

    // The recovery retry answers later; that is the same settle edge.
    boot.settle("ready");
    boot.settle("ready");
    assert.deepEqual(calls, ["boot:/", "console:/"]);
  });

  it("a tray open during boot does not create a second window", () => {
    const { calls, host } = fakeHost();
    const boot = createBootWindow(host);

    boot.start();
    boot.show("/");
    boot.show("/tasks/xyz");

    assert.equal(
      calls.filter((c) => c.startsWith("boot:")).length,
      1,
      "the boot surface is shown once, not once per tray click",
    );
    assert.equal(
      calls.filter((c) => c.startsWith("console:")).length,
      0,
      "a tray open must not load the console before the daemon is ready",
    );

    boot.settle("ready");
    assert.deepEqual(calls, ["boot:/", "reveal", "reveal", "console:/tasks/xyz"]);
  });

  it("a retry that gives up swaps the boot surface for the failure page once", () => {
    const { calls, host } = fakeHost();
    const boot = createBootWindow(host);

    boot.start();
    boot.settle("unavailable");
    boot.fail("crash");
    boot.fail("crash");

    assert.deepEqual(
      calls,
      ["boot:/", "failure:crash"],
      "the boot surface is replaced by one failure page, not one per attempt",
    );
    assert.equal(
      calls.filter((c) => c.startsWith("console:")).length,
      0,
      "a failure must not load a console that is not there",
    );
    assert.equal(boot.phase, "failed");
  });

  it("a failure never replaces a ready console", () => {
    const { calls, host } = fakeHost();
    const boot = createBootWindow(host);

    boot.start();
    boot.settle("ready");
    boot.fail("missing");

    assert.deepEqual(calls, ["boot:/", "console:/"]);
    assert.equal(boot.phase, "ready", "a late failure must not undo a working console");
  });

  it("a recovery after the failure swaps in the console exactly once", () => {
    const { calls, host } = fakeHost();
    const boot = createBootWindow(host);

    boot.start();
    boot.fail("rival");
    boot.settle("ready");
    boot.settle("ready");

    assert.deepEqual(calls, ["boot:/", "failure:rival", "console:/"]);
    assert.equal(boot.phase, "ready");
  });

  it("a background launch that failed stays in the tray until asked", () => {
    const { calls, host } = fakeHost();
    const boot = createBootWindow(host);

    boot.start({ background: true });
    boot.fail("missing");

    assert.deepEqual(calls, [], "a login-item launch must not put a failure page on screen");
    assert.equal(boot.phase, "failed");

    boot.show();
    assert.deepEqual(calls, ["failure:missing"], "the failure page, not the spinner");

    boot.show();
    assert.deepEqual(calls, ["failure:missing", "reveal"], "a shown failure page is only revealed");
  });
});
