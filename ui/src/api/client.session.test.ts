import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthenticated } from "./client";
import { NO_ACCOUNT, useAppStore } from "../store/appStore";

/**
 * The console has two ways to be signed in and only one of them leaves
 * something in localStorage. A standalone daemon hands out a device token; a
 * Hub signs the browser in with an HttpOnly cookie. Pages that ask
 * `getToken()` end up blank on a Hub, so the shared predicate is what they use
 * instead, and these tests pin down which states it accepts.
 */

function stubToken(token: string | null): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "kin_token" ? token : null),
    setItem: () => {},
    removeItem: () => {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ account: NO_ACCOUNT });
});

describe("isAuthenticated", () => {
  it("is false with no token and no account", () => {
    expect(isAuthenticated()).toBe(false);
  });

  it("accepts a device token, which is how a standalone daemon signs in", () => {
    stubToken("kin_dev_token");
    expect(isAuthenticated()).toBe(true);
  });

  it("accepts a Hub cookie session that has no token at all", () => {
    useAppStore.setState({
      account: { ...NO_ACCOUNT, enabled: true, authenticated: true },
    });
    expect(isAuthenticated()).toBe(true);
  });

  it("still refuses a Hub that has an account system but nobody signed in", () => {
    useAppStore.setState({ account: { ...NO_ACCOUNT, enabled: true } });
    expect(isAuthenticated()).toBe(false);
  });
});
