import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  kinDaemonPidsFromPS,
  waitForRivalDaemon,
  type RivalOptions,
} from "./daemon-rival.ts";

describe("recognising a kin daemon process", () => {
  const SELF = 4242;

  it("finds a supervisor and a server, wherever the binary lives", () => {
    const ps = [
      "  101 /Users/owner/.kin/node/kin supervise --hub https://kin.example.com",
      "  102 /Users/owner/.kin/node/kin serve --hub https://kin.example.com",
      "  103 /Users/owner/project/kin supervise",
      "  104 ./kin serve",
      "  105 ok supervise",
      "  106 /usr/local/bin/ok serve --lan",
    ].join("\n");

    assert.deepEqual(kinDaemonPidsFromPS(ps, SELF), [101, 102, 103, 104, 105, 106]);
  });

  it("ignores one-shot commands, other binaries and itself", () => {
    const ps = [
      "  201 /Users/owner/project/kin version",
      "  202 /Users/owner/project/kin task list",
      "  203 /Applications/Kin.app/Contents/MacOS/Kin",
      "  204 rg kin serve",
      // The daemon started from a shell wrapper is not recognised on purpose;
      // see the comment on the matcher.
      "  205 /bin/zsh -c cd /ws && kin serve",
      `  ${SELF} /Users/owner/project/kin supervise`,
      "  206 node /Users/owner/project/kin/server.js",
    ].join("\n");

    assert.deepEqual(kinDaemonPidsFromPS(ps, SELF), []);
  });
});

/** A clock that only moves when the code under test sleeps. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 1_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function options(overrides: Partial<RivalOptions>): RivalOptions {
  const c = clock();
  return {
    listRivals: async () => [],
    probeHealth: async () => false,
    now: c.now,
    sleep: c.sleep,
    ...overrides,
  };
}

describe("waiting for a daemon that is already there", () => {
  it("spawns at once on a machine with no daemon process", async () => {
    let probed = false;
    const outcome = await waitForRivalDaemon(
      options({
        probeHealth: async () => {
          probed = true;
          return false;
        },
      }),
    );

    assert.equal(outcome, "none");
    assert.equal(probed, false);
  });

  it("attaches once the restarting daemon answers", async () => {
    let probes = 0;
    const outcome = await waitForRivalDaemon(
      options({
        listRivals: async () => [101],
        probeHealth: async () => {
          probes += 1;
          return probes >= 3;
        },
      }),
    );

    assert.equal(outcome, "healthy");
    assert.equal(probes, 3);
  });

  it("spawns if the process it was waiting for exits first", async () => {
    let alive = true;
    const outcome = await waitForRivalDaemon(
      options({
        listRivals: async () => (alive ? [101] : []),
        probeHealth: async () => {
          alive = false;
          return false;
        },
      }),
    );

    assert.equal(outcome, "none");
  });

  it("refuses to add a second daemon to a process that never answers", async () => {
    let polls = 0;
    const outcome = await waitForRivalDaemon(
      options({
        listRivals: async () => {
          polls += 1;
          return [101];
        },
        probeHealth: async () => false,
        timeoutMs: 5_000,
        intervalMs: 500,
      }),
    );

    assert.equal(outcome, "stuck");
    // 0s, 0.5s … 5s: the deadline is reached, not slept past.
    assert.equal(polls, 12);
  });

  it("treats an unreadable process list as nothing to wait for", async () => {
    const outcome = await waitForRivalDaemon(
      options({
        listRivals: async () => {
          throw new Error("ps: not found");
        },
      }),
    );

    assert.equal(outcome, "none");
  });
});
