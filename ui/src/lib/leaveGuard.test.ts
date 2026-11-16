// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canLeaveScreen,
  isLeaveGuardArmed,
  resetLeaveGuard,
  runGuardedNavigation,
  scheduleLeaveGuardReconcile,
  setLeaveGuard,
} from "./leaveGuard";

/**
 * The system Back path, which no button test can see.
 *
 * A dirty page arms one same-URL history entry. Back pops that entry while the
 * URL stays put, so the page is still mounted and can be asked; refusing
 * re-arms it, allowing goes back once more for real. These tests drive jsdom's
 * real history stack rather than a MemoryRouter, because the entry is the
 * mechanism.
 */

function tick(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("condition never became true");
}

function stack(): void {
  // Two entries, with the idx React Router's browser history would stamp.
  window.history.replaceState({ idx: 0 }, "", "/base");
  window.history.pushState({ idx: 1 }, "", "/page");
}

beforeEach(() => {
  resetLeaveGuard();
  stack();
});

afterEach(() => {
  resetLeaveGuard();
  vi.restoreAllMocks();
});

describe("the leave guard's history entry", () => {
  it("arms one same-URL entry only while the page is dirty", async () => {
    const length = window.history.length;
    const unregister = setLeaveGuard(() => true, true);
    await tick();

    expect(window.history.state.kinLeaveGuard).toBeTruthy();
    expect(window.location.pathname).toBe("/page");
    expect(window.history.length).toBe(length + 1);
    expect(isLeaveGuardArmed()).toBe(true);

    unregister();
    await until(() => !window.history.state?.kinLeaveGuard);
    expect(window.location.pathname).toBe("/page");
  });

  it("asks before a system Back and keeps the page when refused", async () => {
    let allowed = false;
    const canLeave = vi.fn(() => allowed);
    setLeaveGuard(canLeave, true);
    await tick();
    const armed = window.history.state.kinLeaveGuard;

    window.history.back();
    await until(() => canLeave.mock.calls.length > 0);

    expect(window.location.pathname).toBe("/page");
    expect(window.history.state.kinLeaveGuard).toBeTruthy();
    expect(window.history.state.kinLeaveGuard).not.toBe(armed);

    // Once the page agrees, the next Back really leaves.
    allowed = true;
    window.history.back();
    await until(() => window.location.pathname === "/base");
  });

  it("does not ask when no page registered a guard", async () => {
    const canLeave = vi.fn(() => true);
    setLeaveGuard(canLeave, true);
    await tick();
    resetLeaveGuard();
    // The sentinel may still be on top; a Back now is a silent release.
    window.history.back();
    await until(() => window.location.pathname === "/page");
    expect(canLeave).not.toHaveBeenCalled();
  });
});

describe("a same-pathname move while the page is dirty", () => {
  it("re-arms when a same-address rewrite drops the entry's marker", async () => {
    // React Router's replace rewrites the entry's state without the marker
    // (a screen cleaning its query string, a setSearchParams tab). The page and
    // its draft are still mounted because the pathname did not change, so the
    // next Back must still ask — and keep asking on every Back.
    let allowed = false;
    const canLeave = vi.fn(() => allowed);
    setLeaveGuard(canLeave, true);
    await tick();
    expect(isLeaveGuardArmed()).toBe(true);

    window.history.replaceState(
      { idx: window.history.state.idx, key: "rewritten" },
      "",
      "/page?tab=b",
    );
    expect(window.location.search).toBe("?tab=b");
    expect(isLeaveGuardArmed()).toBe(false);

    scheduleLeaveGuardReconcile();
    await tick();
    expect(isLeaveGuardArmed()).toBe(true);

    window.history.back();
    await until(() => canLeave.mock.calls.length === 1);
    expect(window.location.pathname).toBe("/page");
    expect(window.location.search).toBe("?tab=b");
    expect(isLeaveGuardArmed()).toBe(true);

    window.history.back();
    await until(() => canLeave.mock.calls.length === 2);
    expect(window.location.search).toBe("?tab=b");
    expect(isLeaveGuardArmed()).toBe(true);

    allowed = true;
    window.history.back();
    // The agreed pop lands on the pre-rewrite /page entry: same pathname, so
    // the screen is still here and the next Back must ask again.
    await until(() => window.location.pathname === "/page" && window.location.search === "");
    await until(() => isLeaveGuardArmed());

    window.history.back();
    await until(() => window.location.pathname === "/base");
  });

  it("re-arms after a same-pathname push buries the page's entry", async () => {
    const canLeave = vi.fn(() => false);
    setLeaveGuard(canLeave, true);
    await tick();

    window.history.pushState(
      { idx: window.history.state.idx + 1, key: "pushed" },
      "",
      "/page?tab=c",
    );
    scheduleLeaveGuardReconcile();
    await tick();
    expect(window.location.search).toBe("?tab=c");
    expect(isLeaveGuardArmed()).toBe(true);

    window.history.back();
    await until(() => canLeave.mock.calls.length === 1);
    expect(window.location.pathname).toBe("/page");
    expect(window.location.search).toBe("?tab=c");
    expect(isLeaveGuardArmed()).toBe(true);

    window.history.back();
    await until(() => canLeave.mock.calls.length === 2);
    expect(window.location.search).toBe("?tab=c");
  });

  it("re-arms after a guarded navigation that stayed on this pathname", async () => {
    let allowed = true;
    const canLeave = vi.fn(() => allowed);
    setLeaveGuard(canLeave, true);
    await tick();
    expect(isLeaveGuardArmed()).toBe(true);

    // The page's own guarded departure (a tab switch, a query rewrite) runs
    // its action and stays on the same pathname: the screen is still mounted
    // with its draft, so the next Back must ask, not compare the whole URL.
    expect(
      runGuardedNavigation(() => {
        window.history.replaceState({ idx: window.history.state.idx }, "", "/page?tab=kept");
      }),
    ).toBe(true);
    await until(() => window.location.search === "?tab=kept");
    await until(() => isLeaveGuardArmed());

    allowed = false;
    window.history.back();
    await until(() => canLeave.mock.calls.length === 1);
    expect(window.location.pathname).toBe("/page");
    expect(window.location.search).toBe("?tab=kept");
    expect(isLeaveGuardArmed()).toBe(true);
  });

  it("re-arms when an allowed departure lands on another copy of this pathname", async () => {
    // The agreed Back pops into a same-pathname entry with a different query,
    // so the page never unmounted. Full-URL equality would call that "left"
    // and leave the draft unguarded from then on.
    window.history.replaceState({ idx: 0 }, "", "/base");
    window.history.pushState({ idx: 1 }, "", "/page?tab=a");
    window.history.pushState({ idx: 2 }, "", "/page");

    let allowed = true;
    const canLeave = vi.fn(() => allowed);
    setLeaveGuard(canLeave, true);
    await tick();
    expect(isLeaveGuardArmed()).toBe(true);

    // Sentinel -> current /page; allowed, so the same pop walks one entry
    // further onto /page?tab=a (same pathname). The page never unmounted.
    window.history.back();
    await until(() => canLeave.mock.calls.length === 1);
    await until(() => isLeaveGuardArmed());
    expect(window.location.pathname).toBe("/page");
    expect(window.location.search).toBe("?tab=a");

    // Refusing the next Back is only possible if that landing re-armed.
    allowed = false;
    window.history.back();
    await until(() => canLeave.mock.calls.length === 2);
    expect(window.location.pathname).toBe("/page");
    expect(window.location.search).toBe("?tab=a");
    expect(isLeaveGuardArmed()).toBe(true);

    allowed = true;
    window.history.back();
    await until(() => window.location.pathname === "/base");
  });
});

describe("guarded navigation", () => {
  it("refuses without running the action", () => {
    setLeaveGuard(() => false, true);
    const action = vi.fn();

    expect(runGuardedNavigation(action)).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(canLeaveScreen()).toBe(false);
  });

  it("releases the armed entry before navigating so Back is one step", async () => {
    let allowed = true;
    setLeaveGuard(() => allowed, true);
    await tick();
    expect(isLeaveGuardArmed()).toBe(true);

    const seen: unknown[] = [];
    runGuardedNavigation(() => seen.push(window.history.state?.kinLeaveGuard));
    await until(() => seen.length === 1);

    expect(seen[0]).toBeUndefined();
    expect(window.location.pathname).toBe("/page");
  });

  it("refuses a second departure while the first is still unwinding", async () => {
    // The first call has already asked history to pop the armed entry. A
    // second call must not run its action behind the first one's back, and
    // must not overwrite the action the pop is about to run.
    setLeaveGuard(() => true, true);
    await tick();
    expect(isLeaveGuardArmed()).toBe(true);

    const first = vi.fn();
    const second = vi.fn();
    expect(runGuardedNavigation(first)).toBe(true);
    expect(runGuardedNavigation(second)).toBe(false);

    await until(() => first.mock.calls.length === 1);
    await tick();
    expect(second).not.toHaveBeenCalled();

    // The departure is over: no stale action waits for a later Back.
    window.history.back();
    await tick();
    await tick();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("does not leave a finished departure for the next page's Back", async () => {
    let allowed = true;
    setLeaveGuard(() => allowed, true);
    await tick();

    const previous = vi.fn();
    runGuardedNavigation(previous);
    await until(() => previous.mock.calls.length === 1);

    // A new screen registers while the old one's entry may still be settling.
    const nextAsk = vi.fn(() => false);
    setLeaveGuard(nextAsk, true);
    await until(() => isLeaveGuardArmed());

    window.history.back();
    await until(() => nextAsk.mock.calls.length === 1);
    expect(previous).toHaveBeenCalledTimes(1);
  });
});
