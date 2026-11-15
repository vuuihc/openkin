import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  kinDaemonPidsFromPS,
  kinDaemonUsesPort,
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

describe("which port a kin daemon would hold", () => {
  it("counts a daemon with no port flag as the default one", () => {
    assert.equal(kinDaemonUsesPort("/x/kin serve", 7777), true);
    assert.equal(
      kinDaemonUsesPort("/x/kin supervise --hub https://kin.example.com", 7777),
      true,
    );
    // And only the default: a flagless daemon is not on 7790.
    assert.equal(kinDaemonUsesPort("/x/kin serve", 7790), false);
  });

  it("reads the flag in both spellings Go accepts", () => {
    assert.equal(kinDaemonUsesPort("/x/kin serve --port 7777", 7777), true);
    assert.equal(kinDaemonUsesPort("/x/kin serve --port=7777", 7777), true);
    assert.equal(kinDaemonUsesPort("/x/kin serve -port 7777", 7777), true);
    assert.equal(kinDaemonUsesPort("/x/kin serve -port=7777", 7777), true);
  });

  it("separates a scratch daemon on another port", () => {
    assert.equal(kinDaemonUsesPort("/x/kin serve --port 7790", 7777), false);
    assert.equal(kinDaemonUsesPort("/x/kin serve --port=7788", 7777), false);
    assert.equal(
      kinDaemonUsesPort("/x/kin supervise --hub https://kin.example.com --port 7790", 7777),
      false,
    );
  });

  it("is not fooled by a word that only contains the flag's name", () => {
    // A URL or a path carrying "port" is not the flag.
    assert.equal(
      kinDaemonUsesPort("/x/kin serve --hub https://example.com/port/7777", 7777),
      true,
    );
    assert.equal(kinDaemonUsesPort("/x/kin serve --report 7790", 7777), true);
  });

  it("keeps a daemon whose port cannot be read, rather than spawning blind", () => {
    assert.equal(kinDaemonUsesPort("/x/kin serve --port", 7777), true);
    assert.equal(kinDaemonUsesPort("/x/kin serve --port nope", 7777), true);
  });

  it("filters the process list by port", () => {
    const ps = [
      "  301 /x/kin serve",
      "  302 /x/kin serve --port 7790",
      "  303 /x/kin supervise --port 7777",
    ].join("\n");

    assert.deepEqual(kinDaemonPidsFromPS(ps, 4242, 7777), [301, 303]);
    assert.deepEqual(kinDaemonPidsFromPS(ps, 4242, 7790), [302]);
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
