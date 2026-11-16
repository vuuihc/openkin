import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * KIN-SETTINGS-002. The tray is Electron-bound and cannot load under
 * node:test, so the wiring is asserted on the source the same way
 * `sidecar.wiring.test.ts` does: the tray must render every UpdaterState
 * phase, must own no policy of its own (it only reads updaterState()), and
 * the shell must hand it the three actions the state machine exposes.
 */
const read = (rel: string) =>
  readFileSync(existsSync(rel) ? rel : `src/${rel}`, "utf8");
const TRAY = read("src/tray.ts");
const MAIN = read("src/main.ts");

describe("the tray renders the update block", () => {
  it("always shows the version line", () => {
    assert.match(TRAY, /label: `Kin \$\{versionLabel\}`/);
  });

  it("labels a dev build Kin dev, not Kin 0.0.0-dev (contract step 1)", () => {
    assert.match(TRAY, /version === "0\.0\.0-dev" \? "dev" : version/);
  });

  it("maps every UpdaterState phase to a menu item", () => {
    for (const phase of [
      "idle",
      "checking",
      "current",
      "available",
      "downloading",
      "downloaded",
      "error",
    ]) {
      assert.match(
        TRAY,
        new RegExp(`case "${phase}":`),
        `phase ${phase} has no menu item`,
      );
    }
  });

  it("shows progress as a percentage while downloading", () => {
    assert.match(TRAY, /Math\.round\(state\.fraction \* 100\)}/);
  });

  it("hides the percentage when the server declared no length", () => {
    assert.match(TRAY, /state\.hasTotal === false/);
    assert.match(TRAY, /"下载中…"/);
  });

  it("labels the error state with its message and offers a retry", () => {
    assert.match(TRAY, /更新检查失败：/);
    assert.match(TRAY, /重试检查…/);
  });

  it("binds every action item to a handler, not a no-op", () => {
    const actions = [
      "checkForUpdate()",
      "downloadUpdate()",
      "installDownloadedUpdate()",
    ];
    for (const a of actions) {
      assert.ok(
        TRAY.includes(`this.handlers.${a}`),
        `tray must call handlers.${a}`,
      );
    }
  });

  it("relabels a deferred install as 打开已下载的, per contract step 4", () => {
    assert.match(TRAY, /打开已下载的/);
    assert.match(TRAY, /state\.offered/);
  });

  it("offers to delete a downloaded dmg next to the install action", () => {
    assert.match(TRAY, /删除已下载的安装包/);
    assert.ok(
      TRAY.includes("this.handlers.clearDownloadedUpdate()"),
      "the delete item must be bound",
    );
  });

  it("owns no update policy: every decision comes from updaterState()", () => {
    // The switch must read the state, not the network or the filesystem.
    const cases = TRAY.indexOf("switch (state.phase)");
    assert.ok(cases > 0);
    const block = TRAY.slice(cases, TRAY.indexOf("return items", cases));
    assert.ok(!/fetch|http|api\.github/.test(block), "the tray must not fetch");
  });
});

describe("the shell wires the three updater actions", () => {
  it("injects app.getVersion as the build identity", () => {
    assert.match(MAIN, /appVersion: \(\) => app\.getVersion\(\)/);
  });

  it("wires check/download/install to the orchestrator", () => {
    assert.match(MAIN, /checkForUpdate: \(\) => \{\s*\n\s*void updater\.checkNow\(\);/);
    assert.match(MAIN, /downloadUpdate: \(\) => \{\s*\n\s*void updater\.download\(\);/);
    assert.match(MAIN, /installDownloadedUpdate: \(\) => \{\s*\n\s*void updater\.installDownloaded\(\);/);
  });

  it("re-renders the tray on every published state", () => {
    assert.match(MAIN, /setState: \(\) => tray\?\.refresh\(\)/);
  });

  it("clicking the notification acts on the current state, not a stale one", () => {
    assert.match(MAIN, /updater\.current\.phase === "downloaded"/);
    assert.match(MAIN, /updater\.current\.phase === "available"/);
  });

  it("downloads land in the OS temp dir under a tag-named dmg", () => {
    const UPDATER = read("src/updater.ts");
    assert.match(UPDATER, /tmpdir\(\)/);
    assert.match(UPDATER, /Kin-\$\{version\}-arm64\.dmg/);
    // Only github.com is ever an update source.
    assert.match(UPDATER, /https:\/\/api\.github\.com/);
    assert.ok(
      !/https?:\/\/(?!api\.github\.com|github\.com)[a-z]/.test(UPDATER),
      "the updater must talk only to github.com",
    );
  });

  it("gates the updater's notifications on isSupported (review N9)", () => {
    assert.match(MAIN, /notify: \(title, body\) => \{\s*\n\s*if \(!Notification\.isSupported\(\)\) return;/);
  });
});
