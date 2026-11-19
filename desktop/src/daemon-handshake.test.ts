import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bringUpDaemon,
  HEALTH_POLL_MS,
  type HandshakeOptions,
} from "./daemon-handshake.ts";

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

/** A promise the test never settles — a hung version process or request. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const PID = 4242;

function options(overrides: Partial<HandshakeOptions> = {}): HandshakeOptions {
  const c = clock();
  return {
    probeHealth: async () => true,
    binaryVersion: async () => "1.2.3",
    probeVersion: async () => "1.2.3",
    ownsChild: () => true,
    waitForRival: async () => "none",
    stuckReason: "a kin process is there but not answering",
    spawn: () => ({ ok: true, pid: PID }),
    now: c.now,
    sleep: c.sleep,
    ...overrides,
  };
}

function assertState(
  outcome: { state: string },
  state: string,
): void {
  assert.equal(outcome.state, state);
}

describe("the startup handshake's order", () => {
  it("probes health before it runs the version binary", async () => {
    // The old order awaited `kin version` before the first probe, so the
    // version process is recorded before any health probe here. The version
    // itself answers at once: this test is about order, not about waiting.
    const order: string[] = [];
    let probes = 0;
    const outcome = await bringUpDaemon(
      options({
        probeHealth: async () => {
          order.push("health");
          probes += 1;
          return probes >= 2;
        },
        binaryVersion: async () => {
          order.push("version-binary");
          return "1.2.3";
        },
      }),
    );

    assertState(outcome, "spawned");
    assert.ok(
      order.indexOf("health") < order.indexOf("version-binary"),
      `health was not probed before the version binary: ${order.join(", ")}`,
    );
    assert.equal(
      order.filter((step) => step === "health").length,
      2,
      "the handshake did not keep polling after starting the version binary",
    );
  });

  it(
    "resolves when health answers even if the version binary never does",
    { timeout: 2_000 },
    async () => {
      const outcome = await bringUpDaemon(
        options({
          binaryVersion: () => never(),
          probeVersion: async () => "2.0.0",
        }),
      );

      assert.deepEqual(outcome, {
        state: "external",
        version: "2.0.0",
        expected: null,
      });
    },
  );

  it(
    "resolves when health answers even if the version request never does",
    { timeout: 2_000 },
    async () => {
      const outcome = await bringUpDaemon(
        options({
          probeVersion: () => never(),
        }),
      );

      // The label is unknown; the daemon answering is the result.
      assert.deepEqual(outcome, {
        state: "external",
        version: "unknown",
        expected: "1.2.3",
      });
    },
  );
});

describe("waiting for a spawned daemon", () => {
  it("polls at the fast cadence, not the old quarter-second one", async () => {
    let probes = 0;
    // No `pollMs` override: this holds the module's own default, so a
    // regression to the old 250 ms cadence is red here.
    const outcome = await bringUpDaemon(
      options({
        probeHealth: async () => {
          probes += 1;
          return false;
        },
        healthTimeoutMs: 300,
      }),
    );

    assertState(outcome, "unhealthy");
    // 300 ms at 50 ms is six polls inside the wait; the old 250 ms cadence
    // would issue two.
    assert.ok(
      probes >= 6,
      `${probes} health probes in 300 ms is slower than the ${HEALTH_POLL_MS} ms cadence`,
    );
  });

  it("starts the version request as soon as health answers", async () => {
    let probes = 0;
    let requests = 0;
    const outcome = await bringUpDaemon(
      options({
        probeHealth: async () => {
          probes += 1;
          return probes >= 2;
        },
        probeVersion: async () => {
          requests += 1;
          return "7.8.9";
        },
      }),
    );

    assert.deepEqual(outcome, { state: "spawned", version: "7.8.9", pid: PID });
    assert.equal(requests, 1, "the version request did not run exactly once");
  });

  it("falls back to the binary's version when the daemon reports none", async () => {
    let probes = 0;
    const outcome = await bringUpDaemon(
      options({
        probeHealth: async () => {
          probes += 1;
          return probes >= 2;
        },
        probeVersion: async () => null,
        binaryVersion: async () => "4.5.6",
      }),
    );

    assert.deepEqual(outcome, { state: "spawned", version: "4.5.6", pid: PID });
  });

  it("stops polling and reports superseded when the attempt is cancelled", async () => {
    let probes = 0;
    const outcome = await bringUpDaemon(
      options({
        probeHealth: async () => {
          probes += 1;
          return false;
        },
        isCurrent: () => probes < 3,
        healthTimeoutMs: 1_000,
      }),
    );

    assert.equal(outcome.state, "superseded");
    assert.equal(probes, 3, "the wait kept polling after the attempt was cancelled");
  });

  it("reports a failed spawn without starting a health wait", async () => {
    let probes = 0;
    const outcome = await bringUpDaemon(
      options({
        probeHealth: async () => {
          probes += 1;
          return false;
        },
        spawn: () => ({ ok: false, reason: "kin binary not found at /x/kin" }),
      }),
    );

    assert.deepEqual(outcome, {
      state: "unavailable",
      reason: "kin binary not found at /x/kin",
    });
    // One probe asked the question; no health wait follows a failed spawn.
    assert.equal(probes, 1);
  });
});

describe("the rival's safety rule still stands", () => {
  it("does not spawn while an unanswered kin process may be booting", async () => {
    let spawned = false;
    const outcome = await bringUpDaemon(
      options({
        probeHealth: async () => false,
        ownsChild: () => false,
        waitForRival: async () => "stuck",
        spawn: () => {
          spawned = true;
          return { ok: true, pid: PID };
        },
      }),
    );

    assert.deepEqual(outcome, {
      state: "unavailable",
      reason: "a kin process is there but not answering",
    });
    assert.equal(spawned, false, "a second daemon was spawned beside the rival");
  });

  it("attaches to a rival that starts answering", async () => {
    let spawned = false;
    const outcome = await bringUpDaemon(
      options({
        probeHealth: async () => false,
        ownsChild: () => false,
        waitForRival: async () => "healthy",
        probeVersion: async () => "3.0.0",
        binaryVersion: async () => "3.0.0",
        spawn: () => {
          spawned = true;
          return { ok: true, pid: PID };
        },
      }),
    );

    assert.deepEqual(outcome, {
      state: "external",
      version: "3.0.0",
      expected: "3.0.0",
    });
    assert.equal(spawned, false);
  });

  it("does not spawn when the attempt is cancelled during the rival wait", async () => {
    let spawned = false;
    let cancelled = false;
    const outcome = await bringUpDaemon(
      options({
        probeHealth: async () => false,
        ownsChild: () => false,
        waitForRival: async () => {
          cancelled = true;
          return "none";
        },
        spawn: () => {
          spawned = true;
          return { ok: true, pid: PID };
        },
        isCurrent: () => !cancelled,
      }),
    );

    assert.equal(outcome.state, "superseded");
    assert.equal(spawned, false, "a cancelled handshake spawned a daemon");
  });

  it("spawns without asking a rival when this shell owns a child", async () => {
    let asked = false;
    let probes = 0;
    const outcome = await bringUpDaemon(
      options({
        probeHealth: async () => {
          probes += 1;
          return probes >= 2;
        },
        ownsChild: () => true,
        waitForRival: async () => {
          asked = true;
          return "stuck";
        },
      }),
    );

    assertState(outcome, "spawned");
    assert.equal(asked, false, "a process this shell owns was treated as a rival");
  });
});
