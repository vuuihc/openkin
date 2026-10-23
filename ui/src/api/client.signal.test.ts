import { afterEach, describe, expect, it, vi } from "vitest";
import { getTaskPullRequest } from "./client";

/**
 * A read the caller walks away from has to stop travelling.
 *
 * The pull-request panel follows a query the daemon is running on a timer and
 * abandons a read as soon as a newer one starts, or when the panel closes. The
 * panel's own ceiling bounds the await either way; only the signal reaching
 * fetch ends the request — and the transport can be a relay to a machine
 * somewhere else, where a read nobody is waiting for still costs a round trip.
 */
function stubPendingFetch(): AbortSignal[] {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", (_url: string, init: RequestInit = {}) => {
    const signal = init.signal as AbortSignal | null | undefined;
    if (!signal) return new Promise(() => {});
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    });
  });
  return signals;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a read the caller can cancel", () => {
  it("hands the caller's signal to fetch, and the request rejects on abort", async () => {
    const signals = stubPendingFetch();
    const controller = new AbortController();

    const pending = getTaskPullRequest("01TASK", controller.signal);
    // The signal has to be the caller's own, not a copy: aborting a copy would
    // leave the request running while the caller believes it stopped.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBe(controller.signal);
    expect(signals[0].aborted).toBe(false);

    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(signals[0].aborted).toBe(true);
  });
});
