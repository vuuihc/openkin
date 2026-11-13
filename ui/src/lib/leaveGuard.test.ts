// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canLeaveScreen,
  isLeaveGuardArmed,
  resetLeaveGuard,
  runGuardedNavigation,
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
});
