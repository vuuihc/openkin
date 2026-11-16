import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retryWhileUnavailable } from "./daemon-retry.ts";

/** A clock that only moves when the code under test sleeps. */
function clock(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

describe("recovering a daemon that was not there at startup", () => {
  it("keeps asking, and stops as soon as one answers", async () => {
    const c = clock();
    let calls = 0;
    const outcome = await retryWhileUnavailable({
      sleep: c.sleep,
      intervalMs: 1_000,
      ensureRunning: async () => {
        calls += 1;
        return { state: calls >= 3 ? "external" : "unavailable" };
      },
    });

    assert.equal(outcome, "ready");
    assert.equal(calls, 3);
    assert.deepEqual(c.sleeps, [1_000, 1_000, 1_000]);
  });

  it("waits before the first attempt", async () => {
    const c = clock();
    const seen: string[] = [];
    await retryWhileUnavailable({
      sleep: async (ms) => {
        seen.push("slept");
        await c.sleep(ms);
      },
      attempts: 1,
      intervalMs: 500,
      ensureRunning: async () => {
        seen.push("asked");
        return { state: "unavailable" };
      },
    });

    assert.deepEqual(seen, ["slept", "asked"]);
  });

  it("gives up after the bound instead of probing forever", async () => {
    const c = clock();
    let calls = 0;
    const outcome = await retryWhileUnavailable({
      sleep: c.sleep,
      attempts: 4,
      intervalMs: 250,
      ensureRunning: async () => {
        calls += 1;
        return { state: "unavailable" };
      },
    });

    assert.equal(outcome, "gave-up");
    assert.equal(calls, 4);
    assert.deepEqual(c.sleeps, [250, 250, 250, 250]);
  });

  it("leaves a state something else resolved alone", async () => {
    const c = clock();
    let calls = 0;
    const outcome = await retryWhileUnavailable({
      sleep: c.sleep,
      resolved: () => true,
      ensureRunning: async () => {
        calls += 1;
        return { state: "unavailable" };
      },
    });

    assert.equal(outcome, "resolved");
    assert.equal(calls, 0);
  });

  it("treats a throwing attempt as one more attempt", async () => {
    const c = clock();
    let calls = 0;
    const outcome = await retryWhileUnavailable({
      sleep: c.sleep,
      attempts: 3,
      ensureRunning: async () => {
        calls += 1;
        if (calls < 3) throw new Error("probe failed");
        return { state: "spawned" };
      },
    });

    assert.equal(outcome, "ready");
    assert.equal(calls, 3);
  });
});
