import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptRelayURL } from "./client";

/**
 * A Relay URL is how the console learns the room and key it reaches the daemon
 * through. The Worker also hands the browser those same credentials as a cookie,
 * because a query string does not survive a reload, a PWA launch or the URL a
 * module loader builds for a lazily imported chunk.
 *
 * That makes the cookie a second copy, and a second copy is a second thing to
 * forget. Clearing the stored credentials while leaving the cookie behind would
 * mean "disconnect" leaves a browser that can still reach the relay — the one
 * outcome a disconnect must not have.
 */

function stubBrowser(): { cookies: string[] } {
  const cookies: string[] = [];
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  vi.stubGlobal("document", {
    set cookie(value: string) {
      cookies.push(value);
    },
    get cookie() {
      return "";
    },
  });
  vi.stubGlobal("window", { location: { href: "https://relay.example.test/" } });
  return { cookies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adoptRelayURL", () => {
  it("expires the relay cookie when the relay URL is cleared", () => {
    const { cookies } = stubBrowser();
    adoptRelayURL("");
    expect(cookies).toHaveLength(1);
    // An empty value with Max-Age=0 is what actually removes it; the path has to
    // match the one the Worker set it with or the deletion lands elsewhere.
    expect(cookies[0]).toMatch(/^kin_relay=;/);
    expect(cookies[0]).toMatch(/Max-Age=0/);
    expect(cookies[0]).toMatch(/Path=\//);
  });

  it("leaves the cookie alone when a relay URL is adopted", () => {
    const { cookies } = stubBrowser();
    adoptRelayURL("https://relay.example.test/?room=r&key=k&token=t");
    expect(cookies).toEqual([]);
  });
});
