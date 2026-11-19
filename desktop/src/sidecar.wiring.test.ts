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

function readSource(relative: string): string {
  return readFileSync(existsSync(relative) ? relative : `desktop/${relative}`, "utf8");
}

describe("the sidecar starts at most one daemon", () => {
  it("hands the handshake a kin process that is already on the machine", () => {
    // The order itself is held behaviourally in daemon-handshake.test.ts; the
    // wiring must give it the real process list and the child it owns.
    assert.match(SOURCE, /bringUpDaemon\(\{/);
    assert.match(SOURCE, /waitForRivalDaemon\(\{/);
    assert.match(SOURCE, /listRivals:\s*\(\)\s*=>\s*listKinDaemonPids\(DAEMON_PORT\)/);
    assert.match(SOURCE, /ownsChild:\s*\(\)\s*=>\s*this\.child !== null/);
    // A handshake that outlived Stop/quit must not spawn or overwrite status.
    assert.match(
      SOURCE,
      /isCurrent:\s*\(\)\s*=>\s*generation === this\.generation && !this\.stopping/,
    );
    // The cadence and timeout are the handshake's defaults, not overridden
    // here back to the old quarter-second poll.
    assert.doesNotMatch(SOURCE, /pollMs:|healthTimeoutMs:/);
  });

  it("asks before it spawns", () => {
    const asked = SOURCE.indexOf("waitForRivalDaemon({");
    const spawn = SOURCE.indexOf("spawn: () => this.spawnDaemon()");
    assert.ok(asked > 0, "the rival question is never asked");
    assert.ok(spawn > asked, `spawn at ${spawn} is not after the wait at ${asked}`);
    assert.match(SOURCE, /private spawnDaemon\(\): SpawnResult/);
    assert.ok(SOURCE.indexOf("spawn(bin,") > 0, "the spawn implementation is gone");
  });

  it("turns a stuck rival into an unavailable status without spawning", () => {
    // The refusal decision is the pure module's (tested there); the wiring
    // must name the reason and surface the outcome instead of ignoring it.
    assert.match(SOURCE, /stuckReason:\s*`a kin daemon process is running/);
    assert.match(SOURCE, /if \(outcome\.state === "unavailable"\)/);
    assert.match(
      SOURCE,
      /this\.status = \{ state: "unavailable", reason: outcome\.reason \}/,
    );
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

describe("the shell's daemon coordinates", () => {
  it("the shell never assumes :7777 or ~/.kin", () => {
    // `kin serve` already reads KIN_PORT and KIN_STATE_DIR. A measurement run
    // exports both, and the shell must probe the same port it hands the child;
    // otherwise it watches :7777 while the throwaway daemon serves elsewhere.
    // The default still lives in config.ts's resolver — that is the only place
    // allowed to know it.
    const config = readSource("src/config.ts");
    const sidecar = readSource("src/sidecar.ts");
    const api = readSource("src/daemon-api.ts");

    // The resolvers take an injected env (config.env.test.ts pins their
    // defaults), so the wiring assertion is that the module hands them the
    // real process environment and that both keys are read.
    assert.match(config, /KIN_PORT/, "config.ts does not read KIN_PORT");
    assert.match(config, /KIN_STATE_DIR/, "config.ts does not read KIN_STATE_DIR");
    assert.match(
      config,
      /DAEMON_PORT\s*=\s*resolveDaemonPort\(process\.env\)/,
      "DAEMON_PORT is not derived from the process environment",
    );
    assert.match(
      config,
      /STATE_DIR\s*=\s*resolveStateDir\(process\.env,\s*homedir\(\)\)/,
      "STATE_DIR is not derived from the process environment",
    );

    assert.doesNotMatch(
      sidecar,
      /no daemon on :7777/,
      "the spawn log still names the default port",
    );
    assert.match(
      sidecar,
      /KIN_PORT:\s*String\(DAEMON_PORT\)/,
      "the spawned daemon is not told the port the shell probes",
    );
    assert.match(
      sidecar,
      /KIN_STATE_DIR:\s*STATE_DIR/,
      "the spawned daemon is not told the state directory the shell reads",
    );

    // Comments included: a path here is how the hardcode comes back.
    for (const [name, source] of [
      ["config.ts", config],
      ["sidecar.ts", sidecar],
      ["daemon-api.ts", api],
    ] as const) {
      assert.ok(!source.includes("~/.kin"), `${name} hardcodes ~/.kin`);
    }
  });
});
