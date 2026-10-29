import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { popoverNeedsLoad, popoverTokenIsStale } from "./popover-load.ts";

const TRAY = "http://127.0.0.1:7777/tray";

describe("loading the tray popover", () => {
  it("loads a window that has never shown the page", () => {
    assert.equal(popoverNeedsLoad("", TRAY), true);
    assert.equal(popoverNeedsLoad("about:blank", TRAY), true);
  });

  it("keeps the page it already has, token query and all", () => {
    assert.equal(popoverNeedsLoad(`${TRAY}?token=redacted`, TRAY), false);
    assert.equal(popoverNeedsLoad(TRAY, TRAY), false);
    assert.equal(popoverNeedsLoad(`${TRAY}#approvals`, TRAY), false);
  });

  it("reloads when the window is showing something else", () => {
    // A failed first load leaves Chromium's error page; something that
    // navigated the popover elsewhere leaves a route the promotion handler did
    // not catch.
    assert.equal(popoverNeedsLoad("http://127.0.0.1:7777/inbox", TRAY), true);
    assert.equal(popoverNeedsLoad("chrome-error://chromewebdata/", TRAY), true);
    assert.equal(popoverNeedsLoad(`${TRAY}extra`, TRAY), true);
  });
});

describe("the token the popover is holding", () => {
  it("is current when the URL carries the live token", () => {
    assert.equal(popoverTokenIsStale(`${TRAY}?token=abc`, "abc"), false);
  });

  it("is stale when the token file changed or the URL has none", () => {
    assert.equal(popoverTokenIsStale(`${TRAY}?token=old`, "new"), true);
    assert.equal(popoverTokenIsStale(TRAY, "new"), true);
    assert.equal(popoverTokenIsStale("not a url", "new"), true);
  });

  it("says nothing about a machine with no token to compare", () => {
    // Before the daemon has written ~/.kin/token there is nothing to be stale
    // against; the load path handles the missing token on its own.
    assert.equal(popoverTokenIsStale(`${TRAY}?token=anything`, null), false);
  });
});
