import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  popoverNeedsLoad,
  sameRoute,
  type PopoverLoadState,
} from "./popover-load.ts";

const TRAY = "http://127.0.0.1:7777/tray";

function state(overrides: Partial<PopoverLoadState>): PopoverLoadState {
  return {
    currentURL: TRAY,
    loaded: true,
    loadedToken: "abc",
    token: "abc",
    ...overrides,
  };
}

describe("loading the tray popover", () => {
  it("loads a window that has never finished loading the page", () => {
    assert.equal(popoverNeedsLoad(TRAY, state({ currentURL: "", loaded: false })), true);
    assert.equal(
      popoverNeedsLoad(TRAY, state({ currentURL: "about:blank", loaded: false })),
      true,
    );
  });

  it("keeps a live page it loaded, whose URL no longer carries the token", () => {
    // The console captures ?token= at boot and strips it from the address bar,
    // so this is what getURL() reports for a page that is perfectly current.
    assert.equal(popoverNeedsLoad(TRAY, state({ currentURL: TRAY })), false);
    assert.equal(
      popoverNeedsLoad(TRAY, state({ currentURL: `${TRAY}/` })),
      false,
    );
  });

  it("reloads a page that never arrived, even though its URL looks right", () => {
    // A failed load leaves the URL it aimed at; only the load record can say
    // the page on screen is Chromium's error page.
    assert.equal(
      popoverNeedsLoad(
        TRAY,
        state({ currentURL: `${TRAY}?token=abc`, loaded: false }),
      ),
      true,
    );
  });

  it("reloads when the page holds a token the daemon has replaced", () => {
    assert.equal(
      popoverNeedsLoad(TRAY, state({ loadedToken: "old", token: "new" })),
      true,
    );
    assert.equal(
      popoverNeedsLoad(TRAY, state({ loadedToken: null, token: "new" })),
      true,
    );
  });

  it("says nothing about a machine with no token to compare", () => {
    assert.equal(
      popoverNeedsLoad(TRAY, state({ loadedToken: null, token: null })),
      false,
    );
  });

  it("reloads when the window is showing another page", () => {
    assert.equal(
      popoverNeedsLoad(TRAY, state({ currentURL: "http://127.0.0.1:7777/inbox" })),
      true,
    );
    assert.equal(
      popoverNeedsLoad(
        TRAY,
        state({ currentURL: "chrome-error://chromewebdata/" }),
      ),
      true,
    );
    assert.equal(popoverNeedsLoad(TRAY, state({ currentURL: `${TRAY}s` })), true);
    // `/tray/anything` is a different route too: it renders the full console in
    // a 360×480 window.
    assert.equal(
      popoverNeedsLoad(TRAY, state({ currentURL: `${TRAY}/settings` })),
      true,
    );
  });
});

describe("comparing the popover's route", () => {
  it("ignores the query, the hash and one trailing slash", () => {
    assert.equal(sameRoute(`${TRAY}?token=abc#x`, TRAY), true);
    assert.equal(sameRoute(`${TRAY}/`, TRAY), true);
    assert.equal(sameRoute(TRAY, `${TRAY}/`), true);
  });

  it("separates routes that only share a prefix", () => {
    assert.equal(sameRoute(`${TRAY}s`, TRAY), false);
    assert.equal(sameRoute(`${TRAY}-x`, TRAY), false);
    assert.equal(sameRoute(`${TRAY}/a`, TRAY), false);
  });

  it("separates origins", () => {
    assert.equal(sameRoute("http://127.0.0.1:7778/tray", TRAY), false);
  });

  it("treats an unreadable URL as somewhere else", () => {
    assert.equal(sameRoute("", TRAY), false);
    assert.equal(sameRoute("not a url", TRAY), false);
  });
});
