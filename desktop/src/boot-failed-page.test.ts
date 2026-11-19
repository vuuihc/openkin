import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * The page a person is left with when the daemon never arrives.
 *
 * It is a plain static file, so its guarantees are read from the text: it may
 * load nothing (the daemon is not up, and a failed page must not wait on
 * anything), it may write text but never markup (the query carries the shell's
 * own sentences, but the rule survives a careless future edit), and it may not
 * move — a terminal state must not animate progress it cannot make.
 */
const RAW = readFileSync(
  existsSync("boot-failed.html") ? "boot-failed.html" : "desktop/boot-failed.html",
  "utf8",
);

describe("the boot failure page", () => {
  it("failure page loads nothing", () => {
    for (const forbidden of ["http://", "https://", "<link", "<img", "<script src", "url("]) {
      assert.equal(RAW.includes(forbidden), false, `the page references ${forbidden}`);
    }
    assert.match(RAW, /default-src 'none'/, "the CSP does not deny every source by default");
  });

  it("failure page writes only textContent", () => {
    for (const forbidden of ["innerHTML", "insertAdjacentHTML", "document.write"]) {
      assert.equal(RAW.includes(forbidden), false, `the page writes markup with ${forbidden}`);
    }
    assert.match(RAW, /textContent/, "the page never writes its sentences at all");
    assert.match(
      RAW,
      /document\.documentElement\.lang/,
      "the page never declares the language it was handed",
    );
  });

  it("failure page has no motion", () => {
    assert.equal(RAW.includes("@keyframes"), false, "the terminal page has a keyframe animation");
    assert.equal(/\banimation\s*:/.test(RAW), false, "the terminal page animates");
  });

  it("failure page is never blank", () => {
    // The zh-Hans fallback is baked into the markup, so a missing query (or a
    // script that never runs) still shows a sentence and a next step.
    assert.ok(RAW.includes("Kin 守护进程没有启动。"), "the fallback state line is missing");
    assert.ok(
      RAW.includes("重启 Kin，或在菜单栏的 Kin 菜单里点 Start daemon。"),
      "the fallback action line is missing",
    );
  });
});
