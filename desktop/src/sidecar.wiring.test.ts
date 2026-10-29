import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The wiring no unit can hold.
 *
 * `daemon-rival.test.ts` covers the waiting, but the sidecar is the only thing
 * that can ask the question — and it imports electron through `config.ts`, so
 * it cannot be loaded outside the shell. What matters here is order: ask before
 * spawning, and refuse instead of spawning when the answer is "stuck".
 */
// npm test runs from desktop/.
const SOURCE = readFileSync("src/sidecar.ts", "utf8");

describe("the sidecar starts at most one daemon", () => {
  it("waits for a kin process that is already on the machine", () => {
    assert.match(SOURCE, /waitForRivalDaemon\(\{/);
    assert.match(SOURCE, /listRivals:\s*listKinDaemonPids/);
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
});
