import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_PORT,
  STATE_DIR,
  TOKEN_PATH,
  resolveDaemonPort,
  resolveStateDir,
  resolveUserDataDir,
} from "./config.ts";

/**
 * The shell's two isolation knobs.
 *
 * `kin serve` already reads KIN_PORT and KIN_STATE_DIR (cmd/kin), but the
 * shell used to hardcode :7777 and ~/.kin in its own probes and in the daemon
 * it spawns. A measurement run needs both halves pointed at one throwaway
 * daemon; if the shell and the child disagree, the shell watches a port
 * nothing answers on. These resolvers are the one place that decides, so the
 * unset case is pinned to today's values.
 */

describe("the shell's daemon coordinates", () => {
  it("defaults are today's values when the environment is unset", () => {
    assert.equal(resolveDaemonPort({}), 7777);
    assert.equal(resolveStateDir({}, "/home/owner"), join("/home/owner", ".kin"));
    assert.equal(
      join(resolveStateDir({}, "/home/owner"), "token"),
      join("/home/owner", ".kin", "token"),
    );
    // The module-level exports derive from the process environment; with the
    // measurement variables unset they must reproduce the same values.
    assert.equal(DAEMON_PORT, resolveDaemonPort(process.env));
    assert.equal(STATE_DIR, resolveStateDir(process.env, homedir()));
    assert.equal(TOKEN_PATH, join(STATE_DIR, "token"));
  });

  it("honours KIN_PORT and KIN_STATE_DIR", () => {
    assert.equal(resolveDaemonPort({ KIN_PORT: "7801" }), 7801);
    assert.equal(
      resolveStateDir({ KIN_STATE_DIR: "/tmp/kin-isolated" }, "/home/owner"),
      "/tmp/kin-isolated",
    );
    assert.equal(resolveDaemonPort({ KIN_PORT: "1" }), 1);
    assert.equal(resolveDaemonPort({ KIN_PORT: "65535" }), 65535);
  });

  it("falls back to 7777 when KIN_PORT is not a port", () => {
    for (const raw of ["", "abc", "0", "65536", "-1", "80.5", " 7801"]) {
      assert.equal(resolveDaemonPort({ KIN_PORT: raw }), 7777, `KIN_PORT=${JSON.stringify(raw)}`);
    }
  });

  it("honours KIN_DESKTOP_USER_DATA and yields null when unset", () => {
    assert.equal(resolveUserDataDir({}), null);
    assert.equal(resolveUserDataDir({ KIN_DESKTOP_USER_DATA: "" }), null);
    assert.equal(
      resolveUserDataDir({ KIN_DESKTOP_USER_DATA: "/tmp/kin-desktop-profile" }),
      "/tmp/kin-desktop-profile",
    );
  });
});
