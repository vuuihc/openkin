import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkExchange,
  linkVisitPlan,
  LINK_EXCHANGE_DEADLINE_MS,
  type LinkExchangeDeps,
} from "./linkExchange";
import { loginVisit } from "./loginLink";
import type { AuthErrorCode } from "./accountGate";
import type { AccountState } from "../store/appStore";

/**
 * The one-time-link exchange has a deadline, and the console opens at it.
 *
 * The order #431 left behind stays: the link is spent before the account probe,
 * so the probe already sees the session. What is new is the other path -- a
 * POST that is accepted and never answered. The console opens at the deadline
 * with an honest message, and a success that lands afterwards is adopted by
 * asking the account once more. The one invariant every case keeps: `boot`
 * (and so `render`) runs exactly once. A second render would report a console
 * that restarted.
 */

const TOKEN = "ab".repeat(32);

const SIGNED_IN: AccountState = {
  enabled: true,
  authenticated: true,
  needsBootstrap: false,
  claimable: false,
  providers: [{ id: "password", label: "password", kind: "password" }],
  identities: [],
  linked: [],
};

/** An exchange the test settles by hand, at the moment it chooses. */
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

function harness(
  over: {
    exchange?: (token: string) => Promise<void>;
    reprobe?: () => Promise<AccountState>;
  } = {},
) {
  let session = false;
  const order: string[] = [];
  const render = vi.fn(() => {
    order.push("render");
  });
  const exchange = vi.fn((token: string) => {
    order.push("exchange");
    const work = over.exchange ? over.exchange(token) : Promise.resolve();
    // The Hub sets its session cookie as part of a successful exchange; the
    // next probe is the first thing that can see it.
    return work.then(() => {
      session = true;
    });
  });
  const boot = vi.fn(async () => {
    order.push(session ? "boot:signed-in" : "boot:signed-out");
    render();
  });
  const onFailed = vi.fn((code: AuthErrorCode, message = "") => {
    order.push(message ? `failed:${code}:${message}` : `failed:${code}`);
  });
  const reprobe = vi.fn(async () => {
    order.push("reprobe");
    return over.reprobe ? await over.reprobe() : SIGNED_IN;
  });
  const setAuthOk = vi.fn(() => {
    order.push("auth-ok");
  });
  const cleanVisitCredentials = vi.fn(() => {
    order.push("clean");
  });
  const clearAuthErrorFromURL = vi.fn(() => {
    order.push("clear-error");
  });
  const deps: LinkExchangeDeps = {
    token: TOKEN,
    exchange,
    boot,
    onFailed,
    reprobe,
    setAuthOk,
    cleanVisitCredentials,
    clearAuthErrorFromURL,
  };
  return {
    deps,
    order,
    exchange,
    boot,
    render,
    onFailed,
    reprobe,
    setAuthOk,
    cleanVisitCredentials,
    clearAuthErrorFromURL,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("linkExchange", () => {
  it("renders at the deadline when the exchange never answers", async () => {
    const h = harness({ exchange: () => new Promise<void>(() => {}) });

    void linkExchange(h.deps);
    await vi.advanceTimersByTimeAsync(LINK_EXCHANGE_DEADLINE_MS - 1);
    // Nothing is decided early: the exchange is still the one holding the boot.
    expect(h.onFailed).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    // The person is told the link did not finish, and the console opens. The
    // message is not "invalid or expired": the link may still be working.
    expect(h.onFailed).toHaveBeenCalledTimes(1);
    expect(h.onFailed).toHaveBeenCalledWith("login_link_timeout");
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["exchange", "failed:login_link_timeout", "boot:signed-out", "render"]);
  });

  it("waits for an exchange that answers in time", async () => {
    const exchange = deferred<undefined>();
    const h = harness({ exchange: () => exchange.promise });

    const run = linkExchange(h.deps);
    await vi.advanceTimersByTimeAsync(20);
    // The probe has not been asked yet: the link is spent first, so the probe
    // sees the session the exchange created.
    expect(h.boot).not.toHaveBeenCalled();

    exchange.resolve(undefined);
    // Flush the microtask queue without running the deadline: an answer that
    // is already in must not wait for it.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.order).toEqual(["exchange", "boot:signed-in", "render"]);
    await run;

    // The deadline was cleared, not merely outrun: letting it fire would report
    // a timeout for an exchange that already succeeded.
    await vi.advanceTimersByTimeAsync(LINK_EXCHANGE_DEADLINE_MS * 2);
    expect(h.onFailed).not.toHaveBeenCalled();
    expect(h.render).toHaveBeenCalledTimes(1);
  });

  it("a rejected exchange keeps its own code, not a timeout", async () => {
    const failure = Object.assign(new Error("this link is gone"), {
      code: "login_link_invalid",
    });
    const h = harness({ exchange: () => Promise.reject(failure) });

    const run = linkExchange(h.deps);
    await vi.advanceTimersByTimeAsync(20);
    // The answer is in well before the deadline; the console does not wait for
    // it to report a code the Hub already sent.
    expect(h.onFailed).toHaveBeenCalledWith("login_link_invalid", "this link is gone");
    await run;

    // The person followed a dead link; saying "did not finish" would invite
    // them to retry something the Hub already refused.
    expect(h.onFailed).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual([
      "exchange",
      "failed:login_link_invalid:this link is gone",
      "boot:signed-out",
      "render",
    ]);
    expect(h.render).toHaveBeenCalledTimes(1);

    // The deadline is gone with the answer; a second message would overwrite
    // the Hub's own code with a timeout.
    await vi.advanceTimersByTimeAsync(LINK_EXCHANGE_DEADLINE_MS * 2);
    expect(h.onFailed).toHaveBeenCalledTimes(1);
    expect(h.render).toHaveBeenCalledTimes(1);
  });

  it("a late success after the deadline opens the gate without a second render", async () => {
    const exchange = deferred<undefined>();
    const h = harness({ exchange: () => exchange.promise });

    const run = linkExchange(h.deps);
    await vi.advanceTimersByTimeAsync(LINK_EXCHANGE_DEADLINE_MS);
    expect(h.render).toHaveBeenCalledTimes(1);
    // The answer is not in yet, so there is nothing to re-probe for.
    expect(h.reprobe).not.toHaveBeenCalled();

    exchange.resolve(undefined);
    await run;

    // The session is real but the first probe answered without it. Asking once
    // more is what turns a timeout message into a signed-in console.
    expect(h.reprobe).toHaveBeenCalledTimes(1);
    expect(h.setAuthOk).toHaveBeenCalledTimes(1);
    expect(h.cleanVisitCredentials).toHaveBeenCalledTimes(1);
    expect(h.clearAuthErrorFromURL).toHaveBeenCalledTimes(1);
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual([
      "exchange",
      "failed:login_link_timeout",
      "boot:signed-out",
      "render",
      "reprobe",
      "clean",
      "clear-error",
      "auth-ok",
    ]);
  });

  it("a late failure after the deadline changes nothing", async () => {
    const exchange = deferred<undefined>();
    const h = harness({ exchange: () => exchange.promise });

    const run = linkExchange(h.deps);
    await vi.advanceTimersByTimeAsync(LINK_EXCHANGE_DEADLINE_MS);
    exchange.reject(Object.assign(new Error("gone"), { code: "login_link_invalid" }));
    await run;

    // The timeout message already on screen is the honest account of what
    // happened; the late rejection must not replace it or touch the gate.
    expect(h.onFailed).toHaveBeenCalledTimes(1);
    expect(h.onFailed).toHaveBeenCalledWith("login_link_timeout");
    expect(h.reprobe).not.toHaveBeenCalled();
    expect(h.setAuthOk).not.toHaveBeenCalled();
    expect(h.cleanVisitCredentials).not.toHaveBeenCalled();
    expect(h.clearAuthErrorFromURL).not.toHaveBeenCalled();
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["exchange", "failed:login_link_timeout", "boot:signed-out", "render"]);
  });

  it("a malformed link never starts an exchange", () => {
    // A truncated link is still a link somebody followed, but posting it would
    // spend a rate-limit attempt and come back "expired" -- a dead-link message
    // for a link that was merely mangled. The plan is the only dispatcher.
    const visit = loginVisit("#login=truncated");
    expect(visit).toEqual({ token: "", malformed: true });
    expect(linkVisitPlan(visit)).toEqual({ kind: "malformed" });
    expect(linkVisitPlan(null)).toEqual({ kind: "none" });
    expect(linkVisitPlan({ token: TOKEN, malformed: false })).toEqual({
      kind: "exchange",
      token: TOKEN,
    });
  });
});
