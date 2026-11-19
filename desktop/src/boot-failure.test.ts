import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  failureCopy,
  failureLocale,
  reasonFrom,
  retryOutcomeEffect,
  type FailureReason,
} from "./boot-failure.ts";

/**
 * What the shell says when the daemon never arrives.
 *
 * The handshake's reason string is diagnostic text: it can name a binary path
 * or a port, so it is classified here into one of four sentences and never
 * rendered. Both languages are asserted because the launch surface is the one
 * screen a person cannot reach the settings page from.
 */

const REASONS: FailureReason[] = ["rival", "missing", "crash", "unknown"];

describe("a daemon that never arrives", () => {
  it("failure copy speaks both languages", () => {
    for (const reason of REASONS) {
      const zh = failureCopy("zh-Hans", reason);
      const en = failureCopy("en-US", reason);
      for (const copy of [zh, en]) {
        assert.ok(copy.state.trim().length > 0, `${reason} has no state line`);
        assert.ok(copy.action.trim().length > 0, `${reason} has no action line`);
        assert.doesNotMatch(copy.state, /%s|[{}]/, `${reason} state has a placeholder`);
        assert.doesNotMatch(copy.action, /%s|[{}]/, `${reason} action has a placeholder`);
      }
      assert.notEqual(zh.state, en.state, `${reason} says the same thing in both languages`);
      assert.notEqual(zh.action, en.action, `${reason} action is not translated`);
    }
  });

  it("failure copy falls back to zh-Hans for an unknown locale", () => {
    const zh = failureCopy("zh-Hans", "missing");
    for (const locale of ["de-DE", "", undefined]) {
      assert.deepEqual(failureCopy(locale, "missing"), zh, `locale ${String(locale)} did not fall back`);
    }
  });

  it("failure copy names the language it wrote", () => {
    // The page sets its `lang` from this, so English lines are not announced
    // with a Chinese voice (and vice versa).
    assert.equal(failureLocale("en-US"), "en");
    assert.equal(failureLocale("EN-gb"), "en");
    assert.equal(failureLocale("zh-Hans"), "zh-Hans");
    assert.equal(failureLocale("de-DE"), "zh-Hans");
    assert.equal(failureLocale(undefined), "zh-Hans");
  });

  it("each reason class gets its own sentence", () => {
    const states = REASONS.map((reason) => failureCopy("zh-Hans", reason).state);
    assert.equal(new Set(states).size, REASONS.length, "two reasons share a sentence");
  });

  it("reasonFrom classifies without leaking the raw text", () => {
    assert.equal(reasonFrom("another Kin daemon is listening on port 7777"), "rival");
    assert.equal(
      reasonFrom("a kin daemon process is running but not answering on :7777 — not starting a second one"),
      "rival",
    );
    assert.equal(reasonFrom("kin binary not found at /opt/kin/bin/kin"), "missing");
    assert.equal(reasonFrom("spawn failed: ENOENT /opt/kin/bin/kin"), "missing");
    assert.equal(reasonFrom("spawned daemon did not become healthy in time"), "crash");
    assert.equal(reasonFrom("connect ETIMEDOUT"), "crash");
    assert.equal(reasonFrom("stopped by user"), "unknown");
    assert.equal(reasonFrom(""), "unknown");
    assert.equal(reasonFrom(null), "unknown");
    assert.equal(reasonFrom(undefined), "unknown");

    // Whatever the text carries — a home directory, a port — only a class
    // comes back.
    for (const raw of [
      "kin binary not found at /Users/someone/.kin/node/kin",
      "daemon never answered on :7777",
      "spawn failed: EACCES /Users/someone/.kin/bin/kin",
    ]) {
      const reason = reasonFrom(raw);
      assert.ok(REASONS.includes(reason), `${raw} produced ${reason}`);
      assert.doesNotMatch(reason, /Users|\/|7777/);
    }
  });

  it("only a gave-up retry is a failure", () => {
    assert.equal(retryOutcomeEffect("ready"), "recovered");
    assert.equal(retryOutcomeEffect("resolved"), "none");
    assert.equal(retryOutcomeEffect("gave-up"), "failed");
  });
});
