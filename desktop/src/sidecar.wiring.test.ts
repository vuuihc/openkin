import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * The wiring no unit can hold.
 *
 * `daemon-rival.test.ts` covers the waiting, but the sidecar is the only thing
 * that can ask the question — and it imports electron through `config.ts`, so
 * it cannot be loaded outside the shell. What matters here is order: ask before
 * spawning, and refuse instead of spawning when the answer is "stuck".
 */
// Read from desktop/ or from the repository root, so the suite does not
// depend on where it was started.
const SOURCE = readFileSync(
  existsSync("src/sidecar.ts") ? "src/sidecar.ts" : "desktop/src/sidecar.ts",
  "utf8",
);

describe("the sidecar starts at most one daemon", () => {
  it("waits for a kin process that is already on the machine", () => {
    assert.match(SOURCE, /waitForRivalDaemon\(\{/);
    assert.match(SOURCE, /listRivals:\s*\(\)\s*=>\s*listKinDaemonPids\(DAEMON_PORT\)/);
    assert.match(SOURCE, /if \(!healthy && !this\.child\)/);
  });

  it("asks before it spawns", () => {
    const asked = SOURCE.indexOf("waitForRivalDaemon({");
    const spawned = SOURCE.indexOf("spawn(bin,");
    assert.ok(asked > 0, "the rival question is never asked");
    assert.ok(spawned > asked, `spawn at ${spawned} is not after the wait at ${asked}`);
  });

  it("refuses to spawn onto a process that never answers", () => {
    const stuck = SOURCE.indexOf('outcome === "stuck"');
    const spawned = SOURCE.indexOf("spawn(bin,");
    assert.ok(stuck > 0, "a stuck daemon is not handled");
    assert.ok(stuck < spawned, `the stuck branch at ${stuck} is not before spawn at ${spawned}`);
    assert.match(SOURCE.slice(stuck, spawned), /return this\.status;/);
  });

  it("names a daemon that lost the state-directory race", () => {
    // Exit 75 is the daemon's refusal to share ~/.kin, not a crash (see
    // cmd/kin and internal/daemonlock). The reason reaches the tray and the
    // notification, where "daemon exited (code=75)" would read like a bug.
    assert.match(SOURCE, /const STATE_DIR_BUSY_EXIT = 75;/);
    const exit = SOURCE.indexOf('child.on("exit"');
    assert.ok(exit > 0, "the daemon exit is not handled");
    const branch = SOURCE.slice(exit, SOURCE.indexOf('child.on("error"', exit));
    assert.match(branch, /code === STATE_DIR_BUSY_EXIT/, "exit 75 is not distinguished");
    assert.match(branch, /another kin daemon already owns/, "the reason does not explain exit 75");
    // Retrying cannot change who owns the directory, so a refusal must not be
    // scheduled like a crash — the Go supervisor makes the same choice. `\s*`
    // so a formatter wrapping the call does not fail the guard.
    assert.match(
      branch,
      /if \(!this\.stopping && code !== STATE_DIR_BUSY_EXIT\)\s*this\.scheduleRestart\(\);/,
      "a busy state directory is restarted like a crash",
    );
  });
});
