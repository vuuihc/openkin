import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootProbe, PRE_RENDER_DEADLINE_MS, type BootProbeDeps } from "./bootProbe";
import type { AccountState } from "../store/appStore";

/**
 * The pre-render account probe has a deadline, and the console opens at it.
 *
 * These cases are the gate's three answers — signed in, signed out, no accounts
 * — crossed with the two ways they can arrive: before the first render, or
 * after it. The one thing that must never happen is a second render: the
 * desktop shell stamps `console-interactive` on the first commit, and a tree
 * mounted twice would report a console that did not restart.
 */

const HUB: AccountState = {
  enabled: true,
  authenticated: false,
  needsBootstrap: false,
  claimable: false,
  providers: [{ id: "password", label: "password", kind: "password" }],
  identities: [],
  linked: [],
};

/** A probe the test settles by hand, at the moment it chooses. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(over: Partial<BootProbeDeps> = {}) {
  const order: string[] = [];
  const render = vi.fn(() => {
    order.push("render");
  });
  const setAuthOk = vi.fn(() => {
    order.push("auth-ok");
  });
  const applyVisitGate = vi.fn(() => {
    order.push("gate");
  });
  const cleanVisitCredentials = vi.fn();
  const endUnanswered = vi.fn(() => {
    order.push("unanswered-end");
  });
  const clearAuthErrorFromURL = vi.fn();
  const deps: BootProbeDeps = {
    probe: new Promise<AccountState>(() => {}),
    render,
    setAuthOk,
    applyVisitGate,
    cleanVisitCredentials,
    endUnanswered,
    hasDeviceToken: () => false,
    clearAuthErrorFromURL,
    ...over,
  };
  return {
    deps,
    order,
    render,
    setAuthOk,
    applyVisitGate,
    cleanVisitCredentials,
    endUnanswered,
    clearAuthErrorFromURL,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bootProbe", () => {
  it("renders at the deadline when the account probe never answers", async () => {
    const h = harness();

    void bootProbe(h.deps);
    await vi.advanceTimersByTimeAsync(PRE_RENDER_DEADLINE_MS);

    expect(h.render).toHaveBeenCalledTimes(1);
    // The gate is open before the render: the console must not stand in front
    // of a gate that has no verdict behind it.
    expect(h.order).toEqual(["auth-ok", "render"]);
    expect(h.applyVisitGate).not.toHaveBeenCalled();
    expect(h.cleanVisitCredentials).not.toHaveBeenCalled();
    expect(h.clearAuthErrorFromURL).not.toHaveBeenCalled();
    // The verdict has not landed, so the hold is still in place.
    expect(h.endUnanswered).not.toHaveBeenCalled();
  });

  it("applies a late signed-out verdict after the deadline render", async () => {
    const probe = deferred<AccountState>();
    const h = harness({ probe: probe.promise });

    const run = bootProbe(h.deps);
    await vi.advanceTimersByTimeAsync(PRE_RENDER_DEADLINE_MS);
    expect(h.render).toHaveBeenCalledTimes(1);

    probe.resolve(HUB);
    await run;

    // The honest answer at the moment it is known: the visit gate, applied
    // once, on a console that is already on screen.
    expect(h.endUnanswered).toHaveBeenCalledTimes(1);
    expect(h.applyVisitGate).toHaveBeenCalledTimes(1);
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.setAuthOk).toHaveBeenCalledTimes(1); // the deadline's, not a second gate
  });

  it("decides before the first render when the probe answers in time", async () => {
    const probe = deferred<AccountState>();
    const h = harness({ probe: probe.promise });

    const run = bootProbe(h.deps);
    await vi.advanceTimersByTimeAsync(100);
    probe.resolve(HUB);
    await run;

    expect(h.order).toEqual(["unanswered-end", "gate", "render"]);
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.endUnanswered).toHaveBeenCalledTimes(1);

    // The deadline was cleared, not merely outrun: letting it fire would be a
    // second decision on a gate that already has one.
    await vi.advanceTimersByTimeAsync(PRE_RENDER_DEADLINE_MS * 2);
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.setAuthOk).not.toHaveBeenCalled();
  });

  it("keeps today's NO_ACCOUNT fallback when the probe errors before the deadline", async () => {
    const probe = deferred<AccountState>();
    const h = harness({ probe: probe.promise });

    const run = bootProbe(h.deps);
    probe.reject(new Error("unreachable"));
    await run;

    // An error is not a verdict either: the visit gate sees NO_ACCOUNT and
    // leaves the token screen's own answer to App, exactly as before.
    expect(h.order).toEqual(["unanswered-end", "gate", "render"]);
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.setAuthOk).not.toHaveBeenCalled();
    expect(h.clearAuthErrorFromURL).not.toHaveBeenCalled();
  });

  it("a late authenticated verdict does not close the gate or render twice", async () => {
    const probe = deferred<AccountState>();
    const h = harness({ probe: probe.promise });

    const run = bootProbe(h.deps);
    await vi.advanceTimersByTimeAsync(PRE_RENDER_DEADLINE_MS);
    expect(h.render).toHaveBeenCalledTimes(1);

    probe.resolve({ ...HUB, authenticated: true });
    await run;

    expect(h.render).toHaveBeenCalledTimes(1);
    // Nothing applies a gate for somebody who is signed in; the one-time
    // credentials are cleaned and the gate that is already open stays open.
    expect(h.applyVisitGate).not.toHaveBeenCalled();
    expect(h.cleanVisitCredentials).toHaveBeenCalledTimes(1);
    expect(h.setAuthOk).toHaveBeenCalledTimes(2); // deadline + verdict
  });

  it("a late signed-out verdict leaves a device token's gate open", async () => {
    const probe = deferred<AccountState>();
    const h = harness({ probe: probe.promise, hasDeviceToken: () => true });

    const run = bootProbe(h.deps);
    await vi.advanceTimersByTimeAsync(PRE_RENDER_DEADLINE_MS);
    // The token is known before the answer is; its credentials are cleaned at
    // the deadline rather than held behind a probe that may never answer.
    expect(h.cleanVisitCredentials).toHaveBeenCalledTimes(1);

    probe.resolve(HUB);
    await run;

    // A device token still works on a Hub, so the account screen is not this
    // visitor's answer.
    expect(h.applyVisitGate).not.toHaveBeenCalled();
    expect(h.render).toHaveBeenCalledTimes(1);
  });
});
